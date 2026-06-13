/**
 * NEXUS Chat — fully persistent across navigation.
 *
 * All message state lives in the global Zustand store (store.ts) so switching
 * views NEVER resets the conversation or kills a mid-task response.
 *
 * - Navigate away mid-task → task keeps running in background
 * - Come back → full conversation history intact, response appears when done
 * - Auto-scroll only fires if already at bottom — manual scroll never interrupted
 */
import { useEffect, useRef, useCallback } from "react";
import { runAgent } from "../lib/agentRunner";
import { inTauri } from "../lib/live";
import { useNexus, nextChatId, type ChatMsg } from "../state/store";

const SUGGESTIONS = [
  "Status report — how are the traders doing?",
  "Pause the brain",
  "Resume the brain",
  "Boost night_watch",
  "Summarise today's ScalperX learnings from the vault",
];

// Single shared task ref — survives component unmount/remount
// because it lives in module scope, not component scope.
let globalTaskRef: Promise<void> | null = null;

export default function ChatNexus({ embedded = false }: { embedded?: boolean }) {
  const msgs        = useNexus((s) => s.chatMsgs);
  const busy        = useNexus((s) => s.chatBusy);
  const history     = useNexus((s) => s.chatHistory);
  const pushMsg     = useNexus((s) => s.pushChatMsg);
  const setBusy     = useNexus((s) => s.setChatBusy);
  const pushHistory = useNexus((s) => s.pushChatHistory);

  const inputRef       = useRef<HTMLInputElement>(null);
  const logRef         = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // ── tool-event stream (Tauri only) ──────────────────────────────────────
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ worker_id: string; phase: string; text: string }>(
        "agent-event", ({ payload: p }) => {
          if (p.worker_id !== "nexus" || p.phase !== "tool") return;
          // tool calls shown as small dim messages — same as original style
          pushMsg({ id: nextChatId(), role: "tool", text: p.text, timestamp: "" });
        });
    })();
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── smart auto-scroll ───────────────────────────────────────────────────
  useEffect(() => {
    const el = logRef.current;
    if (!el || userScrolledUp.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    userScrolledUp.current = (el.scrollHeight - el.scrollTop - el.clientHeight) > 60;
  }, []);

  // ── send ────────────────────────────────────────────────────────────────
  async function send(text?: string) {
    const q = (text ?? inputRef.current?.value ?? "").trim();
    if (!q || busy) return;
    if (inputRef.current) inputRef.current.value = "";

    const userMsg: ChatMsg = { id: nextChatId(), role: "user", text: q, timestamp: "" };
    pushMsg(userMsg);
    setBusy(true, "processing");
    userScrolledUp.current = false;

    // store task in module-level ref so it outlives component unmount
    globalTaskRef = (async () => {
      try {
        const ctx = history.slice(-6)
          .map((h) => `${h.role.toUpperCase()}: ${h.text}`)
          .join("\n");
        const task = ctx ? `Recent conversation:\n${ctx}\n\nUSER: ${q}` : q;
        const res = await runAgent("nexus", task);
        const reply = res.output || "(done)";
        pushMsg({ id: nextChatId(), role: "nexus", text: reply, timestamp: "" });
        pushHistory("user", q);
        pushHistory("nexus", reply.slice(0, 400));
      } catch (e) {
        pushMsg({ id: nextChatId(), role: "error", text: String(e), timestamp: "" });
      } finally {
        setBusy(false);
        globalTaskRef = null;
      }
    })();

    await globalTaskRef;
  }

  // ── render ───────────────────────────────────────────────────────────────
  if (!inTauri()) {
    return (
      <section className={`panel chat-panel ${embedded ? "chat-embedded" : ""}`}>
        <div className="floor-empty">NEXUS needs the desktop app (Keychain + vault access).</div>
      </section>
    );
  }

  const panel = (
    <section className={`panel chat-panel ${embedded ? "chat-embedded" : ""}`}>
      {embedded && <h4 className="chat-title">◈ NEXUS</h4>}

      <div className="chat-log" ref={logRef} onScroll={handleScroll}>
        {msgs.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.role === "nexus" && <span className="chat-tag">◈ NEXUS</span>}
            {m.role === "user"  && <span className="chat-tag you">YOU</span>}
            {m.role === "tool"  && <span className="chat-tag tool">⚙</span>}
            <p>{m.text}</p>
          </div>
        ))}
        {busy && (
          <div className="chat-msg nexus">
            <span className="chat-tag">◈ NEXUS</span>
            <p className="chat-thinking">processing<span className="dots">…</span></p>
          </div>
        )}
      </div>

      <div className="chat-suggest">
        {(embedded ? SUGGESTIONS.slice(0, 2) : SUGGESTIONS).map((s) => (
          <button key={s} className="ghost" disabled={busy} onClick={() => void send(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="chat-input row">
        <input
          ref={inputRef}
          autoFocus={!embedded}
          placeholder={embedded ? "Ask Nexus…" : "Talk to Nexus — status, vault questions, brain commands…"}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          disabled={busy}
        />
        <button
          disabled={busy}
          onClick={() => void send()}
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </section>
  );

  return embedded ? panel : <main className="chat-wrap">{panel}</main>;
}
