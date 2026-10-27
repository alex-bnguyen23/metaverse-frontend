import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const exports = {};
let calls = [];
let result;
const source = ts.transpileModule(
  readFileSync(new URL("../src/network/framePictures.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;
vm.runInNewContext(source, {
  exports,
  URL,
  FormData,
  fetch: async (...args) => {
    calls.push(args);
    return result;
  },
});
const { parseFramePicture, parseFramePictures, FramePicturesApi } = exports;
const picture = (revision = 1) => ({
  frameId: "left",
  revision,
  imageUrl: `/api/frame-pictures/left/images/${revision}.jpg`,
  updatedAt: 123,
});

test("validates revisions, empty frames and exact API-owned image paths", () => {
  assert.equal(parseFramePicture(picture()).revision, 1);
  const empty = { frameId: "right", revision: 0, imageUrl: null, updatedAt: null };
  assert.equal(parseFramePictures({ frames: [picture(), empty] }).length, 2);
  for (const invalid of [
    { ...picture(), revision: -1 },
    { ...picture(), revision: 1.5 },
    { ...picture(), imageUrl: "https://other.example/image.jpg" },
    { ...picture(), imageUrl: "/api/frame-pictures/right/images/1.jpg" },
    { ...empty, imageUrl: "/image.jpg" },
    { ...picture(), updatedAt: null },
  ])
    assert.throws(() => parseFramePicture(invalid));
  assert.throws(() => parseFramePictures({ frames: [picture(), picture()] }));
});

test("uploads original file as multipart PUT and validates response identity", async () => {
  const api = new FramePicturesApi("https://api.example");
  const controller = new AbortController();
  const file = new File(["image bytes"], "photo.png", { type: "image/png" });
  result = new Response(JSON.stringify({ frame: picture(2) }));
  const frame = await api.upload("left", file, controller.signal);
  assert.equal(frame.revision, 2);
  const [url, options] = calls.at(-1);
  assert.equal(url, "https://api.example/api/frame-pictures/left");
  assert.equal(options.method, "PUT");
  assert.equal(options.headers, undefined);
  assert.equal(await options.body.get("image").text(), "image bytes");
  assert.equal(options.signal, controller.signal);
  result = new Response(JSON.stringify({ frame: picture() }));
  await assert.rejects(api.upload("right", file, controller.signal), /Invalid upload response/);
});

test("returns server errors and Retry-After; rejects invalid API origins", async () => {
  const api = new FramePicturesApi("https://api.example");
  result = new Response(
    JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many uploads." } }),
    {
      status: 429,
      headers: { "Retry-After": "30" },
    },
  );
  await assert.rejects(api.list(new AbortController().signal), /Too many uploads.*30 seconds/);
  for (const origin of [
    "wss://api.example",
    "https://api.example/path",
    "https://user:password@api.example",
  ])
    assert.throws(() => new FramePicturesApi(origin));
});

test("video metadata accepts only matching MP4 revisions and retains legacy images", () => {
  const video = {
    ...picture(3),
    mediaType: "video",
    imageUrl: "/api/frame-pictures/left/videos/3.mp4",
  };
  assert.equal(parseFramePicture(video).mediaType, "video");
  assert.equal(parseFramePicture(picture()).mediaType, "image");
  for (const invalid of [
    { ...video, imageUrl: picture(3).imageUrl },
    { ...video, imageUrl: "/api/frame-pictures/left/videos/2.mp4" },
    { ...video, imageUrl: "https://other.example/video.mp4" },
    { ...video, mediaType: "audio" },
    { ...video, revision: 0, imageUrl: null, updatedAt: null },
  ])
    assert.throws(() => parseFramePicture(invalid));
});

test("video uses the existing multipart field and receives committed video metadata", async () => {
  const api = new FramePicturesApi("https://api.example");
  const file = new File(["video bytes"], "clip.webm", { type: "video/webm" });
  result = new Response(
    JSON.stringify({
      frame: {
        ...picture(4),
        mediaType: "video",
        imageUrl: "/api/frame-pictures/left/videos/4.mp4",
      },
    }),
  );
  const frame = await api.upload("left", file, new AbortController().signal);
  assert.equal(frame.mediaType, "video");
  const [, options] = calls.at(-1);
  assert.equal(options.body.get("image").type, "video/webm");
  assert.equal(await options.body.get("image").text(), "video bytes");
  assert.deepEqual([...options.body.keys()], ["image"]);
});

test("frame videos loop muted, preserve newer revisions and release replaced playback", async () => {
  const THREE = await import("three");
  class Video extends EventTarget {
    src = "";
    pauses = 0;
    plays = 0;
    readyState = 4;
    HAVE_CURRENT_DATA = 2;
    load() {
      if (this.src) queueMicrotask(() => this.dispatchEvent(new Event("loadeddata")));
    }
    async play() {
      this.plays++;
    }
    pause() {
      this.pauses++;
    }
    removeAttribute(name) {
      if (name === "src") this.src = "";
    }
  }
  const module = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/components/FramePictures.ts", import.meta.url), "utf8").replaceAll(
      "import.meta.env",
      "({})",
    ),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const created = [];
  vm.runInNewContext(code, {
    exports: module.exports,
    require: (name) => (name === "three" ? THREE : {}),
    HTMLVideoElement: Video,
    AbortController,
    DOMException,
    URL,
    setTimeout,
    clearTimeout,
    console,
    document: {
      hidden: false,
      createElement: () => {
        const video = new Video();
        created.push(video);
        return video;
      },
    },
  });
  const controller = Object.create(module.exports.FramePictures.prototype);
  controller.api = { origin: "https://api.example" };
  controller.disposed = false;
  const frame = {
    id: "left",
    revision: 0,
    pendingRevision: 0,
    material: new THREE.MeshStandardMaterial(),
    button: {},
  };
  const metadata = (revision) => ({
    ...picture(revision),
    mediaType: "video",
    imageUrl: `/api/frame-pictures/left/videos/${revision}.mp4`,
  });
  await controller.load(frame, metadata(1));
  const first = frame.video;
  assert.equal(first.muted, true);
  assert.equal(first.loop, true);
  assert.equal(first.playsInline, true);
  assert.equal(first.plays, 1);
  assert.equal(frame.texture.isVideoTexture, true);
  assert.equal(frame.texture.flipY, false);
  let disposed = 0;
  frame.texture.addEventListener("dispose", () => disposed++);
  await controller.load(frame, metadata(2));
  assert.equal(first.src, "");
  assert.equal(first.pauses, 1);
  assert.equal(disposed, 1);
  assert.equal(frame.revision, 2);
  await controller.load(frame, metadata(1));
  assert.equal(created.length, 2);
  controller.releaseVideo(frame.video);
  frame.texture.dispose();
  frame.material.dispose();
});
