import type { Appearance } from "../utils/appearance";
import {
  parseServerMessage,
  type ClientMessage,
  type PlayerMovement,
  type PlayerState,
  type ChatMessage,
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
  private readonly appearance: Appearance;
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
    appearance: Appearance,
    notify: (status: ConnectionStatus) => void,
  ) {
    this.url = url;
    this.name = name;
    this.appearance = { ...appearance };
    this.notify = notify;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.connect();
    // Publish only changed local states at the documented maximum of 20 Hz.
    this.timer = setInterval(() => this.flushMovement(), 50);
  }

  /** Copy local simulation output so later frame mutations cannot change a queued payload. */
  setMovement(movement: Movement) {
    if (
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
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private flushMovement() {
    if (!this.playerId || !this.movement || this.socket?.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(this.movement);
    if (serialized === this.lastMovement) return;
    const sequence = this.sequence + 1;
    if (this.send({ type: "player:move", payload: { ...this.movement, sequence } })) {
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
      this.lastMovement = "";
      this.movement = null;
      this.remoteSequences.clear();
      this.send({ type: "player:join", payload: { name: this.name, appearance: this.appearance } });
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.stopped || this.rejected) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "world:init": {
          if (this.playerId) return;
          clearTimeout(this.timeout);
          this.players.clear();
          for (const player of message.payload.players) this.players.set(player.id, player);
          this.playerId = message.payload.playerId;
          this.attempts = 0;
          this.lastChatSent = -Infinity;
          this.updateChat({ error: null });
          this.status("connected", "Connected");
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
    this.players.clear();
    this.remoteSequences.clear();
    this.movement = null;
    this.playerId = null;
  }
}
