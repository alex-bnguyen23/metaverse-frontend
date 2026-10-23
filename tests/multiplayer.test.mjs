import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import * as skeletonUtils from "three/addons/utils/SkeletonUtils.js";
import RAPIER from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Run the actual TypeScript modules with deterministic transport and timer boundaries.
function loadModule(path, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, ...globals });
  return exports;
}
const protocol = loadModule("../src/network/protocol.ts");
const { adaptMovementInput } = loadModule("../src/utils/movementAdapter.ts");

test("movement adapter preserves continuous viewpoint directions and normalizes diagonals", () => {
  const north = adaptMovementInput(1, 0, false, { x: 0, z: -1 });
  assert.ok(Math.abs(north.x) < 1e-9);
  assert.equal(north.z, -1);
  const east = adaptMovementInput(1, 0, true, { x: 1, z: 0 });
  assert.equal(east.x, 1);
  assert.ok(Math.abs(east.z) < 1e-9);
  const diagonal = adaptMovementInput(1, 1, false, { x: 0, z: -1 });
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 1e-9);
  assert.equal(adaptMovementInput(0, 0, true, { x: 1, z: 0 }).running, false);
  for (let degree = 0; degree < 360; degree++) {
    const angle = (degree * Math.PI) / 180;
    const direction = { x: Math.sin(angle), z: Math.cos(angle) };
    const result = adaptMovementInput(1, 0, false, direction);
    assert.ok(Math.abs(result.x - direction.x) < 1e-9);
    assert.ok(Math.abs(result.z - direction.z) < 1e-9);
  }
});

test("Rapier blocks walls and water while allowing bridges, door openings and stairs", async () => {
  await RAPIER.init();
  const { WorldPhysics } = loadModule("../src/physics/WorldPhysics.ts", {
    require: (name) => (name === "three" ? THREE : { __esModule: true, default: RAPIER }),
  });
  const box = (scene, x, y, z, width, height, depth, name = "solid") => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshBasicMaterial(),
    );
    mesh.position.set(x, y, z);
    mesh.name = name;
    scene.add(mesh);
    return mesh;
  };
  const simulate = (physics, x, z, frames) => {
    for (let i = 0; i < frames; i++) physics.update({ x, z, running: false }, 1 / 60);
  };
  const scene = new THREE.Group();
  box(scene, 0, -0.25, 0, 20, 0.5, 20);
  box(scene, 2, 1.5, 0, 0.2, 3, 4);
  let physics = new WorldPhysics(scene);
  physics.spawn({ x: 0, y: 0, z: 0 }, 0);
  simulate(physics, 1, 0, 120);
  assert.ok(physics.position.x < 1.7, `wall: ${JSON.stringify(physics.position)}`);
  physics.dispose();
  scene.clear();
  box(scene, 0, -0.25, 0, 20, 0.5, 20);
  box(scene, -1.25, 1.5, -1, 1.5, 3, 0.2);
  box(scene, 1.25, 1.5, -1, 1.5, 3, 0.2);
  physics = new WorldPhysics(scene);
  physics.spawn({ x: 0, y: 0, z: 1 }, 0);
  simulate(physics, 0, -1, 90);
  assert.ok(physics.position.z < -1.5, `door: ${JSON.stringify(physics.position)}`);
  physics.dispose();
  scene.clear();
  box(scene, 0, -0.25, 0, 20, 0.5, 20);
  for (let i = 0; i < 8; i++) box(scene, 1.25 + i * 0.5, (i + 1) * 0.1, 0, 0.5, (i + 1) * 0.2, 2);
  physics = new WorldPhysics(scene);
  physics.spawn({ x: 0, y: 0, z: 0 }, 0);
  simulate(physics, 1, 0, 90);
  assert.ok(physics.position.y > 0.5, `stairs: ${JSON.stringify(physics.position)}`);
  physics.dispose();
  scene.clear();
  box(scene, 0, -1, 0, 20, 0.2, 20);
  box(scene, -2, -0.5, 0, 4, 1, 10);
  box(scene, 2, -0.1, 0, 4, 0.02, 8, "River Water");
  box(scene, 2, 0.1, 0, 4, 0.2, 1.5, "Bridge");
  physics = new WorldPhysics(scene);
  physics.spawn({ x: -1, y: 0, z: 2 }, 0);
  simulate(physics, 1, 0, 120);
  assert.ok(physics.position.x < 0, `river: ${JSON.stringify(physics.position)}`);
  physics.spawn({ x: -1, y: 0, z: 0 }, 0);
  simulate(physics, 1, 0, 105);
  assert.ok(
    physics.position.x > 2 && physics.position.y > 0.15,
    `bridge: ${JSON.stringify(physics.position)}`,
  );
  physics.dispose();
});

test("castle asset supports approach stairs and the south bridge", async () => {
  // Omit textures for this collision-only asset check, retaining geometry and material names.
  const source = readFileSync(new URL("../public/models/osaka-castle2.glb", import.meta.url));
  const jsonLength = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  json.materials = json.materials.map((material) => ({ name: material.name }));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(padded);
  const binary = source.subarray(20 + jsonLength);
  const glb = Buffer.alloc(20 + padded.length + binary.length);
  source.copy(glb, 0, 0, 12);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20);
  binary.copy(glb, 20 + padded.length);
  const asset = await new GLTFLoader().parseAsync(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length),
    "",
  );
  const { WorldPhysics, initializePhysics } = loadModule("../src/physics/WorldPhysics.ts", {
    require: (name) => (name === "three" ? THREE : { __esModule: true, default: RAPIER }),
  });
  await initializePhysics();
  const physics = new WorldPhysics(asset.scene);
  try {
    physics.spawn({ x: 0, y: 0, z: 23.55 }, 0);
    for (let i = 0; i < 300; i++) physics.update({ x: 0, z: -1, running: false }, 1 / 60);
    assert.ok(physics.position.y > 0.6, `castle stairs: ${JSON.stringify(physics.position)}`);
    physics.spawn({ x: 30, y: 0, z: 39 }, 0);
    for (let i = 0; i < 360; i++) physics.update({ x: 1, z: 0, running: false }, 1 / 60);
    assert.ok(physics.position.x > 44, `castle bridge: ${JSON.stringify(physics.position)}`);
  } finally {
    physics.dispose();
    asset.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          material.dispose();
      }
    });
  }
});

const appearance = { shirt: 1, pants: 0, hairstyle: 1, glasses: 0 };
const player = (id) => ({
  id,
  name: id,
  appearance,
  position: { x: 0, y: 0, z: 0 },
  rotation: 0,
  animation: "Idle",
});
const wire = (type, payload) => JSON.stringify({ type, payload });

function harness() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const intervals = new Map();
  const sockets = [];
  const statuses = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor() {
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    receive(type, payload) {
      this.onmessage?.({ data: wire(type, payload) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const { MultiplayerSession } = loadModule("../src/network/MultiplayerSession.ts", {
    require: () => protocol,
    WebSocket: Socket,
    performance: { now: () => now },
    setInterval: (callback) => {
      const id = ++nextTimer;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const session = new MultiplayerSession("ws://test", "Alice", appearance, (status) =>
    statuses.push(status),
  );
  return {
    session,
    sockets,
    statuses,
    timers,
    intervals,
    tick: () => {
      now += 50;
      for (const callback of intervals.values()) callback();
    },
    retry: () => {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test("wire validation rejects malformed, unknown, duplicate and invalid player data", () => {
  for (const data of [
    "broken",
    "null",
    "{}",
    wire("unknown:event", {}),
    wire("world:init", { playerId: "a", players: [] }),
    wire("world:init", { playerId: "a", players: [player("a"), player("a")] }),
    wire("player:joined", { player: { ...player("a"), appearance: { ...appearance, shirt: 9 } } }),
    wire("player:update", { ...player("a"), sequence: -1 }),
    wire("player:update", { ...player("a"), position: { x: null, y: 0, z: 0 } }),
  ])
    assert.equal(protocol.parseServerMessage(data), null);
  for (const sequence of [0, 42]) {
    assert.ok(protocol.parseServerMessage(wire("player:update", { ...player("a"), sequence })));
  }
  for (const sequence of [undefined, null, 0.5, -1, Infinity])
    assert.equal(
      protocol.parseServerMessage(wire("player:update", { ...player("a"), sequence })),
      null,
    );
});

test("join, five players, deduplication, updates, movement cadence, stop and cleanup", () => {
  const h = harness();
  h.session.start();
  h.session.start();
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  socket.open();
  assert.equal(socket.sent[0].type, "player:join");
  assert.equal(socket.sent[0].payload.name, "Alice");
  h.tick();
  assert.equal(socket.sent.length, 1);
  socket.receive("world:init", { playerId: "a", players: ["a", "b", "c", "d", "e"].map(player) });
  socket.receive("player:joined", { player: player("b") });
  assert.equal(h.session.players.size, 5);
  socket.receive("player:update", {
    ...player("b"),
    position: { x: 4, y: 0, z: 2 },
    animation: "Run",
    sequence: 1,
  });
  assert.equal(h.session.players.get("b").position.x, 4);
  h.session.setMovement({ position: { x: 1, y: 0.5, z: 2 }, rotation: 1, animation: "Run" });
  h.tick();
  h.tick();
  const moves = socket.sent.filter((message) => message.type === "player:move");
  assert.equal(moves.length, 1);
  assert.equal(moves[0].payload.sequence, 1);
  assert.equal(JSON.stringify(moves[0].payload.position), JSON.stringify({ x: 1, y: 0.5, z: 2 }));
  assert.equal("appearance" in moves[0].payload, false);
  assert.equal("id" in moves[0].payload, false);
  assert.equal(h.session.players.get("a").position.y, 0.5);
  socket.receive("player:update", { ...player("b"), sequence: 0 });
  assert.equal(h.session.players.get("b").position.x, 4);
  socket.receive("player:update", { ...player("a"), sequence: 99 });
  assert.equal(h.session.players.get("a").position.x, 1);
  h.session.setMovement({ position: { x: 1, y: 0.5, z: 2 }, rotation: 1, animation: "Idle" });
  h.tick();
  const stoppedCount = socket.sent.length;
  h.tick();
  assert.equal(socket.sent.length, stoppedCount);
  assert.equal(socket.sent.at(-1).payload.animation, "Idle");
  socket.receive("player:left", { id: "b" });
  assert.equal(h.session.players.has("b"), false);
  h.session.stop();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(socket.readyState, 3);
  assert.equal(h.session.players.size, 0);
});

test("disconnect clears stale players and reconnects once with a fresh join", () => {
  const h = harness();
  h.session.start();
  h.sockets[0].open();
  h.sockets[0].receive("world:init", { playerId: "a", players: [player("a")] });
  h.sockets[0].close();
  assert.equal(h.session.players.size, 0);
  assert.equal(h.session.playerId, null);
  h.retry();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  assert.equal(h.sockets[1].sent[0].type, "player:join");
  h.session.stop();
  assert.equal(h.timers.size, 0);
});

test("room-full rejection displays the error and does not retry", () => {
  const h = harness();
  h.session.start();
  h.sockets[0].open();
  h.sockets[0].receive("server:error", {
    code: "ROOM_FULL",
    message: "Maximum 5 players allowed.",
  });
  assert.equal(h.statuses.at(-1).state, "error");
  assert.match(h.statuses.at(-1).message, /ROOM_FULL/);
  assert.equal(h.timers.size, 0);
  h.session.stop();
});

const chatMessage = (id, timestamp = 1000) => ({
  id,
  senderId: "a",
  senderName: "Alice",
  text: "Hello",
  timestamp,
});

test("chat validates Unicode length and server identity fields", () => {
  const valid = chatMessage("message-1");
  assert.ok(
    protocol.parseServerMessage(wire("chat:message", { ...valid, text: "😀".repeat(200) })),
  );
  for (const invalid of [
    { ...valid, text: "😀".repeat(201) },
    { ...valid, text: "   " },
    { ...valid, timestamp: -1 },
    { ...valid, timestamp: "1000" },
    { ...valid, senderId: null },
    { ...valid, id: "" },
  ])
    assert.equal(protocol.parseServerMessage(wire("chat:message", invalid)), null);
});

test("chat uses existing socket, waits for echo, rate limits and preserves world on rejection", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  assert.equal(h.session.sendChat("Hello"), false);
  socket.receive("world:init", { playerId: "a", players: [player("a")] });
  assert.equal(h.session.sendChat("  Hello  "), true);
  assert.equal(h.sockets.length, 1);
  assert.equal(JSON.stringify(socket.sent.at(-1)), wire("chat:send", { text: "Hello" }));
  assert.equal(h.session.getChatSnapshot().messages.length, 0);
  assert.equal(h.session.sendChat("Too soon"), false);
  socket.receive("chat:message", chatMessage("one"));
  socket.receive("chat:message", chatMessage("one"));
  assert.equal(h.session.getChatSnapshot().messages.length, 1);
  socket.receive("server:error", { code: "RATE_LIMITED", message: "Wait one second." });
  assert.equal(socket.readyState, 1);
  assert.equal(h.session.playerId, "a");
  assert.match(h.session.getChatSnapshot().error, /RATE_LIMITED/);
  for (let i = 0; i < 20; i++) h.tick();
  assert.equal(h.session.sendChat("😀".repeat(201)), false);
  assert.equal(h.session.sendChat("😀".repeat(200)), true);
  socket.close();
  assert.equal(h.session.sendChat("Offline"), false);
  h.session.stop();
});

test("chat history is chronological, bounded and subscriptions can be removed", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", { playerId: "a", players: [player("a")] });
  let notifications = 0;
  const unsubscribe = h.session.subscribeChat(() => notifications++);
  for (let i = 105; i >= 0; i--) socket.receive("chat:message", chatMessage(`message-${i}`, i));
  const snapshot = h.session.getChatSnapshot();
  assert.equal(snapshot.messages.length, 100);
  assert.equal(snapshot.messages[0].timestamp, 6);
  assert.equal(snapshot.messages.at(-1).timestamp, 105);
  unsubscribe();
  socket.receive("chat:message", chatMessage("later", 200));
  assert.equal(notifications, 106);
  h.session.stop();
});

test("character bubbles follow the camera, replace messages, expire and clean up", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", { playerId: "a", players: [player("a")] });
  const element = () => ({
    style: {},
    children: [],
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
    },
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((child) => child !== this);
    },
  });
  const { CharacterChatBubbles } = loadModule("../src/components/CharacterChatBubbles.ts", {
    require: () => THREE,
    document: { createElement: element },
    performance: { now: () => 0 },
  });
  const container = element();
  const bubbles = new CharacterChatBubbles(container, h.session);
  const character = new THREE.Group();
  const characters = new Map([["a", character]]);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 2, 10);
  camera.lookAt(0, 2, 0);
  socket.receive("chat:message", chatMessage("one"));
  bubbles.update(camera, characters, 0);
  const layer = container.children[0];
  assert.equal(layer.children.length, 1);
  assert.equal(layer.children[0].style.visibility, "visible");
  const left = layer.children[0].style.left;
  character.position.x = 1;
  bubbles.update(camera, characters, 100);
  assert.notEqual(layer.children[0].style.left, left);
  socket.receive("chat:message", { ...chatMessage("two", 2000), text: "<b>Plain text</b>" });
  assert.equal(layer.children.length, 1);
  assert.equal(layer.children[0].textContent, "<b>Plain text</b>");
  character.position.z = 20;
  bubbles.update(camera, characters, 200);
  assert.equal(layer.children[0].style.visibility, "hidden");
  bubbles.update(camera, characters, 6000);
  assert.equal(layer.children.length, 0);
  socket.receive("chat:message", chatMessage("three", 3000));
  socket.receive("player:left", { id: "a" });
  bubbles.update(camera, characters, 0);
  assert.equal(layer.children.length, 0);
  bubbles.dispose();
  assert.equal(container.children.length, 0);
  h.session.stop();
});

test("characters deduplicate, own their colors and release only owned resources on leave", () => {
  const appearanceModule = loadModule("../src/utils/appearance.ts", { require: () => THREE });
  const { NetworkCharacters } = loadModule("../src/components/NetworkCharacters.ts", {
    require: (name) =>
      name === "three" ? THREE : name.includes("SkeletonUtils") ? skeletonUtils : appearanceModule,
  });
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  material.name = "Switchable shirt";
  const template = new THREE.Group();
  template.add(new THREE.Mesh(geometry, material));
  let geometryDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  const characters = new NetworkCharacters(scene, template, []);
  const players = new Map([
    ["a", player("a")],
    ["b", { ...player("b"), appearance: { ...appearance, shirt: 2 } }],
  ]);
  characters.update(players, 0.05);
  characters.update(players, 0.05);
  assert.equal(characters.objects.size, 2);
  assert.equal(scene.children.length, 2);
  const ownMaterial = characters.objects.get("a").children[0].material;
  const otherMaterial = characters.objects.get("b").children[0].material;
  assert.notEqual(ownMaterial.color.getHex(), otherMaterial.color.getHex());
  assert.notEqual(ownMaterial, material);
  let materialDisposals = 0;
  ownMaterial.addEventListener("dispose", () => materialDisposals++);
  players.delete("a");
  characters.update(players, 0.05);
  assert.equal(scene.children.length, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(geometryDisposals, 0);
  characters.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(geometryDisposals, 0);
  geometry.dispose();
  material.dispose();
});
