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
