/**
 * ODYSSEUS — the self-hosted AI workspace, living inside Nexus Shell.
 * The shell manages the engine itself (start/stop/health via Rust child
 * process) and embeds the full UI — chat, agents, deep research, documents,
 * notes, calendar — with no terminal and no browser.
 */
import { useEffect, useRef, useState } from "react";
import { inTauri } from "../lib/live";
import { useNexus } from "../state/store";

type EngineState = "checking" | "stopped" | "starting" | "running" | "error";

const PATH_KEY = "nexus.odysseusPath";

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export default function OdysseusView() {
  const [state, setState] = useState<EngineState>("checking");
  const [path, setPath] = useState(
    () => localStorage.getItem(PATH_KEY) ?? "");
  const [msg, setMsg] = useState("");
  const [bootSecs, setBootSecs] = useState(0);
  const startedAt = useRef<number | null>(null);
  const settingsOpen = useNexus((s) => s.settingsOpen);
  const mountRef = useRef<HTMLDivElement>(null);

  /* ── native embed lifecycle: mount the child webview exactly over the
        module's content area, track it on resize, hide it the moment the
        user navigates away or an overlay opens ───────────────────────── */
  useEffect(() => {
    if (state !== "running" || settingsOpen) {
      void invoke("odysseus_embed_hide").catch(() => {});
      return;
    }
    let raf = 0;
    const place = () => {
      const el = mountRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      void invoke("odysseus_embed", {
        x: r.left, y: r.top, w: r.width, h: r.height,
      }).catch((e) => setMsg(String(e)));
    };
    // first placement after layout settles
    raf = requestAnimationFrame(place);
    const ro = new ResizeObserver(() => place());
    if (mountRef.current) ro.observe(mountRef.current);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", place);
      void invoke("odysseus_embed_hide").catch(() => {});
    };
  }, [state, settingsOpen]);

  // health poll — fast while starting, relaxed while running
  useEffect(() => {
    if (!inTauri()) return;
    let on = true;
    const tick = async () => {
      try {
        const s = await invoke<{ running: boolean; url: string }>("odysseus_status");
        if (!on) return;
        setState((prev) => {
          if (s.running) {
            startedAt.current = null;
            return "running";
          }
          if (prev === "starting") {
            if (startedAt.current) {
              setBootSecs(Math.floor((Date.now() - startedAt.current) / 1000));
            }
            return "starting";
          }
          return "stopped";
        });
      } catch {
        if (on) setState("stopped");
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  async function start() {
    setMsg("");
    setState("starting");
    startedAt.current = Date.now();
    setBootSecs(0);
    localStorage.setItem(PATH_KEY, path);
    try {
      const res = await invoke<string>("odysseus_start", { path });
      setMsg(res);
    } catch (e) {
      setState("error");
      setMsg(String(e));
    }
  }

  async function stop() {
    try {
      const res = await invoke<string>("odysseus_stop");
      setMsg(res);
      setState("stopped");
    } catch (e) { setMsg(String(e)); }
  }

  if (!inTauri()) {
    return (
      <main className="ody-wrap">
        <div className="panel floor-empty">ODYSSEUS needs the desktop app (engine management).</div>
      </main>
    );
  }

  return (
    <main className="ody-wrap">
      <div className="panel ody-bar">
        <span className="ody-title">⊹ ODYSSEUS</span>
        <span className={`conn-chip ${state === "running" ? "configured"
          : state === "error" ? "error" : "unconfigured"}`}>
          {state === "running" ? "● engine running"
            : state === "starting" ? `starting… ${bootSecs}s`
            : state === "checking" ? "checking" : state}
        </span>
        {state !== "running" ? (
          <>
            <input className="ody-path" value={path} spellCheck={false}
                   onChange={(e) => setPath(e.target.value)}
                   title="Odysseus install directory" />
            <button disabled={state === "starting"} onClick={() => void start()}>
              ▶ Start engine
            </button>
          </>
        ) : (
          <>
            <button className="ghost" onClick={() => void invoke("odysseus_embed_reload")}>↻ Reload</button>
            <button className="ghost" onClick={() => void invoke("odysseus_open_external")}>
              ↗ Browser
            </button>
            <button className="ghost danger" onClick={() => void stop()}>■ Stop</button>
          </>
        )}
        {msg && <span className="muted ody-msg">{msg}</span>}
      </div>

      {state === "running" ? (
        // the native Odysseus webview is mounted exactly over this element
        <div ref={mountRef} className="ody-frame panel ody-mount" />
      ) : (
        <div className="panel ody-idle">
          {state === "starting" ? (
            <>
              <p className="ody-big">Igniting the Odysseus engine…</p>
              <p className="muted">
                First boot can take ~20–60s while Python warms up. The workspace
                appears here the moment it answers.
              </p>
            </>
          ) : (
            <>
              <p className="ody-big">Engine offline</p>
              <p className="muted">
                Hit ▶ Start engine and the full Odysseus workspace — chat, agents,
                deep research, documents, notes, calendar — loads right here.
                Everything runs locally from <code>{path}</code>; nothing leaves
                this machine.
              </p>
            </>
          )}
        </div>
      )}
    </main>
  );
}
