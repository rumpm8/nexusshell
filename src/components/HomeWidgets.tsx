/**
 * Home-screen widgets — small live tiles over the trading system: brain
 * phase, protected reserve, ScalperX vitals, and quick controls.
 */
import { useEffect, useState } from "react";
import { useNexus } from "../state/store";
import { fetchTradingDetail, sendBrainCommand, type TradingDetail } from "../lib/trading";
import { inTauri } from "../lib/live";

function ago(iso?: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(String(iso)).getTime()) / 1000;
  if (s < 90) return `${Math.floor(s)}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export default function HomeWidgets() {
  const setView = useNexus((s) => s.setView);
  const [d, setD] = useState<TradingDetail | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!inTauri()) return;
    let on = true;
    const tick = async () => {
      const det = await fetchTradingDetail();
      if (on && det) setD(det);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 10_000);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  async function control(action: "pause" | "resume") {
    try {
      await sendBrainCommand(action);
      setMsg(`${action} sent`);
    } catch (e) { setMsg(String(e)); }
    window.setTimeout(() => setMsg(""), 3000);
  }

  const reserveTotal =
    (d?.scalperx.reserve?.reserve_usd ?? 0) +
    (d?.night_watch.reserve?.reserve_usd ?? 0);
  const float = d?.scalperx.reserve?.current_float_usd ?? 0;
  const hb = d?.scalperx.heartbeat;
  const hbAge = hb ? (Date.now() - new Date(String(hb.ts)).getTime()) / 1000 : Infinity;
  const journal = d?.scalperx.journal ?? [];
  const wins = journal.filter((t) => t.pnl > 0).length;
  const openCount = Object.keys(d?.scalperx.state?.open_positions ?? {}).length;
  const phase = d?.brain?.cycle_phase ?? "—";
  const brainStatus = d?.brain?.status ?? "unknown";

  return (
    <div className="home-widgets">
      <div className="panel widget">
        <span className="widget-label">BRAIN</span>
        <span className={`widget-value ${brainStatus === "running" ? "pos" : "neg"}`}>
          {String(phase).toUpperCase()}
        </span>
        <span className="widget-sub">{brainStatus}</span>
      </div>

      <div className="panel widget">
        <span className="widget-label">🔒 RESERVE</span>
        <span className="widget-value pos">${reserveTotal.toFixed(2)}</span>
        <span className="widget-sub">float ${float.toFixed(0)}</span>
      </div>

      <div className="panel widget widget-click" onClick={() => setView("trading")}
           title="Open the trading floor">
        <span className="widget-label">⚡ SCALPERX</span>
        <span className={`widget-value ${hbAge < 60 ? "pos" : "neg"}`}>
          {hbAge < 60 ? `${openCount} OPEN` : "STALE"}
        </span>
        <span className="widget-sub">
          {journal.length ? `${wins}W/${journal.length - wins}L` : "no trades"} · hb {ago(hb?.ts as string)}
        </span>
      </div>

      <div className="panel widget">
        <span className="widget-label">CONTROL</span>
        <div className="widget-actions">
          <button className="ghost" onClick={() => void control("pause")}>⏸</button>
          <button className="ghost" onClick={() => void control("resume")}>▶</button>
          <button className="ghost" onClick={() => setView("agents")}>⬡</button>
        </div>
        <span className="widget-sub">{msg || "pause · resume · agents"}</span>
      </div>
    </div>
  );
}
