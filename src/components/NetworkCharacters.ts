import * as THREE from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { applyAppearance } from "../utils/appearance";
import type { AnimationState, PlayerState } from "../network/protocol";

type Instance = {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<AnimationState, THREE.AnimationAction>>;
  state?: AnimationState;
};

/** Clones share geometry/textures but own skeletons and materials for independent appearances. */
export class NetworkCharacters {
  readonly objects = new Map<string, THREE.Object3D>();
  private readonly instances = new Map<string, Instance>();
  private readonly target = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly scene: THREE.Scene;
  private readonly template: THREE.Object3D;
  private readonly clips: THREE.AnimationClip[];
  constructor(scene: THREE.Scene, template: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.scene = scene;
    this.template = template;
    this.clips = clips;
  }

  update(players: ReadonlyMap<string, PlayerState>, delta: number, localPlayerId?: string | null) {
    for (const id of this.objects.keys()) if (!players.has(id)) this.remove(id);
    for (const [id, player] of players) {
      let instance = this.instances.get(id);
      if (!instance) {
        const root = clone(this.template);
        // Clone each source material once per character, preserving intra-model sharing.
        const materials = new Map<THREE.Material, THREE.Material>();
        const ownMaterial = (material: THREE.Material) => {
          if (!materials.has(material)) materials.set(material, material.clone());
          return materials.get(material)!;
        };
        root.traverse((object) => {
          if (object instanceof THREE.Mesh)
            object.material = Array.isArray(object.material)
              ? object.material.map(ownMaterial)
              : ownMaterial(object.material);
        });
        applyAppearance(root, player.appearance);
        root.position.set(player.position.x, player.position.y, player.position.z);
        root.rotation.y = player.rotation;
        const mixer = new THREE.AnimationMixer(root);
        const actions: Instance["actions"] = {};
        for (const state of ["Idle", "Walk", "Run"] as const) {
          const clip = this.clips.find((clip) => clip.name.toLowerCase() === state.toLowerCase());
          if (clip) actions[state] = mixer.clipAction(clip);
        }
        instance = { root, mixer, actions };
        this.instances.set(id, instance);
        this.objects.set(id, root);
        this.scene.add(root);
      }
      const { root, mixer, actions } = instance;
      this.target.set(player.position.x, player.position.y, player.position.z);
      // Only remote snapshots are interpolated; local physics must render without network lag.
      if (id === localPlayerId || root.position.distanceToSquared(this.target) > 25)
        root.position.copy(this.target);
      else root.position.lerp(this.target, 1 - Math.exp(-20 * delta));
      this.rotation.setFromAxisAngle(this.up, player.rotation);
      if (id === localPlayerId) root.quaternion.copy(this.rotation);
      else root.quaternion.slerp(this.rotation, 1 - Math.exp(-20 * delta));
      if (instance.state !== player.animation && actions[player.animation]) {
        if (instance.state) actions[instance.state]?.fadeOut(0.2);
        actions[player.animation]!.reset().fadeIn(0.2).play();
        instance.state = player.animation;
      }
      mixer.update(delta);
    }
  }

  private remove(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.mixer.stopAllAction();
    instance.mixer.uncacheRoot(instance.root);
    const materials = new Set<THREE.Material>();
    instance.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
        if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      }
    });
    materials.forEach((material) => material.dispose());
    // Geometry and textures belong to the template and survive until the scene is disposed.
    this.scene.remove(instance.root);
    this.instances.delete(id);
    this.objects.delete(id);
  }

  dispose() {
    for (const id of this.objects.keys()) this.remove(id);
  }
}
