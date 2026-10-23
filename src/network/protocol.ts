import type { Appearance } from "../utils/appearance";

export type Vector3 = { x: number; y: number; z: number };
export type AnimationState = "Idle" | "Walk" | "Run";
export type PlayerState = {
  id: string;
  name: string;
  appearance: Appearance;
  position: Vector3;
  rotation: number;
  animation: AnimationState;
};
export type PlayerMovement = {
  sequence: number;
  position: Vector3;
  rotation: number;
  animation: AnimationState;
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
  | { type: "world:init"; payload: { playerId: string; players: PlayerState[] } }
  | { type: "player:joined"; payload: { player: PlayerState } }
  | {
      type: "player:update";
      payload: Pick<PlayerState, "id" | "position" | "rotation" | "animation"> & {
        sequence: number;
      };
    }
  | { type: "player:left"; payload: { id: string } }
  | { type: "chat:message"; payload: ChatMessage }
  | { type: "server:error"; payload: { code: string; message: string } };
export type ClientMessage =
  | { type: "player:join"; payload: { name: string; appearance: Appearance } }
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
  if (
    !record(value) ||
    !id(value.id) ||
    typeof value.name !== "string" ||
    !record(value.appearance)
  )
    return false;
  const a = value.appearance;
  return (
    (a.shirt === 0 || a.shirt === 1 || a.shirt === 2) &&
    (a.pants === 0 || a.pants === 1) &&
    (a.hairstyle === 0 || a.hairstyle === 1) &&
    (a.glasses === 0 || a.glasses === 1) &&
    transform(value)
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
    case "player:left":
      valid = id(p.id);
      break;
    case "server:error":
      valid = id(p.code) && typeof p.message === "string";
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
