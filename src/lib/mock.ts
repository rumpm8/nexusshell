/**
 * Phase-1 mock data ticker. Drives workers, metrics, the activity feed and
 * (through the store) the brain visualization, so the whole dashboard is
 * alive before any real integration is connected. Phase 2 replaces this with
 * real agent events + vault indexing stats.
 */
import { useNexus } from "../state/store";
import { logActivity, logMetric } from "./db";

const TASKS: Record<string, string[]> = {
  scalperx: [
    "Scanning trending Solana pairs",
    "Riding BONKETTE +12% — trail armed",
    "Exit-route check on new candidate",
    "Banked profit → reserve sweep",
  ],
  night_watch: [
    "Waiting for RSI oversold confluence",
    "SOL RSI 41 — standing by",
    "Managing overnight position",
  ],
  librarian: [
    "Indexing Obsidian vault",
    "Linking trade notes to dashboards",
    "Summarising daily note",
  ],
  postman: ["Gmail not connected"],
  publisher: ["Social accounts not connected"],
  treasurer: ["Wallet not connected"],
};

const OUTPUTS = [
  "Updated ScalperX Dashboard.md",
  "Swept $1.42 to protected reserve",
  "Indexed 14 new notes",
  "Risk gate rejected thin pool ($8K liq)",
  "Tuned trail_pct 5.0 → 4.5 (high tier)",
  "Wrote nightly learnings note",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function startMockTicker(): () => void {
  const tick = () => {
    const s = useNexus.getState();

    // Animate one random worker (only the "connected" ones do work in mock)
    const active = s.workers.filter((w) =>
      ["scalperx", "night_watch", "librarian"].includes(w.workerId),
    );
    const w = pick(active);
    const working = Math.random() < 0.6;
    const succeeded = Math.random() < 0.85;
    const tokens = working ? Math.floor(200 + Math.random() * 1800) : 0;
    const cost = tokens * 0.000009; // rough blended $/token for display only

    s.updateWorker(w.workerId, {
      status: working ? "working" : "idle",
      currentTask: pick(TASKS[w.workerId]),
      progress: working ? Math.random() : 0,
      tokensUsed: w.tokensUsed + tokens,
      costUsd: w.costUsd + cost,
      successCount: w.successCount + (working && succeeded ? 1 : 0),
      failCount: w.failCount + (working && !succeeded ? 1 : 0),
      lastActivity: working ? new Date().toISOString() : w.lastActivity,
      recentOutputs: working
        ? [pick(OUTPUTS), ...w.recentOutputs].slice(0, 4)
        : w.recentOutputs,
    });

    if (working) {
      const kind = w.workerId === "librarian" ? "note" : "task";
      const description = pick(OUTPUTS);
      s.pushActivity({
        workerId: w.workerId,
        kind,
        description,
        status: succeeded ? "ok" : "fail",
        ts: new Date().toISOString(),
      });
      // Persist to SQLite when running inside Tauri (no-op in plain browser)
      void logActivity(w.workerId, kind, description, succeeded, tokens, cost);
      void logMetric("tasks_done");
    }

    // Metrics drift — the brain grows as the system "ingests"
    const m = s.metrics;
    const pnlDelta = (Math.random() - 0.42) * 2.5;
    s.bumpMetrics({
      notesIndexed: m.notesIndexed + Math.floor(Math.random() * 3),
      tasksCompleted: m.tasksCompleted + (working ? 1 : 0),
      messagesProcessed: m.messagesProcessed + Math.floor(Math.random() * 2),
      pnlUsd: m.pnlUsd + pnlDelta,
      apiCostUsd: m.apiCostUsd + cost,
      notesWritten: m.notesWritten + (Math.random() < 0.3 ? 1 : 0),
      pnlHistory: [...m.pnlHistory, m.pnlUsd + pnlDelta].slice(-48),
      costHistory: [...m.costHistory, m.apiCostUsd + cost].slice(-48),
      activityHistory: [
        ...m.activityHistory,
        m.tasksCompleted + (working ? 1 : 0),
      ].slice(-48),
    });
  };

  const id = window.setInterval(tick, 1800);
  tick();
  return () => window.clearInterval(id);
}
