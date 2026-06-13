/**
 * AGENT OPS — deep monitoring of every worker: live status, performance
 * records pulled from the real trade journals, run controls, brain dispatch
 * table, and the full activity log.
 */
import { useEffect, useState } from "react";
import { useNexus } from "../state/store";
import { fetchTradingDetail, sendBrainCommand, type TradingDetail } from "../lib/trading";
import { isRunnable, runAgent } from "../lib/agentRunner";
import { inTauri } from "../lib/live";

function ago(iso?: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return `${Math.floor(s)}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function AgentOps() {
  const workers = useNexus((s) => s.workers);
  const feed = useNexus((s) => s.feed);
  const [detail, setDetail] = useState<TradingDetail | null>(null);
  const [task, setTask] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [ctrlMsg, setCtrlMsg] = useState("");

  useEffect(() => {
    let on = true;
    const tick = async () => {
      const d = await fetchTradingDetail();
      if (on && d) setDetail(d);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 6000);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  async function fire(workerId: string) {
    const t = (task[workerId] ?? "").trim();
    if (!t) return;
    setBusy(workerId);
    setTask((m) => ({ ...m, [workerId]: "" }));
    try { await runAgent(workerId, t); }
    catch (e) { console.error(e); }
    finally { setBusy(null); }
  }

  async function control(action: "boost" | "block" | "unblock" | "run", agent: string) {
    try {
      await sendBrainCommand(action, agent, action === "boost" ? 3 : undefined);
      setCtrlMsg(`${action} ${agent} → brain`);
    } catch (e) { setCtrlMsg(String(e)); }
    window.setTimeout(() => setCtrlMsg(""), 4000);
  }

  function statsFor(workerId: string) {
    if (workerId === "scalperx") {
      const s = detail?.scalperx;
      return {
        journal: s?.journal ?? [],
        reserve: s?.reserve?.reserve_usd ?? 0,
        extra: s?.heartbeat ? `heartbeat ${ago(String(s.heartbeat.ts))}` : "no heartbeat",
        brainKey: "scalperx_watchdog",
      };
    }
    if (workerId === "night_watch") {
      const s = detail?.night_watch;
      return {
        journal: s?.journal ?? [],
        reserve: s?.reserve?.reserve_usd ?? 0,
        extra: `cycles ${Number(s?.state?.cycles ?? 0)}`,
        brainKey: "night_watch",
      };
    }
    return null;
  }

  const lastRun = detail?.brain?.last_run ?? {};

  return (
    <main className="ops-wrap">
      <section className="ops-agents">
        {workers.map((w) => {
          const stats = statsFor(w.workerId);
          const j = stats?.journal ?? [];
          const wins = j.filter((t) => t.pnl > 0).length;
          return (
            <article key={w.workerId} className={`panel ops-card status-${w.status}`}>
              <header className="ops-head">
                <span className="ws-avatar">{w.avatar}</span>
                <div className="ws-id">
                  <span className="ws-name">{w.name}</span>
                  <span className="ws-worker-id">{w.workerId}</span>
                </div>
                <span className={`status-dot ${w.status}`} />
              </header>
              <p className="ops-task">{w.currentTask}</p>

              <div className="ops-stats">
                {stats ? (
                  <>
                    <div className="kv"><span>trades</span><b>{j.length} ({wins}W/{j.length - wins}L)</b></div>
                    <div className="kv"><span>win rate</span>
                      <b>{j.length ? Math.round(wins / j.length * 100) : 0}%</b></div>
                    <div className="kv"><span>journal pnl</span>
                      <b className={j.reduce((a, t) => a + t.pnl, 0) >= 0 ? "pos" : "neg"}>
                        ${j.reduce((a, t) => a + t.pnl, 0).toFixed(2)}</b></div>
                    <div className="kv"><span>🔒 reserve</span><b>${stats.reserve.toFixed(2)}</b></div>
                    <div className="kv"><span>telemetry</span><b>{stats.extra}</b></div>
                    <div className="kv"><span>last dispatch</span>
                      <b>{ago(lastRun[stats.brainKey])}</b></div>
                  </>
                ) : (
                  <>
                    <div className="kv"><span>done / failed</span><b>{w.successCount} / {w.failCount}</b></div>
                    <div className="kv"><span>tokens</span><b>{(w.tokensUsed / 1000).toFixed(1)}k</b></div>
                    <div className="kv"><span>spend</span><b>${w.costUsd.toFixed(3)}</b></div>
                    <div className="kv"><span>last active</span><b>{ago(w.lastActivity)}</b></div>
                  </>
                )}
              </div>

              <ul className="ws-outputs">
                {w.recentOutputs.slice(0, 3).map((o, i) => <li key={i}>{o}</li>)}
                {w.recentOutputs.length === 0 && <li className="muted">No output yet</li>}
              </ul>

              <footer className="ops-actions">
                {inTauri() && isRunnable(w.workerId) && (
                  <div className="row">
                    <input placeholder={`Task for ${w.name}…`}
                           value={task[w.workerId] ?? ""}
                           onChange={(e) => setTask((m) => ({ ...m, [w.workerId]: e.target.value }))}
                           onKeyDown={(e) => e.key === "Enter" && void fire(w.workerId)} />
                    <button disabled={busy === w.workerId || !(task[w.workerId] ?? "").trim()}
                            onClick={() => void fire(w.workerId)}>
                      {busy === w.workerId ? "…" : "Run"}
                    </button>
                  </div>
                )}
                {stats && inTauri() && (
                  <div className="row">
                    <button className="ghost" onClick={() => void control("boost", stats.brainKey)}>Boost ×3</button>
                    <button className="ghost" onClick={() => void control("block", stats.brainKey)}>Block</button>
                    <button className="ghost" onClick={() => void control("unblock", stats.brainKey)}>Unblock</button>
                  </div>
                )}
              </footer>
            </article>
          );
        })}
      </section>

      <aside className="ops-log panel">
        <h4>ACTIVITY LOG {ctrlMsg && <span className="settings-msg"> · {ctrlMsg}</span>}</h4>
        <ul>
          {feed.map((e) => (
            <li key={e.id} className={e.status}>
              <span className="feed-ts">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="feed-worker">{e.workerId}</span>
              <span className="feed-desc">{e.description}</span>
            </li>
          ))}
          {feed.length === 0 && <li className="muted">Quiet so far…</li>}
        </ul>
      </aside>
    </main>
  );
}
