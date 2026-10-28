import type { Appearance } from "../utils/appearance";

export type CharacterModel = "custom" | "person2" | "person3" | "ceo";
export type CharacterSelection =
  | { model: "custom"; appearance: Appearance }
  | { model: "person2" | "person3" | "ceo"; appearance: null };
export type Vector3 = { x: number; y: number; z: number };
export type AnimationState = "Idle" | "Walk" | "Run";
export type PlayerState = {
  id: string;
  name: string;
  position: Vector3;
  rotation: number;
  animation: AnimationState;
} & CharacterSelection;
export type PlayerMovement = {
  sequence: number;
  position: Vector3;
  rotation: number;
  animation: AnimationState;
};
export type VehicleSeat = "driver" | "passenger";
export type VehicleTransition = { vehicle: VehicleState; playerId: string; seat: VehicleSeat };
export type VehicleState = {
  id: "cybertruck-1";
  driverId: string | null;
  passengerId: string | null;
  revision: number;
  position: Vector3;
  rotation: number;
  speed: number;
  steering: number;
  wheelAngle: number;
};
export type VehicleMovement = Omit<VehicleState, "id" | "driverId" | "passengerId"> & {
  vehicleId: "cybertruck-1";
  sequence: number;
};
export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
};
export type ChatSendPayload = { text: string };
export type ServerMessage =
  | { type: "vehicle:occupied"; payload: VehicleTransition }
  | { type: "vehicle:update"; payload: { vehicle: VehicleState; sequence: number } }
  | {
      type: "vehicle:released";
      payload: VehicleTransition &
        ({ player: PlayerState; reason: "exit" } | { player: null; reason: "disconnect" });
    }
  | {
      type: "world:init";
      payload: { playerId: string; players: PlayerState[]; vehicles?: VehicleState[] };
    }
  | { type: "player:joined"; payload: { player: PlayerState } }
  | {
      type: "player:update";
      payload: Pick<PlayerState, "id" | "position" | "rotation" | "animation"> & {
        sequence: number;
      };
    }
  | { type: "player:left"; payload: { id: string } }
  | { type: "chat:message"; payload: ChatMessage }
  | {
      type: "server:error";
      payload: {
        code: string;
        message: string;
        requestType?: string;
        vehicleId?: string;
        revision?: number;
      };
    };
export type ClientMessage =
  | {
      type: "vehicle:enter";
      payload: { vehicleId: "cybertruck-1"; revision: number; seat: VehicleSeat };
    }
  | { type: "vehicle:move"; payload: VehicleMovement }
  | {
      type: "vehicle:exit";
      payload: { vehicleId: "cybertruck-1"; revision: number; position: Vector3; rotation: number };
    }
  | { type: "player:join"; payload: { name: string } & CharacterSelection }
  | { type: "player:move"; payload: PlayerMovement }
  | { type: "chat:send"; payload: ChatSendPayload };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function transform(value: Record<string, unknown>) {
  return (
    record(value.position) &&
    finite(value.position.x) &&
    finite(value.position.y) &&
    finite(value.position.z) &&
    finite(value.rotation) &&
    (value.animation === "Idle" || value.animation === "Walk" || value.animation === "Run")
  );
}
function player(value: unknown): value is PlayerState {
  if (!record(value) || !id(value.id) || typeof value.name !== "string" || !transform(value))
    return false;
  if (value.model === "person2" || value.model === "person3" || value.model === "ceo")
    return value.appearance === null;
  if (value.model !== undefined && value.model !== "custom") return false;
  if (!record(value.appearance)) return false;
  const a = value.appearance;
  const valid =
    (a.shirt === 0 || a.shirt === 1 || a.shirt === 2) &&
    (a.pants === 0 || a.pants === 1) &&
    (a.hairstyle === 0 || a.hairstyle === 1) &&
    (a.glasses === 0 || a.glasses === 1);
  // Normalize legacy custom snapshots before they enter the player map.
  if (valid) value.model = "custom";
  return valid;
}
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function vehicle(value: unknown): value is VehicleState {
  if (!record(value) || !record(value.position)) return false;
  const p = value.position;
  return (
    value.id === "cybertruck-1" &&
    (value.driverId === null || id(value.driverId)) &&
    (value.passengerId === null || id(value.passengerId)) &&
    (value.driverId === null || value.driverId !== value.passengerId) &&
    integer(value.revision) &&
    finite(p.x) &&
    finite(p.y) &&
    finite(p.z) &&
    p.x >= -70 &&
    p.x <= 72 &&
    p.y >= -2 &&
    p.y <= 25 &&
    p.z >= -70 &&
    p.z <= 70 &&
    finite(value.rotation) &&
    finite(value.speed) &&
    value.speed >= -4 &&
    value.speed <= 10 &&
    finite(value.steering) &&
    Math.abs(value.steering) <= Math.PI / 6 &&
    finite(value.wheelAngle) &&
    (value.driverId !== null || (value.speed === 0 && value.steering === 0))
  );
}
/** Reject malformed and unknown wire messages before they can reach scene state. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!record(value) || !record(value.payload)) return null;
  const p = value.payload;
  let valid = false;
  switch (value.type) {
    case "world:init":
      valid =
        id(p.playerId) &&
        Array.isArray(p.players) &&
        p.players.length <= 5 &&
        p.players.every(player) &&
        (p.vehicles === undefined ||
          (Array.isArray(p.vehicles) &&
            p.vehicles.length === 1 &&
            p.vehicles.every(vehicle) &&
            p.vehicles.every((v) =>
              [v.driverId, v.passengerId].every(
                (occupant) =>
                  occupant === null ||
                  (p.players as PlayerState[]).some((player) => player.id === occupant),
              ),
            ))) &&
        new Set(p.players.map((p) => p.id)).size === p.players.length &&
        p.players.some((player) => player.id === p.playerId);
      break;
    case "player:joined":
      valid = player(p.player);
      break;
    case "player:update":
      valid =
        id(p.id) &&
        transform(p) &&
        typeof p.sequence === "number" &&
        Number.isSafeInteger(p.sequence) &&
        p.sequence >= 0;
      break;
    case "vehicle:occupied":
      valid =
        vehicle(p.vehicle) &&
        id(p.playerId) &&
        (p.seat === "driver" || p.seat === "passenger") &&
        p.vehicle[p.seat === "driver" ? "driverId" : "passengerId"] === p.playerId;
      break;
    case "vehicle:update":
      valid = vehicle(p.vehicle) && p.vehicle.driverId !== null && integer(p.sequence);
      break;
    case "vehicle:released":
      valid =
        vehicle(p.vehicle) &&
        id(p.playerId) &&
        (p.seat === "driver" || p.seat === "passenger") &&
        p.vehicle[p.seat === "driver" ? "driverId" : "passengerId"] === null &&
        p.vehicle.driverId !== p.playerId &&
        p.vehicle.passengerId !== p.playerId &&
        ((p.reason === "exit" &&
          player(p.player) &&
          p.player.id === p.playerId &&
          p.player.animation === "Idle") ||
          (p.reason === "disconnect" && p.player === null));
      break;
    case "player:left":
      valid = id(p.id);
      break;
    case "server:error":
      valid =
        id(p.code) &&
        typeof p.message === "string" &&
        (p.requestType === undefined || id(p.requestType)) &&
        (p.vehicleId === undefined || p.vehicleId === "cybertruck-1") &&
        (p.revision === undefined || integer(p.revision));
      break;
    case "chat:message":
      valid =
        id(p.id) &&
        id(p.senderId) &&
        id(p.senderName) &&
        typeof p.text === "string" &&
        p.text.trim().length > 0 &&
        Array.from(p.text).length <= 200 &&
        typeof p.timestamp === "number" &&
        Number.isSafeInteger(p.timestamp) &&
        p.timestamp >= 0 &&
        p.timestamp <= 8640000000000000;
      break;
  }
  return valid ? (value as ServerMessage) : null;
}
