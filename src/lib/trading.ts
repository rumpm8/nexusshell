/**
 * Trading Floor data layer — typed access to the Rust market/trading
 * commands. All HTTP happens in Rust (CSP keeps the webview locked down).
 */
import { inTauri, vaultPath } from "./live";

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface JournalTrade {
  trade_id: string; mode: string; symbol: string; mint?: string; tier: string;
  ts_entry: string; ts_exit: string;
  entry_price: number; exit_price: number; peak_price?: number; mfe_pct?: number;
  usd_in: number; usd_out: number; pnl: number; pnl_pct: number;
  hold_secs: number; exit_reason: string;
  trail_pct_used?: number;
}

export interface OpenPosition {
  mint: string; symbol: string; tier: string;
  entry_price: number; usd_in: number; tokens: number;
  entry_time: string; last_price?: number;
  trail?: {
    peak_price: number; trail_pct: number; hard_sl_price: number;
    profit_floor_price: number | null; entry_price: number;
  };
}

export interface TradingDetail {
  scalperx: {
    heartbeat: Record<string, unknown> | null;
    state: { open_positions?: Record<string, OpenPosition>;
             wins?: number; losses?: number; total_trades?: number;
             total_pnl?: number } | null;
    reserve: { reserve_usd: number; current_float_usd: number;
               base_float_usd: number; sweep_count: number } | null;
    tuned: { version: number } | null;
    journal: JournalTrade[];
  };
  night_watch: {
    state: Record<string, unknown> | null;
    positions: Record<string, { symbol: string; entry_price: number;
      usd_invested: number; entry_time: string; trail?: unknown }> | null;
    reserve: { reserve_usd: number; current_float_usd: number } | null;
    journal: JournalTrade[];
  };
  brain: { cycle_phase?: string; status?: string;
           last_run?: Record<string, string> } | null;
}

export async function fetchTradingDetail(): Promise<TradingDetail | null> {
  if (!inTauri()) return null;
  return invoke<TradingDetail>("trading_detail", {
    path: vaultPath(), journalTail: 120,
  });
}

export async function fetchCandles(mint: string, minutes = 240):
  Promise<{ pool: string; dex: string; candles: Candle[] } | null> {
  if (!inTauri()) return null;
  const raw = await invoke<{ pool: string; dex: string; candles: number[][] }>(
    "market_candles", { mint, minutes });
  return {
    pool: raw.pool,
    dex: raw.dex,
    candles: raw.candles.map((c) => ({
      time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    })),
  };
}

export async function fetchPrices(mints: string[]): Promise<Record<string, number>> {
  if (!inTauri() || mints.length === 0) return {};
  return invoke<Record<string, number>>("market_price", { mints });
}

export async function sendBrainCommand(
  action: "pause" | "resume" | "run" | "boost" | "block" | "unblock",
  agent?: string, factor?: number,
): Promise<string> {
  return invoke<string>("brain_command", {
    path: vaultPath(), action, agent: agent ?? null, factor: factor ?? null,
  });
}

export interface WalletSnapshot {
  address: string;
  sol: number;
  sol_usd: number;
  tokens_usd: number;
  total_usd: number;
  active: { mint: string; amount: number; usd: number }[];
}

// optional default wallet (read-only — shell never signs). Set yours in Settings.
export const WALLET_ADDRESS = "";

export async function fetchWallet(address: string): Promise<WalletSnapshot | null> {
  if (!inTauri()) return null;
  try { return await invoke<WalletSnapshot>("wallet_balances", { address }); }
  catch { return null; }
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
