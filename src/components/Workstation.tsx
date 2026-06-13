import { useState } from "react";
import type { Worker } from "../state/store";
import { isRunnable, runAgent } from "../lib/agentRunner";
import { inTauri } from "../lib/live";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

export default function Workstation({ worker }: { worker: Worker }) {
  const w = worker;
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskText, setTaskText] = useState("");
  const [running, setRunning] = useState(false);
  const runnable = inTauri() && isRunnable(w.workerId);

  async function submitTask() {
    const task = taskText.trim();
    if (!task || running) return;
    setRunning(true);
    setTaskOpen(false);
    setTaskText("");
    try {
      await runAgent(w.workerId, task);
    } catch (e) {
      console.error(`agent ${w.workerId} failed:`, e);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className={`workstation panel status-${w.status}`}>
      <div className="ws-head">
        <span className="ws-avatar">{w.avatar}</span>
        <div className="ws-id">
          <span className="ws-name">{w.name} MODULE</span>
          <span className="ws-worker-id">{w.workerId} · zone {w.zone}</span>
        </div>
        {runnable && (
          <button
            className="ghost ws-run"
            disabled={running}
            onClick={() => setTaskOpen((v) => !v)}
            title="Run a task with this agent"
          >
            {running ? "…" : "▶"}
          </button>
        )}
        <span className={`status-dot ${w.status}`} title={w.status} />
      </div>

      {taskOpen && (
        <div className="ws-task-input row">
          <input
            autoFocus
            placeholder={`Task for ${w.name}…`}
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitTask()}
          />
          <button disabled={!taskText.trim()} onClick={() => void submitTask()}>
            Run
          </button>
        </div>
      )}

      <div className="ws-task">
        <span className="ws-task-text">{w.currentTask}</span>
        <div className="ws-progress">
          <div
            className="ws-progress-fill"
            style={{ width: `${Math.round(w.progress * 100)}%` }}
          />
        </div>
      </div>

      <div className="ws-insights">
        <div className="ws-counters">
          <span title="successes">✓ {w.successCount}</span>
          <span title="failures">✗ {w.failCount}</span>
          <span title="tokens">{(w.tokensUsed / 1000).toFixed(1)}k tok</span>
          <span title="cost">${w.costUsd.toFixed(3)}</span>
          <span className="ws-last">{timeAgo(w.lastActivity)}</span>
        </div>
        <ul className="ws-outputs">
          {w.recentOutputs.length === 0 ? (
            <li className="muted">No output yet</li>
          ) : (
            w.recentOutputs.map((o, i) => <li key={i}>{o}</li>)
          )}
        </ul>
      </div>
    </section>
  );
}
