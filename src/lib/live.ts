/**
 * Phase-2 live data layer. Inside the Tauri app this replaces the mock
 * ticker entirely:
 *   - polls vault_scan → real ingestion metrics → the brain grows with the vault
 *   - polls trading_state → ScalperX / NightWatch workstations show their
 *     real heartbeats, reserves, and trade counts from the vault's .poolside
 *   - subscribes to agent-event → live Claude agent activity on the cards
 * Outside Tauri (browser preview) it reports unavailable and the mock runs.
 */
import { useNexus } from "../state/store";
import { logActivity, logMetric } from "./db";

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function vaultPath(): string {
  return localStorage.getItem("nexus.vaultPath") ?? "";
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

interface VaultStats {
  files: number;
  words: number;
  folders: number;
  recent: string[];
}

interface TradingState {
  scalperx: Record<string, unknown> | null;
  scalperx_reserve: Record<string, unknown> | null;
  scalperx_open_positions: number;
  scalperx_trades: number;
  night_watch: Record<string, unknown> | null;
  night_watch_reserve: Record<string, unknown> | null;
  night_watch_trades: number;
}

function heartbeatFresh(hb: Record<string, unknown> | null, maxAgeSecs: number): boolean {
  if (!hb || typeof hb.ts !== "string") return false;
  return (Date.now() - new Date(hb.ts).getTime()) / 1000 < maxAgeSecs;
}

async function pollVault(): Promise<void> {
  const s = useNexus.getState();
  try {
    const stats = await invoke<VaultStats>("vault_scan", { path: vaultPath() });
    const m = s.metrics;
    s.bumpMetrics({
      notesIndexed: stats.files,
      notesWritten: stats.recent.length,
      activityHistory: [...m.activityHistory, m.tasksCompleted].slice(-48),
    });
    s.updateWorker("librarian", {
      currentTask: `Indexing ${stats.files.toLocaleString()} notes · ${(stats.words / 1000).toFixed(0)}k words`,
      recentOutputs: stats.recent.slice(0, 4),
      lastActivity: new Date().toISOString(),
    });
    void logMetric("notes_indexed", stats.files);
  } catch (e) {
    s.updateWorker("librarian", { status: "error", currentTask: String(e) });
  }
}

async function pollTrading(): Promise<void> {
  const s = useNexus.getState();
  try {
    const t = await invoke<TradingState>("trading_state", { path: vaultPath() });

    const sxAlive = heartbeatFresh(t.scalperx, 60);
    const sxReserve = Number(t.scalperx_reserve?.reserve_usd ?? 0);
    const sxFloat = Number(t.scalperx_reserve?.current_float_usd ?? 0);
    const sxMode = String(t.scalperx?.mode ?? "paper");
    s.updateWorker("scalperx", {
      status: sxAlive ? (t.scalperx_open_positions > 0 ? "working" : "idle") : "error",
      currentTask: sxAlive
        ? `${sxMode.toUpperCase()} · ${t.scalperx_open_positions} open · float $${sxFloat.toFixed(0)}`
        : "Daemon heartbeat stale — watchdog will restart it",
      progress: t.scalperx_open_positions > 0 ? 0.6 : 0,
      successCount: t.scalperx_trades,
      lastActivity: typeof t.scalperx?.ts === "string" ? (t.scalperx.ts as string) : null,
      recentOutputs: [
        `🔒 Reserve $${sxReserve.toFixed(2)} (protected)`,
        `Journal: ${t.scalperx_trades} closed trades`,
      ],
    });

    const nwReserve = Number(t.night_watch_reserve?.reserve_usd ?? 0);
    const nwPnl = Number(t.night_watch?.total_pnl ?? 0);
    s.updateWorker("night_watch", {
      status: "idle",
      currentTask: `Cycles ${Number(t.night_watch?.cycles ?? 0)} · PnL $${nwPnl.toFixed(2)}`,
      successCount: t.night_watch_trades,
      recentOutputs: [
        `🔒 Reserve $${nwReserve.toFixed(2)} (protected)`,
        `Journal: ${t.night_watch_trades} closed trades`,
      ],
    });

    // Real P/L = both agents' realized PnL feeds the Stats Hub
    const sxPnl = Number(
      (t.scalperx_reserve?.reserve_usd as number ?? 0) +
      (sxFloat ? sxFloat - Number(t.scalperx_reserve?.base_float_usd ?? sxFloat) : 0),
    );
    const m = useNexus.getState().metrics;
    const pnl = sxPnl + nwPnl;
    s.bumpMetrics({
      pnlUsd: pnl,
      pnlHistory: [...m.pnlHistory, pnl].slice(-48),
    });
  } catch {
    // vault may not have .poolside yet — cards keep their last state
  }
}

interface AgentEventPayload {
  worker_id: string;
  phase: "started" | "thinking" | "tool" | "done" | "error";
  text: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

async function subscribeAgentEvents(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<AgentEventPayload>("agent-event", ({ payload: p }) => {
    const s = useNexus.getState();
    const w = s.workers.find((x) => x.workerId === p.worker_id);
    if (!w) return;

    const working = p.phase === "started" || p.phase === "thinking" || p.phase === "tool";
    s.updateWorker(p.worker_id, {
      status: p.phase === "error" ? "error" : working ? "working" : "idle",
      currentTask: p.text || w.currentTask,
      progress: working ? Math.min(w.progress + 0.18, 0.95) : 0,
      tokensUsed: p.tokens_in + p.tokens_out,
      costUsd: p.cost_usd,
      successCount: w.successCount + (p.phase === "done" ? 1 : 0),
      failCount: w.failCount + (p.phase === "error" ? 1 : 0),
      lastActivity: new Date().toISOString(),
      recentOutputs:
        p.phase === "tool" || p.phase === "done"
          ? [p.text, ...w.recentOutputs].slice(0, 4)
          : w.recentOutputs,
    });
    s.pushActivity({
      workerId: p.worker_id,
      kind: p.phase === "tool" ? "tool" : "task",
      description: p.text,
      status: p.phase === "error" ? "fail" : "ok",
      ts: new Date().toISOString(),
    });
    if (p.phase === "done" || p.phase === "error") {
      const m = useNexus.getState().metrics;
      s.bumpMetrics({
        tasksCompleted: m.tasksCompleted + 1,
        apiCostUsd: p.cost_usd,
        costHistory: [...m.costHistory, p.cost_usd].slice(-48),
      });
      void logActivity(
        p.worker_id, "task", p.text, p.phase === "done",
        p.tokens_in + p.tokens_out, p.cost_usd,
      );
    }
  });
}

/** Start live mode. Returns a cleanup fn, or null if not inside Tauri. */
export async function startLive(): Promise<(() => void) | null> {
  if (!inTauri()) return null;
  useNexus.setState({ dataSource: "live" });

  await pollVault();
  await pollTrading();
  const vaultTimer = window.setInterval(() => void pollVault(), 30_000);
  const tradeTimer = window.setInterval(() => void pollTrading(), 5_000);
  const unlisten = await subscribeAgentEvents();

  return () => {
    window.clearInterval(vaultTimer);
    window.clearInterval(tradeTimer);
    unlisten();
  };
}
