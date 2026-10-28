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
  const asset = await loadCastle();
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

function harness(playerName = "Alice", selection = appearance) {
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
    TextEncoder,
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
  const session = new MultiplayerSession("ws://test", playerName, selection, (status) =>
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
  let ownMaterial;
  characters.objects.get("a").traverse((object) => {
    if (object.isMesh) ownMaterial = object.material;
  });
  let otherMaterial;
  characters.objects.get("b").traverse((object) => {
    if (object.isMesh) otherMaterial = object.material;
  });
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

const truck = (driverId = null, revision = 0) => ({
  id: "cybertruck-1",
  driverId,
  passengerId: null,
  revision,
  position: { x: -35, y: 0, z: 0 },
  rotation: Math.PI / 2,
  speed: 0,
  steering: 0,
  wheelAngle: 0,
});

test("vehicle wire validation enforces bounds, occupants, limits and release variants", () => {
  const valid = truck("a", 1);
  assert.ok(
    protocol.parseServerMessage(
      wire("world:init", { playerId: "a", players: [player("a")], vehicles: [valid] }),
    ),
  );
  for (const update of [
    { speed: 11 },
    { speed: -5 },
    { steering: 1 },
    { wheelAngle: null },
    { revision: -1 },
    { position: { x: 100, y: 0, z: 0 } },
    { driverId: null, speed: 1 },
  ]) {
    assert.equal(
      protocol.parseServerMessage(
        wire("vehicle:update", { vehicle: { ...valid, ...update }, sequence: 0 }),
      ),
      null,
    );
  }
  assert.equal(
    protocol.parseServerMessage(
      wire("world:init", { playerId: "a", players: [player("a")], vehicles: [truck("missing")] }),
    ),
    null,
  );
  assert.equal(
    protocol.parseServerMessage(wire("vehicle:update", { vehicle: valid, sequence: 0.5 })),
    null,
  );
  assert.ok(
    protocol.parseServerMessage(
      wire("vehicle:released", {
        vehicle: truck(null, 2),
        playerId: "a",
        seat: "driver",
        player: null,
        reason: "disconnect",
      }),
    ),
  );
  assert.equal(
    protocol.parseServerMessage(
      wire("vehicle:released", {
        vehicle: truck(null, 2),
        playerId: "a",
        seat: "driver",
        player: null,
        reason: "exit",
      }),
    ),
    null,
  );
});

test("vehicle grants, prediction, cadence, stale leases, ordered exit and walking resume", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", {
    playerId: "a",
    players: [player("a"), player("b")],
    vehicles: [truck()],
  });
  h.session.requestEnter();
  h.session.requestEnter();
  assert.equal(socket.sent.filter((m) => m.type === "vehicle:enter").length, 1);
  assert.equal(h.session.driving, false);
  socket.receive("vehicle:occupied", { vehicle: truck("a", 1), playerId: "a", seat: "driver" });
  assert.equal(h.session.driving, true);
  h.session.setMovement({ position: { x: 0, y: 0, z: 0 }, rotation: 0, animation: "Run" });
  h.session.setVehicleMovement({
    ...truck("a", 1),
    position: { x: -35, y: 0, z: 3 },
    speed: 4,
    wheelAngle: 5,
  });
  h.tick();
  h.tick();
  assert.equal(socket.sent.filter((m) => m.type === "player:move").length, 0);
  assert.equal(socket.sent.filter((m) => m.type === "vehicle:move").length, 1);
  assert.equal(socket.sent.at(-1).payload.sequence, 0);
  socket.receive("vehicle:update", { vehicle: truck("a", 1), sequence: 0 });
  assert.equal(h.session.vehicle.position.z, 3);
  socket.receive("vehicle:released", {
    playerId: "a",
    seat: "driver",
    vehicle: truck(null, 0),
    player: player("a"),
    reason: "exit",
  });
  assert.equal(h.session.driving, true);
  for (let i = 0; i < 10; i++) h.tick();
  h.session.setVehicleMovement({ ...h.session.vehicle, speed: 0, steering: 0 });
  h.session.requestExit({ x: -33, y: 0, z: 3 }, 0);
  assert.notEqual(socket.sent.at(-1).type, "vehicle:exit");
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:move");
  assert.equal(socket.sent.at(-1).payload.speed, 0);
  const stop = socket.sent.at(-1).payload;
  socket.receive("vehicle:update", { vehicle: { ...h.session.vehicle }, sequence: stop.sequence });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:exit");
  socket.receive("vehicle:released", {
    playerId: "a",
    seat: "driver",
    vehicle: { ...truck(null, 2), position: { x: -35, y: 0, z: 3 } },
    player: { ...player("a"), position: { x: -33, y: 0, z: 3 } },
    reason: "exit",
  });
  assert.equal(h.session.driving, false);
  assert.equal(h.session.releaseVersion, 1);
  h.session.setMovement({ position: { x: -32, y: 0, z: 3 }, rotation: 0, animation: "Walk" });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "player:move");
  socket.receive("vehicle:occupied", { vehicle: truck("b", 3), playerId: "b", seat: "driver" });
  socket.receive("vehicle:update", {
    vehicle: { ...truck("b", 3), position: { x: -34, y: 0, z: 4 } },
    sequence: 2,
  });
  socket.receive("vehicle:update", { vehicle: truck("b", 3), sequence: 1 });
  assert.equal(h.session.vehicle.position.z, 4);
  socket.receive("vehicle:update", { vehicle: truck("a", 1), sequence: 999 });
  assert.equal(h.session.vehicle.driverId, "b");
  socket.receive("vehicle:released", {
    playerId: "b",
    seat: "driver",
    vehicle: truck(null, 4),
    player: null,
    reason: "disconnect",
  });
  assert.equal(h.session.vehicle.driverId, null);
  socket.close();
  assert.equal(h.session.vehicle, null);
  h.session.stop();
});

test("vehicle request failures preserve the world and missing grants time out", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", { playerId: "a", players: [player("a")], vehicles: [truck()] });
  h.session.requestEnter();
  socket.receive("server:error", {
    code: "VEHICLE_OCCUPIED",
    message: "Occupied",
    requestType: "vehicle:enter",
  });
  assert.equal(h.session.vehiclePending, false);
  assert.equal(h.session.playerId, "a");
  for (let i = 0; i < 11; i++) h.tick();
  h.session.requestEnter();
  for (let i = 0; i < 102; i++) h.tick();
  assert.equal(socket.readyState, 3);
  assert.equal(h.session.vehicle, null);
  h.session.stop();
});

test("vehicle physics rejects walls, water and blocked exits and moves its walking collider", async () => {
  await RAPIER.init();
  const { WorldPhysics } = loadModule("../src/physics/WorldPhysics.ts", {
    require: (name) => (name === "three" ? THREE : { __esModule: true, default: RAPIER }),
  });
  const scene = new THREE.Group();
  const box = (x, y, z, w, h, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };
  box(0, -0.25, 0, 30, 0.5, 30);
  box(6, 1, 0, 0.2, 2, 8);
  const water = box(-6, 0.1, 0, 4, 0.1, 8);
  water.userData.collision = "water";
  const physics = new WorldPhysics(scene);
  physics.setTruck({ x: 0, y: 0, z: 0 }, 0);
  assert.ok(Math.abs(physics.vehicleGround({ x: 0, y: 0, z: 0 }, 0)) < 1e-5);
  assert.equal(physics.canDrive({ x: 0, y: 0, z: 0 }, 0), true);
  assert.equal(physics.canDrive({ x: 4, y: 0, z: 0 }, 0), false);
  assert.equal(physics.vehicleGround({ x: -6, y: 0, z: 0 }, 0), null);
  const exit = physics.findExit({ x: 0, y: 0, z: 0 }, 0);
  assert.ok(exit);
  assert.equal(exit.z, 2);
  physics.spawn({ x: 0, y: 0, z: 4 }, 0);
  for (let i = 0; i < 120; i++) physics.update({ x: 0, z: -1, running: false }, 1 / 60);
  assert.ok(physics.position.z > 1.4);
  physics.setTruck({ x: 10, y: 0, z: 10 }, 0);
  for (let i = 0; i < 60; i++) physics.update({ x: 0, z: -1, running: false }, 1 / 60);
  assert.ok(physics.position.z < 1);
  physics.dispose();
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });
});

async function loadCastle() {
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

  return asset;
}

test("authored truck drives from its GLB spawn with synchronized pivots", async () => {
  const asset = await loadCastle();
  await RAPIER.init();
  const { WorldPhysics } = loadModule("../src/physics/WorldPhysics.ts", {
    require: (name) => (name === "three" ? THREE : { __esModule: true, default: RAPIER }),
  });
  const { VehicleController } = loadModule("../src/vehicles/VehicleController.ts", {
    require: () => THREE,
  });
  const physics = new WorldPhysics(asset.scene);
  const controller = new VehicleController(asset.scene);
  const initial = controller.root.getWorldPosition(new THREE.Vector3());
  assert.equal(initial.x, -35);
  assert.equal(initial.y, 0);
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", {
    playerId: "a",
    players: [player("a")],
    vehicles: [truck("a", 1)],
  });
  for (let i = 0; i < 60; i++) controller.update(h.session, physics, 1, 0, 1 / 60);
  assert.ok(h.session.vehicle.position.z > 1, JSON.stringify(h.session.vehicle));
  assert.ok(h.session.vehicle.speed > 0);
  assert.ok(h.session.vehicle.wheelAngle > 0);
  const position = controller.root.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(position.z - h.session.vehicle.position.z) < 0.001);
  controller.interact(h.session, physics);
  for (let i = 0; i < 120; i++) {
    controller.update(h.session, physics, 0, 0, 1 / 60);
    h.tick();
    const report = socket.sent.findLast((m) => m.type === "vehicle:move");
    if (report)
      socket.receive("vehicle:update", {
        vehicle: { ...h.session.vehicle, speed: report.payload.speed },
        sequence: report.payload.sequence,
      });
  }
  assert.equal(h.session.vehicle.speed, 0);
  assert.ok(socket.sent.some((m) => m.type === "vehicle:exit"));
  h.session.stop();
  physics.dispose();
  asset.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
  });
});

test("driving respects speed limits, steering, reverse and render frame independence", () => {
  const { VehicleController } = loadModule("../src/vehicles/VehicleController.ts", {
    require: () => THREE,
  });
  const simulate = (fps) => {
    const world = new THREE.Group();
    const root = new THREE.Group();
    root.name = "Cybertruck_drive_control";
    world.add(root);
    for (const name of [
      "Front_left_wheel_spin",
      "Front_right_wheel_spin",
      "Rear_left_wheel_spin",
      "Rear_right_wheel_spin",
    ]) {
      const wheel = new THREE.Group();
      wheel.name = name;
      root.add(wheel);
    }
    const controller = new VehicleController(world);
    const h = harness();
    h.session.start();
    const socket = h.sockets[0];
    socket.open();
    socket.receive("world:init", {
      playerId: "a",
      players: [player("a")],
      vehicles: [{ ...truck("a", 1), position: { x: 0, y: 0, z: 0 }, rotation: 0 }],
    });
    const physics = {
      vehicleGround: () => 0,
      canDrive: () => true,
      setTruck: () => {},
      findExit: () => null,
    };
    for (let i = 0; i < fps * 2; i++) controller.update(h.session, physics, 1, 0, 1 / fps);
    assert.equal(h.session.vehicle.speed, 10);
    const straight = { ...h.session.vehicle.position };
    for (let i = 0; i < fps; i++) controller.update(h.session, physics, 1, -1, 1 / fps);
    assert.ok(h.session.vehicle.steering > 0 && h.session.vehicle.steering <= Math.PI / 6);
    assert.ok(h.session.vehicle.rotation > 0);
    for (let i = 0; i < fps * 3; i++) controller.update(h.session, physics, -1, 0, 1 / fps);
    assert.equal(h.session.vehicle.speed, -4);
    for (let i = 0; i < fps; i++) controller.update(h.session, physics, 0, 0, 1 / fps);
    assert.equal(h.session.vehicle.speed, 0);
    controller.interact(h.session, physics);
    controller.update(h.session, physics, 0, 0, 1 / fps);
    assert.match(h.session.vehicleError, /No safe place/);
    assert.equal(h.session.driving, true);
    h.session.stop();
    return straight;
  };
  const slow = simulate(30),
    fast = simulate(120);
  assert.ok(Math.abs(slow.x - fast.x) < 0.001);
  assert.ok(Math.abs(slow.z - fast.z) < 0.001);
});

test("rolling movement budget, stopped acknowledgement and transport backpressure follow the guide", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", { playerId: "a", players: [player("a")], vehicles: [truck()] });
  for (let i = 0; i < 21; i++) {
    h.session.setMovement({ position: { x: i, y: 0, z: 0 }, rotation: 0, animation: "Walk" });
    h.tick();
  }
  assert.equal(socket.sent.filter((m) => m.type === "player:move").length, 20);
  h.tick();
  assert.equal(socket.sent.filter((m) => m.type === "player:move").length, 21);
  socket.bufferedAmount = 70000;
  h.session.setMovement({ position: { x: 22, y: 0, z: 0 }, rotation: 0, animation: "Idle" });
  h.tick();
  const count = socket.sent.length;
  socket.bufferedAmount = 0;
  h.tick();
  assert.equal(socket.sent.length, count + 1);
  socket.receive("vehicle:occupied", { vehicle: truck("a", 1), playerId: "a", seat: "driver" });
  h.session.requestExit({ x: -33, y: 0, z: 0 }, 0);
  h.tick();
  const report = socket.sent.at(-1);
  assert.equal(report.type, "vehicle:move");
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:move");
  socket.receive("vehicle:update", { vehicle: truck("a", 1), sequence: report.payload.sequence });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:exit");
  h.session.stop();
});

test("join trims names and rejects invalid lengths before opening a socket", () => {
  const valid = harness("  Alice  ");
  valid.session.start();
  valid.sockets[0].open();
  assert.equal(valid.sockets[0].sent[0].payload.name, "Alice");
  valid.session.stop();
  for (const name of ["   ", "x".repeat(25)]) {
    const h = harness(name);
    h.session.start();
    assert.equal(h.sockets.length, 0);
    assert.equal(h.statuses.at(-1).state, "error");
    h.session.stop();
  }
});

test("rejected occupancy requests still consume the separate rolling budget", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", { playerId: "a", players: [player("a")], vehicles: [truck()] });
  for (let i = 0; i < 3; i++) {
    h.session.requestEnter();
    socket.receive("server:error", {
      code: "VEHICLE_TOO_FAR",
      message: "Too far",
      requestType: "vehicle:enter",
      vehicleId: "cybertruck-1",
      revision: 0,
    });
  }
  assert.equal(socket.sent.filter((m) => m.type === "vehicle:enter").length, 2);
  for (let i = 0; i < 21; i++) h.tick();
  h.session.requestEnter();
  assert.equal(socket.sent.filter((m) => m.type === "vehicle:enter").length, 3);
  h.session.stop();
});

test("character snapshots validate fixed appearances and normalize legacy custom players", () => {
  const parse = (p) => protocol.parseServerMessage(wire("player:joined", { player: p }));
  assert.equal(parse(player("a")).payload.player.model, "custom");
  for (const model of ["person2", "person3", "ceo"]) {
    const fixed = { ...player("a"), model, appearance: null };
    assert.equal(parse(fixed).payload.player.model, model);
    assert.equal(parse({ ...fixed, appearance }), null);
  }
  for (const invalid of [
    { ...player("a"), model: "unknown" },
    { ...player("a"), model: null },
    { ...player("a"), appearance: null },
  ])
    assert.equal(parse(invalid), null);
});

test("fixed selection survives join, movement, reconnect and detects an incompatible backend", () => {
  const h = harness("Alice", { model: "person2", appearance: null });
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  assert.equal(socket.sent[0].payload.model, "person2");
  assert.equal(socket.sent[0].payload.appearance, null);
  socket.receive("world:init", {
    playerId: "a",
    players: [{ ...player("a"), model: "person2", appearance: null }],
  });
  h.session.setMovement({ position: { x: 1, y: 0, z: 0 }, rotation: 0, animation: "Walk" });
  h.tick();
  assert.equal(h.session.players.get("a").model, "person2");
  assert.equal("model" in socket.sent.at(-1).payload, false);
  socket.close();
  h.retry();
  h.sockets[1].open();
  assert.equal(h.sockets[1].sent[0].payload.model, "person2");
  h.sockets[1].receive("world:init", { playerId: "b", players: [player("b")] });
  assert.equal(h.statuses.at(-1).state, "error");
  assert.equal(h.session.playerId, null);
  h.session.stop();
});

test("fixed characters normalize height, map locomotion, restore rest pose and share only assets", () => {
  const appearanceModule = loadModule("../src/utils/appearance.ts", { require: () => THREE });
  const { NetworkCharacters } = loadModule("../src/components/NetworkCharacters.ts", {
    require: (name) =>
      name === "three" ? THREE : name.includes("SkeletonUtils") ? skeletonUtils : appearanceModule,
  });
  const scene = new THREE.Scene();
  const template = new THREE.Group();
  const hip = new THREE.Group();
  hip.name = "Hips";
  const geometry = new THREE.BoxGeometry(1, 2, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x123456 });
  material.name = "Switchable shirt";
  hip.add(new THREE.Mesh(geometry, material));
  template.add(hip);
  const clip = new THREE.AnimationClip("Walking", 1, [
    new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 5, 0, 5]),
    new THREE.NumberKeyframeTrack("Hips.rotation[y]", [0, 1], [0, 1]),
  ]);
  const characters = new NetworkCharacters(scene, template, []);
  characters.addTemplate("ceo", template, [clip]);
  const fixed = (id, animation) => ({ ...player(id), model: "ceo", appearance: null, animation });
  const players = new Map([
    ["a", fixed("a", "Walk")],
    ["b", fixed("b", "Idle")],
  ]);
  characters.update(players, 0.5, "a");
  const a = characters.objects.get("a");
  const b = characters.objects.get("b");
  assert.equal(a.getObjectByName("Hips").position.x, 0);
  assert.ok(a.getObjectByName("Hips").rotation.y > 0);
  assert.equal(b.getObjectByName("Hips").rotation.y, 0);
  const bounds = new THREE.Box3().setFromObject(b);
  assert.ok(Math.abs(bounds.max.y - bounds.min.y - 1.6) < 1e-6);
  assert.ok(Math.abs(bounds.min.y) < 1e-6);
  let renderedMaterial;
  a.traverse((o) => {
    if (o.isMesh) renderedMaterial = o.material;
  });
  assert.equal(renderedMaterial.color.getHex(), material.color.getHex());
  players.set("a", fixed("a", "Idle"));
  characters.update(players, 0.1, "a");
  assert.equal(a.getObjectByName("Hips").rotation.y, 0);
  players.delete("a");
  characters.update(players, 0.1);
  assert.equal(characters.objects.size, 1);
  characters.dispose();
  geometry.dispose();
  material.dispose();
});

test("two-seat validation rejects duplicate, missing and unknown occupants and mismatched releases", () => {
  const both = { ...truck("a", 2), passengerId: "b" };
  const init = (vehicle) =>
    protocol.parseServerMessage(
      wire("world:init", {
        playerId: "a",
        players: [player("a"), player("b")],
        vehicles: [vehicle],
      }),
    );
  assert.ok(init(both));
  assert.ok(init({ ...both, driverId: null }));
  for (const passengerId of [undefined, "a", "missing"])
    assert.equal(init({ ...both, passengerId }), null);
  assert.equal(
    protocol.parseServerMessage(
      wire("vehicle:occupied", { vehicle: both, playerId: "a", seat: "passenger" }),
    ),
    null,
  );
  assert.equal(
    protocol.parseServerMessage(
      wire("vehicle:released", {
        vehicle: truck("a", 3),
        playerId: "b",
        seat: "passenger",
        reason: "exit",
        player: player("a"),
      }),
    ),
    null,
  );
});

test("passenger joins explicitly, follows reports, exits independently and resumes walking", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", {
    playerId: "a",
    players: [player("a"), player("b")],
    vehicles: [truck("b", 1)],
  });
  h.session.requestEnter("passenger");
  assert.equal(socket.sent.at(-1).payload.seat, "passenger");
  const both = { ...truck("b", 2), passengerId: "a" };
  socket.receive("vehicle:occupied", { vehicle: both, playerId: "a", seat: "passenger" });
  assert.equal(h.session.passenger, true);
  assert.equal(h.session.driving, false);
  h.session.setMovement({ position: { x: 0, y: 0, z: 0 }, rotation: 0, animation: "Run" });
  h.session.setVehicleMovement({ ...both, speed: 4 });
  h.tick();
  assert.equal(
    socket.sent.filter((m) => m.type === "vehicle:move" || m.type === "player:move").length,
    0,
  );
  socket.receive("vehicle:update", {
    vehicle: { ...both, position: { x: -30, y: 0, z: 0 }, speed: 4 },
    sequence: 0,
  });
  assert.equal(h.session.players.get("a").position.x, -30);
  assert.equal(h.session.requestExit({ x: -28, y: 0, z: 0 }, 0), false);
  socket.receive("vehicle:update", {
    vehicle: { ...both, position: { x: -30, y: 0, z: 0 } },
    sequence: 1,
  });
  assert.equal(h.session.requestExit({ x: -28, y: 0, z: 0 }, 0), true);
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:exit");
  socket.receive("vehicle:released", {
    vehicle: { ...truck("b", 3), position: { x: -30, y: 0, z: 0 } },
    playerId: "a",
    seat: "passenger",
    reason: "exit",
    player: { ...player("a"), position: { x: -28, y: 0, z: 0 } },
  });
  assert.equal(h.session.inVehicle, false);
  assert.equal(h.session.releaseVersion, 1);
  assert.equal(h.session.vehicle.driverId, "b");
  h.session.setMovement({ position: { x: -27, y: 0, z: 0 }, rotation: 0, animation: "Walk" });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "player:move");
  h.session.stop();
});

test("passenger transition preserves pending driver exit and requires a new stopped acknowledgement", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive("world:init", {
    playerId: "a",
    players: [player("a"), player("b")],
    vehicles: [truck("a", 1)],
  });
  h.tick();
  socket.receive("vehicle:update", { vehicle: truck("a", 1), sequence: 0 });
  h.session.requestExit({ x: -33, y: 0, z: 0 }, 0);
  const both = { ...truck("a", 2), passengerId: "b" };
  socket.receive("vehicle:occupied", { vehicle: both, playerId: "b", seat: "passenger" });
  assert.equal(h.session.vehiclePending, true);
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:move");
  assert.equal(socket.sent.at(-1).payload.sequence, 0);
  assert.equal(socket.sent.at(-1).payload.revision, 2);
  assert.equal("passengerId" in socket.sent.at(-1).payload, false);
  socket.receive("vehicle:update", { vehicle: truck("a", 1), sequence: 99 });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:move");
  socket.receive("server:error", {
    code: "STALE_VEHICLE_REVISION",
    message: "Old epoch",
    requestType: "vehicle:move",
    revision: 2,
  });
  assert.equal(h.session.vehiclePending, true);
  socket.receive("vehicle:update", { vehicle: both, sequence: 0 });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:exit");
  assert.equal(socket.sent.at(-1).payload.revision, 2);
  h.session.stop();
});

test("driver disconnect retains passenger, passenger disconnect retains moving driver and resets epoch", () => {
  for (const own of ["a", "b"]) {
    const h = harness();
    h.session.start();
    const socket = h.sockets[0];
    socket.open();
    const both = { ...truck("a", 2), passengerId: "b", speed: 4 };
    socket.receive("world:init", {
      playerId: own,
      players: [player("a"), player("b")],
      vehicles: [both],
    });
    h.tick();
    if (own === "b") {
      socket.receive("vehicle:released", {
        vehicle: { ...both, driverId: null, speed: 0, revision: 3 },
        playerId: "a",
        seat: "driver",
        reason: "disconnect",
        player: null,
      });
      socket.receive("player:left", { id: "a" });
      assert.equal(h.session.passenger, true);
      assert.equal(h.session.driving, false);
      assert.equal(h.session.releaseVersion, 0);
      assert.equal(h.session.vehicle.speed, 0);
    } else {
      socket.receive("vehicle:released", {
        vehicle: { ...both, passengerId: null, revision: 3 },
        playerId: "b",
        seat: "passenger",
        reason: "disconnect",
        player: null,
      });
      socket.receive("player:left", { id: "b" });
      h.tick();
      assert.equal(h.session.driving, true);
      assert.equal(h.session.vehicle.speed, 4);
      assert.equal(socket.sent.at(-1).payload.sequence, 0);
      assert.equal(socket.sent.at(-1).payload.revision, 3);
    }
    h.session.stop();
  }
});

test("passenger controller ignores throttle and steering, rejects moving or blocked exits", () => {
  const { VehicleController } = loadModule("../src/vehicles/VehicleController.ts", {
    require: () => THREE,
  });
  const world = new THREE.Group(),
    root = new THREE.Group();
  root.name = "Cybertruck_drive_control";
  world.add(root);
  for (let i = 0; i < 4; i++) {
    const wheel = new THREE.Group();
    wheel.name = "wheel_spin_" + i;
    root.add(wheel);
  }
  const controller = new VehicleController(world);
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.open();
  const both = { ...truck("b", 2), passengerId: "a", speed: 4 };
  socket.receive("world:init", {
    playerId: "a",
    players: [player("a"), player("b")],
    vehicles: [both],
  });
  const physics = {
    setTruck: () => {},
    findExit: () => null,
    canDrive: () => {
      throw new Error("Passenger must not simulate driving");
    },
  };
  controller.update(h.session, physics, 1, 1, 0.05);
  h.tick();
  assert.equal(h.session.vehicle.speed, 4);
  assert.equal(h.session.vehicle.steering, 0);
  controller.interact(h.session, physics);
  assert.match(h.session.vehicleError, /driver to stop/);
  socket.receive("vehicle:update", { vehicle: { ...both, speed: 0 }, sequence: 0 });
  controller.interact(h.session, physics);
  assert.match(h.session.vehicleError, /No safe place/);
  assert.equal(h.session.vehiclePending, false);
  controller.interact(h.session, { ...physics, findExit: () => ({ x: -33, y: 0, z: 0 }) });
  h.tick();
  assert.equal(socket.sent.at(-1).type, "vehicle:exit");
  assert.equal(socket.sent.filter((m) => m.type === "vehicle:move").length, 0);
  h.session.stop();
});
