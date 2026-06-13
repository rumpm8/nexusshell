import { useNexus } from "../state/store";
import Sparkline from "./Sparkline";

function fmtUsd(v: number): string {
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export default function StatsHub() {
  const m = useNexus((s) => s.metrics);
  const workers = useNexus((s) => s.workers);
  const dataSource = useNexus((s) => s.dataSource);

  const totalCost = workers.reduce((a, w) => a + w.costUsd, 0);

  return (
    <header className="stats-hub panel">
      <div className="stat big">
        <span className="stat-label">Total P/L</span>
        <span className={`stat-value ${m.pnlUsd >= 0 ? "pos" : "neg"}`}>
          {fmtUsd(m.pnlUsd)}
        </span>
        <Sparkline data={m.pnlHistory} stroke={m.pnlUsd >= 0 ? "#45e8ff" : "#ff4d8f"} />
      </div>
      <div className="stat">
        <span className="stat-label">API spend</span>
        <span className="stat-value">${totalCost.toFixed(3)}</span>
        <Sparkline data={m.costHistory} stroke="#b18aff" />
      </div>
      <div className="stat">
        <span className="stat-label">Tasks done</span>
        <span className="stat-value">{m.tasksCompleted}</span>
        <Sparkline data={m.activityHistory} />
      </div>
      <div className="stat">
        <span className="stat-label">Notes</span>
        <span className="stat-value">{m.notesWritten}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Emails</span>
        <span className="stat-value">{m.emailsHandled}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Posts</span>
        <span className="stat-value">{m.postsPublished}</span>
      </div>
      <div className={`source-chip ${dataSource}`}>
        {dataSource === "mock" ? "MOCK DATA" : "LIVE"}
      </div>
    </header>
  );
}
