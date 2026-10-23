import * as THREE from "three";
import type { MultiplayerSession } from "../network/MultiplayerSession";

type Bubble = { element: HTMLDivElement; expiresAt: number; height?: number };
const DISPLAY_MS = 6000;

/** Position plain-text DOM bubbles from Three.js transforms without rendering React each frame. */
export class CharacterChatBubbles {
  private readonly layer: HTMLDivElement;
  private readonly bubbles = new Map<string, Bubble>();
  private seen = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly position = new THREE.Vector3();
  private readonly bounds = new THREE.Box3();
  private readonly session: MultiplayerSession;

  constructor(container: HTMLElement, session: MultiplayerSession) {
    this.session = session;
    this.layer = document.createElement("div");
    this.layer.className = "character-chat-layer";
    this.layer.setAttribute("role", "log");
    this.layer.setAttribute("aria-label", "Character chat messages");
    this.layer.setAttribute("aria-live", "polite");
    container.appendChild(this.layer);
    // Consume only new server broadcasts; errors and expired messages must not replay history.
    this.unsubscribe = session.subscribeChat(() => {
      const { messages } = session.getChatSnapshot();
      for (const message of messages) {
        if (this.seen.has(message.id) || !session.players.has(message.senderId)) continue;
        const previous = this.bubbles.get(message.senderId);
        previous?.element.remove();
        const element = document.createElement("div");
        element.className = "character-chat-bubble";
        element.textContent = message.text;
        element.setAttribute("aria-label", `${message.senderName}: ${message.text}`);
        element.style.visibility = "hidden";
        this.layer.appendChild(element);
        this.bubbles.set(message.senderId, { element, expiresAt: performance.now() + DISPLAY_MS });
      }
      this.seen = new Set(messages.map((message) => message.id));
    });
  }

  update(
    camera: THREE.Camera,
    characters: ReadonlyMap<string, THREE.Object3D>,
    now = performance.now(),
  ) {
    camera.updateMatrixWorld();
    for (const [id, bubble] of this.bubbles) {
      const character = characters.get(id);
      if (now >= bubble.expiresAt || !this.session.players.has(id)) {
        bubble.element.remove();
        this.bubbles.delete(id);
        continue;
      }
      if (!character) {
        bubble.element.style.visibility = "hidden";
        continue;
      }
      character.updateWorldMatrix(true, true);
      character.getWorldPosition(this.position);
      // Measure once per message so accessories and authored model height fit below the bubble.
      if (bubble.height === undefined) {
        this.bounds.setFromObject(character);
        bubble.height = this.bounds.isEmpty() ? 2.2 : this.bounds.max.y - this.position.y + 0.25;
      }
      this.position.y += bubble.height;
      this.position.project(camera);
      const visible =
        this.position.z >= -1 &&
        this.position.z <= 1 &&
        Math.abs(this.position.x) <= 1 &&
        Math.abs(this.position.y) <= 1;
      bubble.element.style.visibility = visible ? "visible" : "hidden";
      if (visible) {
        bubble.element.style.left = `${(this.position.x * 0.5 + 0.5) * 100}%`;
        bubble.element.style.top = `${(-this.position.y * 0.5 + 0.5) * 100}%`;
      }
    }
  }

  dispose() {
    this.unsubscribe();
    this.bubbles.clear();
    this.seen.clear();
    this.layer.remove();
  }
}
