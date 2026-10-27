import { useEffect, useState, useSyncExternalStore } from "react";
import { Notification } from "../utils/notifications";
import type { MultiplayerSession } from "../network/MultiplayerSession";

export default function ChatInput({
  session,
  connected,
}: {
  session: MultiplayerSession;
  connected: boolean;
}) {
  const { error } = useSyncExternalStore(session.subscribeChat, session.getChatSnapshot);
  const [draft, setDraft] = useState("");
  const count = Array.from(draft.trim()).length;
  useEffect(() => {
    const notification = new Notification();
    if (error) notification.show(error, "error");
    return () => notification.dismiss();
  }, [error, session]);

  return (
    <section
      aria-label="World chat"
      className="absolute bottom-3 left-1/2 z-10 w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-xl bg-white/95 p-3 text-sm shadow-lg"
    >
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (session.sendChat(draft)) {
            setDraft("");
          }
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Chat message</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!connected}
            placeholder={connected ? "Type a message…" : "Waiting for connection…"}
            aria-describedby="chat-hint"
            className="w-full rounded border border-green-900/20 bg-white px-2 py-2 disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={!connected || count === 0 || count > 200}
          className="rounded bg-green-900 px-3 text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </form>
      <p id="chat-hint" className="mt-1 text-xs text-gray-500">
        {count}/200 · One message per second
      </p>
    </section>
  );
}
