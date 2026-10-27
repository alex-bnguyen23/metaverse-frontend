import { Link, useLocation } from "react-router";
import { useEffect, useState } from "react";
import { Notification } from "../utils/notifications";
import type { ConnectionStatus, MultiplayerSession } from "../network/MultiplayerSession";
import type { Appearance } from "../utils/appearance";
import type { CharacterModel } from "../network/protocol";
import World from "../components/World";
import ChatInput from "../components/ChatInput";
// Reuse the look held by App when entering the explorable scene.
export default function WorldPage({
  appearance,
  model,
}: {
  appearance: Appearance;
  model: CharacterModel;
}) {
  const location = useLocation();
  const [session, setSession] = useState<MultiplayerSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({
    state: "connecting",
    message: "Connecting…",
    count: 0,
  });
  const [name] = useState(() => {
    const state: unknown = location.state;
    if (
      typeof state === "object" &&
      state !== null &&
      "name" in state &&
      typeof state.name === "string"
    )
      return state.name.trim().slice(0, 32) || "Player";
    try {
      return sessionStorage.getItem("osaka-player-name")?.trim().slice(0, 32) || "Player";
    } catch {
      return "Player";
    }
  });
  useEffect(() => {
    const notification = new Notification();
    if (status.state === "error") notification.show(status.message, "error");
    else if (status.state === "reconnecting") notification.show(status.message, "warning");
    return () => notification.dismiss();
  }, [status.state, status.message]);
  return (
    <>
      <main className="world-page">
        <World
          appearance={appearance}
          model={model}
          name={name}
          onStatus={setStatus}
          onSession={setSession}
        />
        {session && (
          <ChatInput key={name} session={session} connected={status.state === "connected"} />
        )}
        <Link className="back-link" to="/dress">
          &larr; Leave world
        </Link>
        <div role="status" className="absolute right-5 top-5 rounded-lg bg-white/90 px-4 py-3">
          {status.message} · {status.count}/5 players
        </div>
      </main>
    </>
  );
}
