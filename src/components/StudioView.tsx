/**
 * STUDIO — the old NEXUS app's Portfolio, Tasks, Ideas and Forge modules,
 * merged into one area and rebuilt for Nexus Shell:
 *   PORTFOLIO  every strategy's live .poolside state + kill-switch banner
 *   TASKS      SQLite-backed task board (status + priority)
 *   IDEAS      the SAME markdown store as the old app — your ideas carry over
 *   FORGE      AI creation engine with modes, skills bridge, save-to-vault
 */
import { useEffect, useState } from "react";
import { inTauri, vaultPath } from "../lib/live";
import {
  tasksList, tasksAdd, tasksSetStatus, tasksDelete, type StudioTask,
} from "../lib/db";
import { runAgent } from "../lib/agentRunner";

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

type Tab = "portfolio" | "tasks" | "ideas" | "forge";

/* ── PORTFOLIO ──────────────────────────────────────────────────────────── */

function num(v: unknown, dflt = 0): number {
  return typeof v === "number" && isFinite(v) ? v : dflt;
}

function PortfolioPanel() {
  const [s, setS] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    let on = true;
    const tick = async () => {
      try {
        const d = await invoke<Record<string, any>>("portfolio_states", { path: vaultPath() });
        if (on) setS(d);
      } catch { /* vault offline */ }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 8000);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  if (!s) return <p className="muted">Reading strategy states…</p>;

  const kill = s.risk?.kill_switch_fired === true;
  const cards = [
    {
      name: "⚡ ScalperX", live: !!s.scalperx,
      rows: [
        ["open", Object.keys(s.scalperx?.open_positions ?? {}).length],
        ["record", `${num(s.scalperx?.wins)}W/${num(s.scalperx?.losses)}L`],
        ["pnl", `$${num(s.scalperx?.total_pnl).toFixed(2)}`],
        ["🔒 reserve", `$${num(s.scalperx_reserve?.reserve_usd).toFixed(2)}`],
      ],
    },
    {
      name: "🌙 NightWatch", live: !!s.night_watch,
      rows: [
        ["cycles", num(s.night_watch?.cycles)],
        ["trades", num(s.night_watch?.total_trades)],
        ["pnl", `$${num(s.night_watch?.total_pnl).toFixed(2)}`],
        ["🔒 reserve", `$${num(s.night_watch_reserve?.reserve_usd).toFixed(2)}`],
      ],
    },
    {
      name: "🎯 Polymarket", live: !!s.polymarket,
      rows: [
        ["paper balance", `$${num(s.polymarket?.paper_balance).toFixed(2)}`],
        ["open bets", Object.keys(s.polymarket?.open_positions ?? {}).length],
      ],
    },
    {
      name: "📈 Perps", live: !!s.perps,
      rows: [
        ["collateral", `$${num(s.perps?.paper_collateral ?? s.perps?.collateral).toFixed(2)}`],
        ["open", Object.keys(s.perps?.open_positions ?? {}).length],
      ],
    },
    {
      name: "🧪 Meme Scalper (legacy)", live: !!s.meme_scalper,
      rows: [
        ["virtual usdc", `$${num(s.meme_scalper?.virtual_usdc).toFixed(2)}`],
        ["trades", num(s.meme_scalper?.total_trades)],
        ["pnl", `$${num(s.meme_scalper?.total_pnl).toFixed(2)}`],
      ],
    },
    {
      name: "📐 RSI Scalp", live: !!s.rsi_positions,
      rows: [["open", Object.keys(s.rsi_positions ?? {}).length]],
    },
  ];

  return (
    <div className="studio-portfolio">
      {kill && (
        <div className="kill-banner">⛔ KILL SWITCH FIRED — global trading halted</div>
      )}
      <div className="studio-grid">
        {cards.map((c) => (
          <div key={c.name} className={`panel studio-card ${c.live ? "" : "studio-dead"}`}>
            <h5>{c.name} {!c.live && <span className="muted">offline</span>}</h5>
            {c.rows.map(([k, v]) => (
              <div className="kv" key={String(k)}><span>{k}</span><b>{String(v)}</b></div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── TASKS ──────────────────────────────────────────────────────────────── */

const STATUS_NEXT: Record<string, string> = {
  pending: "in_progress", in_progress: "done", done: "pending", blocked: "pending",
};

function TasksPanel() {
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");

  const refresh = async () => setTasks(await tasksList());
  useEffect(() => { void refresh(); }, []);

  async function add() {
    if (!title.trim()) return;
    await tasksAdd(title.trim(), priority);
    setTitle("");
    await refresh();
  }

  return (
    <div className="studio-tasks">
      <div className="row">
        <input placeholder="New task…" value={title}
               onChange={(e) => setTitle(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && void add()} />
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
        <button disabled={!title.trim()} onClick={() => void add()}>Add</button>
      </div>
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.id} className={`task-row st-${t.status} pr-${t.priority}`}>
            <button className="ghost task-status"
                    title="Click to advance status"
                    onClick={async () => { await tasksSetStatus(t.id, STATUS_NEXT[t.status]); await refresh(); }}>
              {t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" :
               t.status === "blocked" ? "⛔" : "○"}
            </button>
            <span className="task-title">{t.title}</span>
            <span className={`task-pr pr-${t.priority}`}>{t.priority}</span>
            <button className="ghost"
                    onClick={async () => { await tasksSetStatus(t.id, "blocked"); await refresh(); }}>
              block
            </button>
            <button className="ghost danger"
                    onClick={async () => { await tasksDelete(t.id); await refresh(); }}>
              ✕
            </button>
          </li>
        ))}
        {tasks.length === 0 && <li className="muted">No tasks yet — plan something.</li>}
      </ul>
    </div>
  );
}

/* ── IDEAS ──────────────────────────────────────────────────────────────── */

interface Idea {
  id: string; title: string; tags: string[] | null;
  modified?: string; preview: string; body: string;
}

function IdeasPanel() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sel, setSel] = useState<Idea | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");

  const refresh = async () => {
    try { setIdeas(await invoke<Idea[]>("ideas_list", { path: vaultPath() })); }
    catch (e) { setMsg(String(e)); }
  };
  useEffect(() => { void refresh(); }, []);

  function pick(i: Idea | null) {
    setSel(i);
    setTitle(i?.title ?? "");
    setTags((i?.tags ?? []).join(", "));
    setBody(i?.body ?? "");
  }

  async function save() {
    if (!title.trim()) return;
    try {
      await invoke("ideas_save", {
        path: vaultPath(), id: sel?.id ?? null, title: title.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        body,
      });
      setMsg("Saved to the vault.");
      await refresh();
      if (!sel) pick(null);
    } catch (e) { setMsg(String(e)); }
  }

  async function archive(id: string) {
    await invoke("ideas_archive", { path: vaultPath(), id });
    if (sel?.id === id) pick(null);
    await refresh();
  }

  return (
    <div className="studio-ideas">
      <aside className="ideas-list">
        <button onClick={() => pick(null)}>＋ New idea</button>
        <ul>
          {ideas.map((i) => (
            <li key={i.id} className={sel?.id === i.id ? "active" : ""}
                onClick={() => pick(i)}>
              <span className="idea-title">{i.title}</span>
              <span className="idea-preview">{i.preview}</span>
            </li>
          ))}
          {ideas.length === 0 && <li className="muted">No ideas yet.</li>}
        </ul>
      </aside>
      <section className="idea-editor">
        <input placeholder="Idea title" value={title}
               onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="tags, comma, separated" value={tags}
               onChange={(e) => setTags(e.target.value)} />
        <textarea placeholder="Markdown body — this lives in your vault at nexus/Memory/Ideas/"
                  value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row">
          <button disabled={!title.trim()} onClick={() => void save()}>Save</button>
          {sel && (
            <button className="ghost danger" onClick={() => void archive(sel.id)}>
              Archive
            </button>
          )}
          {msg && <span className="settings-msg">{msg}</span>}
        </div>
      </section>
    </div>
  );
}

/* ── FORGE ──────────────────────────────────────────────────────────────── */

const MODES = ["ARCHITECT", "BUILDER", "DEBUGGER", "REVIEWER", "STRATEGIST"] as const;

function ForgePanel() {
  const [mode, setMode] = useState<(typeof MODES)[number]>("ARCHITECT");
  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function forge() {
    if (!prompt.trim() || busy) return;
    setBusy(true); setOutput(""); setMsg("");
    try {
      const task = `[${mode}]\n${prompt.trim()}` +
        (context.trim() ? `\n\n--- CONTEXT ---\n${context.trim()}` : "");
      const res = await runAgent("forge", task);
      setOutput(res.output);
      setMsg(`${res.turns} turns · ${res.tool_calls} tools · $${res.cost_usd.toFixed(3)}`);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  async function saveToVault() {
    if (!output) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const file = `Forge/${stamp} - ${mode.toLowerCase()} - ${prompt.slice(0, 40).replace(/[/\\:]/g, " ")}.md`;
    try {
      await invoke("vault_write", { path: vaultPath(), file, content: output });
      setMsg(`Saved → ${file}`);
    } catch (e) { setMsg(String(e)); }
  }

  return (
    <div className="studio-forge">
      <div className="forge-modes">
        {MODES.map((m) => (
          <button key={m} className={`coin-tab ${mode === m ? "active" : "ghost"}`}
                  onClick={() => setMode(m)}>{m}</button>
        ))}
      </div>
      <textarea className="forge-prompt" placeholder={`What should the ${mode.toLowerCase()} forge?`}
                value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <textarea className="forge-context"
                placeholder="Optional context — paste code, notes, requirements…"
                value={context} onChange={(e) => setContext(e.target.value)} />
      <div className="row">
        <button disabled={busy || !prompt.trim()} onClick={() => void forge()}>
          {busy ? "Forging…" : "⚒ Forge"}
        </button>
        {output && (
          <>
            <button className="ghost"
                    onClick={() => void navigator.clipboard.writeText(output)}>Copy</button>
            <button className="ghost" onClick={() => void saveToVault()}>Save to vault</button>
          </>
        )}
        {msg && <span className="muted">{msg}</span>}
      </div>
      {output && <pre className="forge-output panel">{output}</pre>}
    </div>
  );
}

/* ── shell ──────────────────────────────────────────────────────────────── */

export default function StudioView() {
  const [tab, setTab] = useState<Tab>("portfolio");

  if (!inTauri()) {
    return (
      <main className="studio-wrap">
        <div className="panel floor-empty">STUDIO needs the desktop app (vault + SQLite access).</div>
      </main>
    );
  }

  return (
    <main className="studio-wrap">
      <section className="panel studio-panel">
        <div className="settings-tabs">
          {(["portfolio", "tasks", "ideas", "forge"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab ghost"}
                    onClick={() => setTab(t)}>
              {t === "portfolio" ? "◧ Portfolio" : t === "tasks" ? "☑ Tasks"
                : t === "ideas" ? "✦ Ideas" : "⚒ Forge"}
            </button>
          ))}
        </div>
        {tab === "portfolio" && <PortfolioPanel />}
        {tab === "tasks" && <TasksPanel />}
        {tab === "ideas" && <IdeasPanel />}
        {tab === "forge" && <ForgePanel />}
      </section>
    </main>
  );
}
