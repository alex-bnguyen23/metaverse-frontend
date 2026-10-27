import * as THREE from "three";
import { Notification } from "../utils/notifications";
import { FramePicturesApi, type FrameId, type FramePicture } from "../network/framePictures";

type Frame = {
  mesh: THREE.Mesh;
  buttonAnchor: THREE.Vector3;
  material: THREE.MeshStandardMaterial;
  original: THREE.MeshStandardMaterial;
  button: HTMLButtonElement;
  input: HTMLInputElement;
  id: FrameId;
  revision: number;
  pendingRevision: number;
  loading?: AbortController;
  texture?: THREE.Texture;
  video?: HTMLVideoElement;
};

/** Shared artwork with independent materials and no image data on the multiplayer socket. */
export class FramePictures {
  private frames: Frame[] = [];
  private disposed = false;
  private position = new THREE.Vector3();
  private projected = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private notification = new Notification();
  private root: THREE.Object3D;
  private api?: FramePicturesApi;
  private requests = new Set<AbortController>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private refreshPending = false;
  private onVisibility = () => {
    clearTimeout(this.pollTimer);
    for (const frame of this.frames) {
      if (document.hidden) frame.video?.pause();
      else if (frame.video)
        void frame.video
          .play()
          .catch((error: unknown) => console.warn("Frame video playback paused.", error));
    }
    if (!document.hidden) void this.refresh();
  };

  private async request<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeout = 30000,
  ): Promise<T> {
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  constructor(root: THREE.Object3D, container: HTMLElement) {
    this.root = root;
    try {
      this.api = new FramePicturesApi(import.meta.env.VITE_API_URL || "http://localhost:3000");
    } catch (error) {
      this.notification.show(error instanceof Error ? error.message : "Invalid API URL.", "error");
    }
    for (const side of ["left", "right"] as const) {
      let mesh: THREE.Mesh | undefined;
      root.traverse((object) => {
        if (object.userData.name !== `Jinja picture stand • ${side}`) return;
        object.traverse((child) => {
          if (child instanceof THREE.Mesh && child.userData.name === "Picture • 1920x1080")
            mesh = child;
        });
      });
      if (!mesh || !(mesh.material instanceof THREE.MeshStandardMaterial)) continue;
      // Both picture meshes originally share a material. Clone before replacing either map.
      const original = mesh.material;
      const material = original.clone();
      mesh.material = material;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Upload image / video";
      button.setAttribute("aria-label", `Upload or replace ${side} frame image or video`);
      button.title = "Shared with all visitors. Choose another image or video to replace it.";
      button.className =
        "absolute z-10 rounded bg-slate-900/90 px-3 py-2 text-sm text-white disabled:opacity-60";
      button.style.transform = "translate(-50%, calc(-100% - 8px))";
      button.hidden = true;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp,video/mp4,video/webm";
      input.hidden = true;
      // Anchor above the wooden frame, keeping the artwork itself unobstructed.
      const frameBounds = new THREE.Box3().setFromObject(mesh.parent ?? mesh);
      const buttonAnchor = frameBounds.getCenter(new THREE.Vector3());
      buttonAnchor.y = frameBounds.max.y;
      mesh.worldToLocal(buttonAnchor);
      const frame: Frame = {
        mesh,
        buttonAnchor,
        material,
        original,
        button,
        input,
        id: side,
        revision: 0,
        pendingRevision: 0,
      };
      button.onclick = () => input.click();
      input.onchange = () => {
        const file = input.files?.[0];
        input.value = "";
        if (file) void this.upload(frame, file);
      };
      container.append(button, input);
      this.frames.push(frame);
      button.disabled = !this.api;
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    if (this.api) void this.refresh();
  }

  private releaseVideo(video?: HTMLVideoElement) {
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  private apply(frame: Frame, source: HTMLImageElement | HTMLVideoElement) {
    const texture =
      source instanceof HTMLVideoElement
        ? new THREE.VideoTexture(source)
        : new THREE.Texture(source);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.needsUpdate = true;
    frame.texture?.dispose();
    this.releaseVideo(frame.video);
    frame.video = source instanceof HTMLVideoElement ? source : undefined;
    frame.texture = texture;
    frame.material.map = texture;
    frame.material.needsUpdate = true;
    frame.button.textContent = "Change image / video";
  }

  /** Revisions guard HTTP ordering and asynchronous texture decoding independently. */
  private async load(frame: Frame, picture: FramePicture) {
    if (
      !this.api ||
      picture.revision <= frame.revision ||
      picture.revision <= frame.pendingRevision ||
      !picture.imageUrl
    )
      return;
    frame.loading?.abort();
    frame.pendingRevision = picture.revision;
    const controller = new AbortController();
    frame.loading = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    let url: string | undefined;
    let video: HTMLVideoElement | undefined;
    try {
      if (picture.mediaType === "video") {
        // Stream versioned video directly, allowing the browser to use HTTP range requests.
        video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = "auto";
        const currentVideo = video;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            currentVideo.removeEventListener("loadeddata", ready);
            currentVideo.removeEventListener("error", failed);
            controller.signal.removeEventListener("abort", aborted);
          };
          const ready = () => {
            cleanup();
            resolve();
          };
          const failed = () => {
            cleanup();
            reject(new Error("Could not load frame video."));
          };
          const aborted = () => {
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
          };
          currentVideo.addEventListener("loadeddata", ready);
          currentVideo.addEventListener("error", failed);
          controller.signal.addEventListener("abort", aborted, { once: true });
          currentVideo.src = new URL(picture.imageUrl!, this.api!.origin).href;
          currentVideo.load();
        });
        if (!document.hidden) await video.play();
        if (
          this.disposed ||
          controller.signal.aborted ||
          frame.pendingRevision !== picture.revision
        )
          return;
        this.apply(frame, video);
        frame.revision = picture.revision;
        video = undefined;
        return;
      }
      const response = await fetch(new URL(picture.imageUrl, this.api.origin), {
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error("Shared picture unavailable; retrying on the next refresh.");
      url = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = url;
      await image.decode();
      if (this.disposed || controller.signal.aborted || frame.pendingRevision !== picture.revision)
        return;
      this.apply(frame, image);
      frame.revision = picture.revision;
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted)
        console.warn(`Could not load shared picture for ${frame.id}.`, error);
    } finally {
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
      this.releaseVideo(video);
      if (frame.loading === controller) {
        frame.loading = undefined;
        frame.pendingRevision = 0;
      }
    }
  }

  private async refresh() {
    if (this.disposed || !this.api || document.hidden) return;
    if (this.polling) {
      this.refreshPending = true;
      return;
    }
    clearTimeout(this.pollTimer);
    this.polling = true;
    try {
      const pictures = await this.request((signal) => this.api!.list(signal));
      if (this.disposed) return;
      await Promise.all(
        pictures.map((picture) => {
          const frame = this.frames.find((entry) => entry.id === picture.frameId);
          return frame ? this.load(frame, picture) : undefined;
        }),
      );
    } catch (error) {
      if (!this.disposed)
        console.warn("Shared pictures could not refresh. Retrying automatically.", error);
    } finally {
      this.polling = false;
      if (!this.disposed && !document.hidden) {
        const delay = this.refreshPending ? 0 : 5000;
        this.refreshPending = false;
        this.pollTimer = setTimeout(() => void this.refresh(), delay);
      }
    }
  }

  private async upload(frame: Frame, file: File) {
    if (!this.api || frame.button.disabled) return;
    const isVideo = /^video\/(mp4|webm)$/.test(file.type);
    if (
      (!isVideo && !/^image\/(jpeg|png|webp)$/.test(file.type)) ||
      !file.size ||
      file.size > (isVideo ? 50 : 10) * 1024 * 1024
    ) {
      this.notification.show(
        "Choose an image up to 10 MiB or an MP4/WebM video up to 50 MiB.",
        "error",
      );
      return;
    }
    frame.button.disabled = true;
    this.notification.show("Uploading shared media...", "info", true);
    try {
      const picture = await this.request(
        (signal) => this.api!.upload(frame.id, file, signal),
        120000,
      );
      if (this.disposed) return;
      this.notification.show(
        "Media saved. Other visitors receive it on their next refresh.",
        "success",
      );
      await this.load(frame, picture);
    } catch (error) {
      if (!this.disposed)
        this.notification.show(
          error instanceof Error ? error.message : "Media upload failed.",
          "error",
        );
    } finally {
      if (!this.disposed) {
        frame.button.disabled = false;
        // A lost HTTP response may still mean the upload committed successfully.
        void this.refresh();
      }
    }
  }

  /** Anchor controls to nearby visible artwork without updating React on every frame. */
  update(camera: THREE.Camera, width: number, height: number) {
    for (const frame of this.frames) {
      frame.mesh.getWorldPosition(this.position);
      this.projected.copy(this.position).project(camera);
      const distance = camera.position.distanceTo(this.position);
      let visible =
        distance < 9 &&
        this.projected.z > -1 &&
        this.projected.z < 1 &&
        Math.abs(this.projected.x) < 1 &&
        Math.abs(this.projected.y) < 1;
      if (visible) {
        this.raycaster.setFromCamera(new THREE.Vector2(this.projected.x, this.projected.y), camera);
        const hit = this.raycaster.intersectObject(this.root, true)[0];
        visible = !!hit && hit.distance >= distance - 0.15;
      }
      frame.button.hidden = !visible;
      if (!visible) continue;
      this.projected.copy(frame.buttonAnchor);
      frame.mesh.localToWorld(this.projected).project(camera);
      frame.button.style.left = `${((this.projected.x + 1) / 2) * width}px`;
      frame.button.style.top = `${((-this.projected.y + 1) / 2) * height}px`;
    }
  }

  dispose() {
    this.disposed = true;
    this.notification.dismiss();
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearTimeout(this.pollTimer);
    this.requests.forEach((request) => request.abort());
    for (const frame of this.frames) {
      frame.loading?.abort();
      frame.button.onclick = null;
      frame.input.onchange = null;
      frame.button.remove();
      frame.input.remove();
      frame.mesh.material = frame.original;
      frame.texture?.dispose();
      this.releaseVideo(frame.video);
      frame.material.dispose();
    }
    // Restore shared GLB materials so scene disposal can release their original textures once.
  }
}
