import type { Appearance } from "../utils/appearance";
import {
  parseServerMessage,
  type ClientMessage,
  type CharacterSelection,
  type PlayerMovement,
  type PlayerState,
  type ChatMessage,
  type VehicleState,
  type Vector3,
} from "./protocol";

export type ConnectionStatus = {
  state: "connecting" | "connected" | "reconnecting" | "error";
  message: string;
  count: number;
};
type Movement = Omit<PlayerMovement, "sequence">;
export type ChatSnapshot = { messages: readonly ChatMessage[]; error: string | null };

/** Own one socket and one movement publish timer; reconnects create a fresh server-assigned identity. */
export class MultiplayerSession {
  readonly players = new Map<string, PlayerState>();
  playerId: string | null = null;
  vehicle: VehicleState | null = null;
  vehicleError: string | null = null;
  vehiclePending = false;
  releaseVersion = 0;
  private vehicleSequence = 0;
  private acceptedVehicleSequence = -1;
  private lastVehicle = "";
  private stoppedVehicleSequence = -1;
  private acceptedStoppedSequence = -1;
  private readonly walkingSends: number[] = [];
  private readonly vehicleSends: number[] = [];
  private readonly occupancySends: number[] = [];

  /** Rolling windows also cover timer jitter; walking and vehicle budgets are independent. */
  private hasMovementBudget(times: number[], limit = 20) {
    const now = performance.now();
    while (times.length && now - times[0] > 1000) times.shift();
    return times.length < limit;
  }
  private vehicleRequestAt = -Infinity;
  private queuedExit: { position: Vector3; rotation: number } | null = null;
  private serviceVehicles() {
    if (this.vehiclePending && performance.now() - this.vehicleRequestAt > 5000) {
      this.socket?.close();
      return;
    }
    this.flushVehicle();
    const v = this.vehicle;
    if (
      this.queuedExit &&
      v &&
      this.driving &&
      this.stoppedVehicleSequence >= 0 &&
      this.acceptedStoppedSequence === this.stoppedVehicleSequence &&
      this.lastVehicle === JSON.stringify(v) &&
      this.hasMovementBudget(this.occupancySends, 2)
    ) {
      if (
        this.send({
          type: "vehicle:exit",
          payload: { vehicleId: v.id, revision: v.revision, ...this.queuedExit },
        })
      ) {
        this.occupancySends.push(performance.now());
        this.queuedExit = null;
      }
    }
  }

  get driving() {
    return !!this.playerId && this.vehicle?.driverId === this.playerId;
  }

  requestEnter() {
    const v = this.vehicle;
    if (
      !this.playerId ||
      !v ||
      v.driverId ||
      this.vehiclePending ||
      !this.hasMovementBudget(this.occupancySends, 2)
    )
      return;
    if (this.send({ type: "vehicle:enter", payload: { vehicleId: v.id, revision: v.revision } })) {
      this.occupancySends.push(performance.now());
      this.vehiclePending = true;
      this.vehicleRequestAt = performance.now();
      this.vehicleError = null;
    }
  }

  requestExit(position: Vector3, rotation: number) {
    const v = this.vehicle;
    if (!v || !this.driving || v.speed !== 0 || this.vehiclePending) return false;
    // The publish timer sends the final stopped state before exit, without exceeding 20 Hz.
    this.queuedExit = { position: { ...position }, rotation };
    this.vehiclePending = true;
    this.vehicleRequestAt = performance.now();
    this.vehicleError = null;
    return true;
  }

  setVehicleMovement(state: VehicleState) {
    if (!this.driving || !this.vehicle || state.revision !== this.vehicle.revision) return;
    this.vehicle = { ...state, position: { ...state.position } };
    this.syncDriver();
  }

  private syncDriver() {
    const v = this.vehicle;
    if (!v?.driverId) return;
    const player = this.players.get(v.driverId);
    if (player)
      this.players.set(player.id, {
        ...player,
        position: { ...v.position },
        rotation: v.rotation,
        animation: "Idle",
      });
  }

  private flushVehicle() {
    const v = this.vehicle;
    if (!v || !this.driving || !this.hasMovementBudget(this.vehicleSends)) return;
    const serialized = JSON.stringify(v);
    if (serialized === this.lastVehicle) return;
    const state = {
      revision: v.revision,
      position: v.position,
      rotation: v.rotation,
      speed: v.speed,
      steering: v.steering,
      wheelAngle: v.wheelAngle,
    };
    if (
      this.send({
        type: "vehicle:move",
        payload: { ...state, vehicleId: v.id, sequence: this.vehicleSequence },
      })
    ) {
      this.vehicleSends.push(performance.now());
      this.stoppedVehicleSequence = v.speed === 0 ? this.vehicleSequence : -1;
      this.vehicleSequence++;
      this.lastVehicle = serialized;
    }
  }

  private resetVehicle() {
    this.queuedExit = null;
    this.vehicle = null;
    this.vehiclePending = false;
    this.vehicleError = null;
    this.vehicleSequence = 0;
    this.acceptedVehicleSequence = -1;
    this.stoppedVehicleSequence = -1;
    this.acceptedStoppedSequence = -1;
    this.vehicleSends.length = 0;
    this.lastVehicle = "";
  }
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private rejected = false;
  private attempts = 0;
  private sequence = 0;
  private movement: Movement | null = null;
  private lastMovement = "";
  private readonly remoteSequences = new Map<string, number>();
  private readonly url: string;
  private readonly name: string;
  private readonly selection: CharacterSelection;
  private readonly notify: (status: ConnectionStatus) => void;
  private chat: ChatSnapshot = { messages: [], error: null };
  private readonly chatListeners = new Set<() => void>();
  private lastChatSent = -Infinity;

  getChatSnapshot = (): ChatSnapshot => this.chat;
  subscribeChat = (listener: () => void) => {
    this.chatListeners.add(listener);
    return () => {
      this.chatListeners.delete(listener);
    };
  };

  private updateChat(update: Partial<ChatSnapshot>) {
    this.chat = { ...this.chat, ...update };
    for (const listener of this.chatListeners) listener();
  }

  /** Sender identity and timestamps are supplied only by the accepted server broadcast. */
  sendChat(text: string): boolean {
    const trimmed = text.trim();
    if (!this.playerId || this.socket?.readyState !== WebSocket.OPEN) {
      this.updateChat({ error: "Join the world before sending messages." });
      return false;
    }
    if (!trimmed || Array.from(trimmed).length > 200) {
      this.updateChat({ error: "Enter a message of 1–200 characters." });
      return false;
    }
    if (performance.now() - this.lastChatSent < 1000) {
      this.updateChat({ error: "Wait one second between messages." });
      return false;
    }
    if (!this.send({ type: "chat:send", payload: { text: trimmed } })) {
      this.updateChat({ error: "Message could not be sent. Please try again." });
      return false;
    }
    this.lastChatSent = performance.now();
    this.updateChat({ error: null });
    return true;
  }

  constructor(
    url: string,
    name: string,
    appearance: Appearance | CharacterSelection,
    notify: (status: ConnectionStatus) => void,
  ) {
    this.url = url;
    this.name = name.trim();
    this.selection =
      "model" in appearance
        ? appearance.model === "custom"
          ? { model: "custom", appearance: { ...appearance.appearance } }
          : { model: appearance.model, appearance: null }
        : { model: "custom", appearance: { ...appearance } };
    this.notify = notify;
  }

  start() {
    if (this.timer || this.stopped) return;
    if (!this.name || this.name.length > 24) {
      this.status("error", "Player name must contain 1-24 characters.");
      return;
    }
    this.connect();
    // Publish only changed local states at the documented maximum of 20 Hz.
    this.timer = setInterval(() => {
      this.serviceVehicles();
      this.flushMovement();
    }, 50);
  }

  /** Copy local simulation output so later frame mutations cannot change a queued payload. */
  setMovement(movement: Movement) {
    if (
      this.driving ||
      !this.playerId ||
      ![movement.position.x, movement.position.y, movement.position.z, movement.rotation].every(
        Number.isFinite,
      ) ||
      !["Idle", "Walk", "Run"].includes(movement.animation)
    )
      return;
    const player = this.players.get(this.playerId);
    if (!player) return;
    this.movement = { ...movement, position: { ...movement.position } };
    this.players.set(this.playerId, { ...player, ...this.movement });
  }

  private status(state: ConnectionStatus["state"], message: string) {
    this.notify({ state, message, count: this.players.size });
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      const data = JSON.stringify(message);
      if (
        new TextEncoder().encode(data).byteLength > 4096 ||
        (this.socket.bufferedAmount ?? 0) > 65536
      )
        return false;
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private flushMovement() {
    if (
      this.driving ||
      !this.hasMovementBudget(this.walkingSends) ||
      !this.playerId ||
      !this.movement ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    const serialized = JSON.stringify(this.movement);
    if (serialized === this.lastMovement) return;
    const sequence = this.sequence + 1;
    if (this.send({ type: "player:move", payload: { ...this.movement, sequence } })) {
      this.walkingSends.push(performance.now());
      this.sequence = sequence;
      this.lastMovement = serialized;
    }
  }

  private connect() {
    if (this.stopped) return;
    this.rejected = false;
    this.status(
      this.attempts ? "reconnecting" : "connecting",
      this.attempts ? "Reconnecting…" : "Connecting…",
    );
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.status("error", "Invalid WebSocket URL. Check VITE_WS_URL.");
      return;
    }
    this.socket = socket;
    // A connection that never initializes must not leave the player stuck forever.
    this.timeout = setTimeout(() => socket.close(), 10000);
    socket.onopen = () => {
      this.sequence = 0;
      this.walkingSends.length = 0;
      this.occupancySends.length = 0;
      this.lastMovement = "";
      this.movement = null;
      this.remoteSequences.clear();
      this.send({ type: "player:join", payload: { name: this.name, ...this.selection } });
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.stopped || this.rejected) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "world:init": {
          if (this.playerId) return;
          const own = message.payload.players.find(
            (player) => player.id === message.payload.playerId,
          );
          if (own?.model !== this.selection.model) {
            this.rejected = true;
            this.status(
              "error",
              "The backend did not accept this character. Update the backend or choose Custom.",
            );
            socket.close();
            return;
          }
          clearTimeout(this.timeout);
          this.players.clear();
          for (const player of message.payload.players) this.players.set(player.id, player);
          this.playerId = message.payload.playerId;
          this.resetVehicle();
          this.vehicle = message.payload.vehicles?.[0] ?? null;
          this.syncDriver();
          this.attempts = 0;
          this.lastChatSent = -Infinity;
          this.updateChat({ error: null });
          this.status("connected", "Connected");
          break;
        }
        case "vehicle:occupied":
        case "vehicle:released": {
          if (!this.playerId) return;
          const v = message.payload.vehicle;
          if (!this.vehicle || v.revision <= this.vehicle.revision) return;
          const previousDriver = this.vehicle.driverId;
          if (message.type === "vehicle:occupied" && !this.players.has(v.driverId!)) return;
          if (
            message.type === "vehicle:released" &&
            message.payload.player &&
            message.payload.player.id !== previousDriver
          )
            return;
          this.vehicle = v;
          this.vehicleSequence = 0;
          this.acceptedVehicleSequence = -1;
          this.stoppedVehicleSequence = -1;
          this.acceptedStoppedSequence = -1;
          this.lastVehicle = "";
          this.queuedExit = null;
          this.vehiclePending = false;
          this.vehicleError = null;
          this.movement = null;
          this.lastMovement = "";
          if (message.type === "vehicle:released" && message.payload.player) {
            this.players.set(message.payload.player.id, message.payload.player);
            if (message.payload.player.id === this.playerId) this.releaseVersion++;
          }
          this.syncDriver();
          break;
        }
        case "vehicle:update": {
          if (!this.playerId || !this.vehicle) return;
          const { vehicle: v, sequence } = message.payload;
          if (v.revision < this.vehicle.revision) return;
          if (v.revision > this.vehicle.revision) {
            socket.close();
            return;
          }
          if (v.driverId !== this.vehicle.driverId || sequence <= this.acceptedVehicleSequence)
            return;
          this.acceptedVehicleSequence = sequence;
          this.acceptedStoppedSequence = v.speed === 0 ? sequence : -1;
          // Echoes acknowledge prediction; older reports must never rewind the local driver.
          if (!this.driving) {
            this.vehicle = v;
            this.syncDriver();
          }
          break;
        }
        case "player:joined":
          if (!this.playerId) return;
          if (this.players.has(message.payload.player.id)) return;
          this.players.set(message.payload.player.id, message.payload.player);
          this.status("connected", "Connected");
          break;
        case "player:update": {
          const update = message.payload;
          if (
            update.id === this.playerId ||
            update.id === this.vehicle?.driverId ||
            update.sequence <= (this.remoteSequences.get(update.id) ?? -1)
          )
            return;
          const player = this.players.get(update.id);
          if (player) this.remoteSequences.set(update.id, update.sequence);
          if (player)
            this.players.set(update.id, {
              ...player,
              position: update.position,
              rotation: update.rotation,
              animation: update.animation,
            });
          break;
        }
        case "player:left":
          this.players.delete(message.payload.id);
          this.remoteSequences.delete(message.payload.id);
          this.status("connected", "Connected");
          break;
        case "server:error":
          if (
            this.playerId &&
            !this.driving &&
            message.payload.code === "RATE_LIMITED" &&
            (!message.payload.requestType || message.payload.requestType === "player:move")
          ) {
            // Retry the latest state so a rejected final Idle cannot leave remote players walking.
            this.lastMovement = "";
          }
          if (
            this.playerId &&
            this.driving &&
            message.payload.requestType === "vehicle:move" &&
            message.payload.code === "RATE_LIMITED"
          ) {
            // Retry the latest prediction after the rolling budget recovers; never exit on a rejected stop.
            this.lastVehicle = "";
            this.acceptedStoppedSequence = -1;
          }
          if (
            this.playerId &&
            (message.payload.requestType?.startsWith("vehicle:") ||
              /VEHICLE|DRIVING|EXIT_POSITION/.test(message.payload.code) ||
              (this.vehiclePending && message.payload.code === "RATE_LIMITED"))
          ) {
            this.queuedExit = null;
            this.vehiclePending = false;
            this.vehicleError = message.payload.message;
            if (
              message.payload.code === "STALE_VEHICLE_REVISION" ||
              message.payload.code === "NOT_VEHICLE_DRIVER" ||
              message.payload.code === "INVALID_VEHICLE_STATE"
            )
              socket.close();
            break;
          }
          // Rejected chat/movement must not evict an already joined player from the world.
          if (this.playerId && message.payload.code !== "ROOM_FULL") {
            this.updateChat({ error: `${message.payload.code}: ${message.payload.message}` });
            break;
          }
          this.rejected = true;
          this.playerId = null;
          this.players.clear();
          this.status("error", `${message.payload.code}: ${message.payload.message}`);
          socket.close();
          break;
        case "chat:message": {
          if (!this.playerId || this.chat.messages.some((item) => item.id === message.payload.id))
            return;
          // Keep a stable, bounded snapshot separate from the mutable Three.js player map.
          const messages = [...this.chat.messages, message.payload]
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-100);
          this.updateChat({ messages });
          break;
        }
      }
    };
    socket.onerror = () => {
      /* close handles retries without opening a second socket. */
    };
    socket.onclose = () => {
      clearTimeout(this.timeout);
      this.playerId = null;
      this.resetVehicle();
      this.players.clear();
      this.movement = null;
      this.lastMovement = "";
      this.remoteSequences.clear();
      if (this.stopped || this.rejected) return;
      this.updateChat({ error: "Disconnected. Messages cannot be sent until you reconnect." });
      this.status("reconnecting", "Disconnected. Reconnecting…");
      this.retry = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempts++, 10000));
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
      this.socket.close();
    }
    this.resetVehicle();
    this.players.clear();
    this.remoteSequences.clear();
    this.movement = null;
    this.playerId = null;
  }
}
