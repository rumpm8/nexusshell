/**
 * TRADING FLOOR — live candlestick chart of whatever the agents are trading,
 * with the agents' actual entries/exits plotted as markers, the live trailing
 * stop drawn on the chart, position telemetry, the protected reserve, and a
 * rolling trade tape. Candles come from the same on-chain DEX pools the
 * agents trade against (GeckoTerminal), live ticks from Jupiter.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time,
  type IPriceLine,
} from "lightweight-charts";
import {
  fetchTradingDetail, fetchCandles, fetchPrices, sendBrainCommand,
  fetchWallet, WALLET_ADDRESS,
  SOL_MINT, type TradingDetail, type JournalTrade, type OpenPosition,
  type WalletSnapshot,
} from "../lib/trading";
import { inTauri } from "../lib/live";

interface CoinOption {
  mint: string;
  symbol: string;
  source: "open-scalperx" | "open-nightwatch" | "recent" | "major";
}

interface Pin {
  id: string;
  time: number;   // unix seconds
  price: number;
  kind: "high" | "low";
}

const PINS_KEY = "nexus.chart.pins";
function loadPins(): Record<string, Pin[]> {
  try { return JSON.parse(localStorage.getItem(PINS_KEY) ?? "{}"); }
  catch { return {}; }
}
function savePins(p: Record<string, Pin[]>) {
  localStorage.setItem(PINS_KEY, JSON.stringify(p));
}

function fmtUsd(v: number, digits = 2): string {
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toFixed(digits)}`;
}
function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

export default function TradingFloor() {
  const [detail, setDetail] = useState<TradingDetail | null>(null);
  const [coin, setCoin] = useState<CoinOption | null>(null);
  const [poolName, setPoolName] = useState("");
  const [dex, setDex] = useState("");
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [chartErr, setChartErr] = useState("");
  const [ctrlMsg, setCtrlMsg] = useState("");
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);

  /* ── Phantom wallet snapshot poll ─────────────────────────────────────── */
  useEffect(() => {
    let on = true;
    const addr = localStorage.getItem("nexus.walletAddress") || WALLET_ADDRESS;
    const tick = async () => {
      const w = await fetchWallet(addr);
      if (on && w) setWallet(w);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 20000);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastCandleRef = useRef<{ time: number; open: number; high: number;
                                low: number; close: number } | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  /* ── pins: user-placed high/low markers, persisted per coin ──────────── */
  const [pinsAll, setPinsAll] = useState<Record<string, Pin[]>>(loadPins);
  const [pinMode, setPinMode] = useState<"off" | "high" | "low">("off");
  const pinModeRef = useRef(pinMode);
  pinModeRef.current = pinMode;
  const coinRef = useRef<CoinOption | null>(null);
  coinRef.current = coin;
  const tradeMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const pinLinesRef = useRef<IPriceLine[]>([]);

  const pins = useMemo(() => (coin ? pinsAll[coin.mint] ?? [] : []), [pinsAll, coin]);

  const applyMarkers = useCallback(() => {
    const series = seriesRef.current;
    const c = coinRef.current;
    if (!series || !c) return;
    const pinMarkers: SeriesMarker<Time>[] = (pinsAll[c.mint] ?? []).map((p) => ({
      time: p.time as Time,
      position: p.kind === "high" ? "aboveBar" : "belowBar",
      color: p.kind === "high" ? "#ffffff" : "#45e8ff",
      shape: "circle",
      text: `📍${p.kind === "high" ? "H" : "L"} ${fmtPrice(p.price)}`,
    }));
    const all = [...tradeMarkersRef.current, ...pinMarkers]
      .sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(all);
    // dashed level line per pin so the level is trackable across the chart
    for (const pl of pinLinesRef.current) series.removePriceLine(pl);
    pinLinesRef.current = (pinsAll[c.mint] ?? []).map((p) =>
      series.createPriceLine({
        price: p.price,
        color: p.kind === "high" ? "rgba(255,255,255,0.55)" : "rgba(69,232,255,0.55)",
        lineWidth: 1, lineStyle: 3,
        title: `📍 ${p.kind}`,
      }));
  }, [pinsAll]);

  function addPin(time: number, price: number) {
    const c = coinRef.current;
    if (!c) return;
    const kind = pinModeRef.current === "low" ? "low" : "high";
    setPinsAll((prev) => {
      const next = {
        ...prev,
        [c.mint]: [...(prev[c.mint] ?? []),
          { id: `${Date.now()}`, time, price, kind } as Pin],
      };
      savePins(next);
      return next;
    });
  }

  function removePin(id: string) {
    const c = coinRef.current;
    if (!c) return;
    setPinsAll((prev) => {
      const next = { ...prev, [c.mint]: (prev[c.mint] ?? []).filter((p) => p.id !== id) };
      savePins(next);
      return next;
    });
  }

  /* ── derive the coin list from what the agents are ACTUALLY doing ────── */
  const coins = useMemo<CoinOption[]>(() => {
    const out: CoinOption[] = [];
    const seen = new Set<string>();
    const sxOpen = detail?.scalperx.state?.open_positions ?? {};
    for (const pos of Object.values(sxOpen)) {
      if (!seen.has(pos.mint)) {
        seen.add(pos.mint);
        out.push({ mint: pos.mint, symbol: pos.symbol, source: "open-scalperx" });
      }
    }
    // recent journal coins (latest first)
    const journal = [...(detail?.scalperx.journal ?? [])].reverse();
    for (const t of journal) {
      if (t.mint && !seen.has(t.mint) && out.length < 8) {
        seen.add(t.mint);
        out.push({ mint: t.mint, symbol: t.symbol, source: "recent" });
      }
    }
    if (!seen.has(SOL_MINT)) {
      out.push({ mint: SOL_MINT, symbol: "SOL", source: "major" });
    }
    return out;
  }, [detail]);

  // pick a default coin: open position first, else most recent, else SOL
  useEffect(() => {
    if (!coin && coins.length) setCoin(coins[0]);
    // if our coin vanished from the list (position closed long ago), keep it —
    // the chart is still valid; user can switch.
  }, [coins, coin]);

  /* ── trading detail poll (positions, journal, reserve) ───────────────── */
  useEffect(() => {
    let on = true;
    const tick = async () => {
      const d = await fetchTradingDetail();
      if (on && d) setDetail(d);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  /* ── chart lifecycle ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#79719e",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(177,138,255,0.06)" },
        horzLines: { color: "rgba(177,138,255,0.06)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(69,232,255,0.4)", labelBackgroundColor: "#161029" },
        horzLine: { color: "rgba(69,232,255,0.4)", labelBackgroundColor: "#161029" },
      },
      rightPriceScale: { borderColor: "rgba(177,138,255,0.18)" },
      timeScale: { borderColor: "rgba(177,138,255,0.18)", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#2ee6d6", downColor: "#ff4d8f",
      wickUpColor: "#2ee6d6", wickDownColor: "#ff4d8f",
      borderVisible: false,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    // click-to-pin: when pin mode is armed, a chart click drops a marker
    chart.subscribeClick((param) => {
      if (pinModeRef.current === "off" || !param.point || !param.time) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;
      addPin(param.time as number, price as number);
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  /* ── load candles + plot agent trades when the coin changes ──────────── */
  const loadCoin = useCallback(async (c: CoinOption, d: TradingDetail | null) => {
    const series = seriesRef.current;
    if (!series) return;
    setChartErr("");
    try {
      const res = await fetchCandles(c.mint, 240);
      if (!res || !res.candles.length) { setChartErr("No on-chain candle data for this token"); return; }
      setPoolName(res.pool); setDex(res.dex);

      series.setData(res.candles.map((k) => ({
        time: k.time as Time, open: k.open, high: k.high, low: k.low, close: k.close,
      })));
      const last = res.candles[res.candles.length - 1];
      lastCandleRef.current = { ...last };

      // ── agent trade markers on the candles ─────────────────────────────
      const trades = (d?.scalperx.journal ?? []).concat(d?.night_watch.journal ?? [])
        .filter((t) => t.mint === c.mint || (!t.mint && t.symbol === c.symbol));
      const markers: SeriesMarker<Time>[] = [];
      for (const t of trades) {
        const tin = Math.floor(new Date(t.ts_entry).getTime() / 1000);
        const tout = Math.floor(new Date(t.ts_exit).getTime() / 1000);
        markers.push({
          time: tin as Time, position: "belowBar", color: "#45e8ff",
          shape: "arrowUp", text: `IN ${fmtPrice(t.entry_price)}`,
        });
        markers.push({
          time: tout as Time, position: "aboveBar",
          color: t.pnl >= 0 ? "#45e8ff" : "#ff4d8f",
          shape: "arrowDown",
          text: `${t.exit_reason.replace(/_/g, " ")} ${t.pnl_pct >= 0 ? "+" : ""}${t.pnl_pct.toFixed(1)}%`,
        });
      }
      // open-position entry marker
      const open = Object.values(d?.scalperx.state?.open_positions ?? {})
        .find((p) => p.mint === c.mint);
      if (open) {
        markers.push({
          time: Math.floor(new Date(open.entry_time).getTime() / 1000) as Time,
          position: "belowBar", color: "#ffd166", shape: "arrowUp",
          text: `OPEN ${fmtPrice(open.entry_price)}`,
        });
      }
      tradeMarkersRef.current = markers;
      applyMarkers();

      // ── live trailing-stop / entry lines for the open position ────────
      for (const pl of priceLinesRef.current) series.removePriceLine(pl);
      priceLinesRef.current = [];
      if (open?.trail) {
        const trailLevel = open.trail.peak_price * (1 - open.trail.trail_pct / 100);
        priceLinesRef.current.push(
          series.createPriceLine({
            price: open.entry_price, color: "#ffd166", lineWidth: 1,
            lineStyle: 2, title: "entry",
          }),
          series.createPriceLine({
            price: trailLevel, color: "#45e8ff", lineWidth: 1,
            lineStyle: 0, title: `trail ${open.trail.trail_pct}%`,
          }),
          series.createPriceLine({
            price: open.trail.hard_sl_price, color: "#ff4d8f", lineWidth: 1,
            lineStyle: 2, title: "hard stop",
          }),
        );
        if (open.trail.profit_floor_price) {
          priceLinesRef.current.push(series.createPriceLine({
            price: open.trail.profit_floor_price, color: "#b18aff", lineWidth: 1,
            lineStyle: 3, title: "profit floor",
          }));
        }
      }
      chartRef.current?.timeScale().fitContent();
    } catch (e) {
      setChartErr(String(e));
    }
  }, []);

  useEffect(() => {
    if (coin) void loadCoin(coin, detail);
    // reload markers/lines when detail refreshes (positions move)
  }, [coin, loadCoin]);   // markers refresh handled by the price effect below

  // re-render markers whenever pins change
  useEffect(() => { applyMarkers(); }, [pinsAll, applyMarkers]);

  /* ── live ticks: update the forming candle every 3s ───────────────────── */
  useEffect(() => {
    if (!coin) return;
    let on = true;
    const tick = async () => {
      const prices = await fetchPrices([coin.mint]);
      const p = prices[coin.mint];
      if (!on || !p || !seriesRef.current) return;
      setLivePrice(p);
      const minute = Math.floor(Date.now() / 60000) * 60;
      const lc = lastCandleRef.current;
      if (lc && minute <= lc.time) {
        lc.high = Math.max(lc.high, p); lc.low = Math.min(lc.low, p); lc.close = p;
        seriesRef.current.update({ time: lc.time as Time, open: lc.open, high: lc.high, low: lc.low, close: lc.close });
      } else {
        const open = lc ? lc.close : p;
        lastCandleRef.current = { time: minute, open, high: Math.max(open, p), low: Math.min(open, p), close: p };
        seriesRef.current.update({ time: minute as Time, open, high: Math.max(open, p), low: Math.min(open, p), close: p });
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => { on = false; window.clearInterval(id); };
  }, [coin]);

  /* ── brain controls ───────────────────────────────────────────────────── */
  async function control(action: "pause" | "resume" | "block" | "unblock", agent?: string) {
    try {
      await sendBrainCommand(action, agent);
      setCtrlMsg(`${action}${agent ? ` ${agent}` : ""} → sent to brain`);
    } catch (e) { setCtrlMsg(String(e)); }
    window.setTimeout(() => setCtrlMsg(""), 4000);
  }

  if (!inTauri()) {
    return (
      <main className="floor-wrap">
        <div className="panel floor-empty">Trading Floor needs the desktop app (vault + market access).</div>
      </main>
    );
  }

  const sx = detail?.scalperx;
  const openPositions = Object.values(sx?.state?.open_positions ?? {});
  const activePos: OpenPosition | undefined =
    openPositions.find((p) => p.mint === coin?.mint) ?? openPositions[0];
  const reserve = sx?.reserve;
  const trades: JournalTrade[] = [...(sx?.journal ?? [])].reverse().slice(0, 14);
  const wins = sx?.state?.wins ?? 0;
  const total = sx?.state?.total_trades ?? 0;
  const phase = detail?.brain?.cycle_phase ?? "?";

  const posPnl = activePos && livePrice && coin && activePos.mint === coin.mint
    ? (livePrice - activePos.entry_price) / activePos.entry_price * 100
    : null;

  return (
    <main className="floor-wrap">
      {/* ── chart column ─────────────────────────────────────────────── */}
      <section className="panel floor-chart">
        <div className="floor-chart-head">
          <div className="coin-tabs">
            {coins.map((c) => (
              <button key={c.mint}
                      className={`coin-tab ${coin?.mint === c.mint ? "active" : "ghost"}`}
                      onClick={() => setCoin(c)}>
                {c.source === "open-scalperx" && <span className="dot-live" />}
                {c.symbol}
              </button>
            ))}
          </div>
          <div className="floor-meta">
            <div className="pin-controls">
              <button className={`coin-tab ${pinMode === "high" ? "active" : "ghost"}`}
                      title="Arm, then click the chart to pin a HIGH"
                      onClick={() => setPinMode((m) => m === "high" ? "off" : "high")}>
                📍 HIGH
              </button>
              <button className={`coin-tab ${pinMode === "low" ? "active" : "ghost"}`}
                      title="Arm, then click the chart to pin a LOW"
                      onClick={() => setPinMode((m) => m === "low" ? "off" : "low")}>
                📍 LOW
              </button>
            </div>
            <span className="floor-pool">{poolName} · {dex} · 1m</span>
            {livePrice !== null && (
              <span className={`floor-price ${posPnl !== null && posPnl < 0 ? "neg" : "pos"}`}>
                ${fmtPrice(livePrice)}
              </span>
            )}
          </div>
        </div>
        {pinMode !== "off" && (
          <div className="pin-hint">PIN {pinMode.toUpperCase()} armed — click the chart to drop it</div>
        )}
        <div className={`floor-chart-canvas ${pinMode !== "off" ? "pin-armed" : ""}`} ref={wrapRef} />
        {chartErr && <div className="floor-err">{chartErr}</div>}
        <div className="floor-legend">
          <span className="lg lg-in">▲ agent entry</span>
          <span className="lg lg-out">▼ agent exit</span>
          <span className="lg lg-trail">— trailing stop</span>
          <span className="lg lg-sl">--- hard stop</span>
          <span className="lg lg-floor">··· profit floor</span>
        </div>
      </section>

      {/* ── telemetry column ─────────────────────────────────────────── */}
      <aside className="floor-side">
        <section className="panel floor-card wallet-card">
          <h4>👻 PHANTOM WALLET</h4>
          {wallet ? (
            <>
              <div className="wallet-total">${wallet.total_usd.toFixed(2)}</div>
              <div className="kv"><span>SOL</span>
                <b>{wallet.sol.toFixed(3)} (${wallet.sol_usd.toFixed(2)})</b></div>
              <div className="kv"><span>tokens</span>
                <b>{wallet.active.length} · ${wallet.tokens_usd.toFixed(2)}</b></div>
              <div className="wallet-coins">
                {wallet.active.slice(0, 5).map((c) => (
                  <span key={c.mint} className="wallet-coin"
                        title={`${c.mint}\n${c.amount} · $${c.usd.toFixed(2)}`}>
                    {c.mint === SOL_MINT ? "SOL" : c.mint.slice(0, 4)} ${c.usd.toFixed(0)}
                  </span>
                ))}
                {wallet.active.length === 0 && <span className="muted">no priced tokens</span>}
              </div>
              <div className="wallet-addr">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</div>
            </>
          ) : (
            <p className="muted">Reading wallet…</p>
          )}
        </section>

        <section className="panel floor-card">
          <h4>POSITION</h4>
          {activePos ? (
            <>
              <div className="kv"><span>symbol</span><b>{activePos.symbol} · {activePos.tier}</b></div>
              <div className="kv"><span>entry</span><b>${fmtPrice(activePos.entry_price)}</b></div>
              <div className="kv"><span>size</span><b>${activePos.usd_in.toFixed(2)}</b></div>
              {posPnl !== null && (
                <div className="kv"><span>unrealised</span>
                  <b className={posPnl >= 0 ? "pos" : "neg"}>{posPnl >= 0 ? "+" : ""}{posPnl.toFixed(2)}%</b>
                </div>
              )}
              {activePos.trail && (
                <>
                  <div className="kv"><span>peak</span>
                    <b>${fmtPrice(activePos.trail.peak_price)}</b></div>
                  <div className="kv"><span>trail</span>
                    <b>{activePos.trail.trail_pct}% · sells at ${fmtPrice(activePos.trail.peak_price * (1 - activePos.trail.trail_pct / 100))}</b></div>
                  <div className="kv"><span>floor</span>
                    <b>{activePos.trail.profit_floor_price ? `armed $${fmtPrice(activePos.trail.profit_floor_price)}` : "not armed"}</b></div>
                </>
              )}
            </>
          ) : (
            <p className="muted">No open position — hunting. The chart shows the most recent battlefield.</p>
          )}
        </section>

        <section className="panel floor-card">
          <h4>🔒 RESERVE</h4>
          <div className="reserve-big">{fmtUsd(reserve?.reserve_usd ?? 0)}</div>
          <div className="kv"><span>float</span><b>${(reserve?.current_float_usd ?? 0).toFixed(2)} / ${(reserve?.base_float_usd ?? 0).toFixed(0)}</b></div>
          <div className="kv"><span>sweeps</span><b>{reserve?.sweep_count ?? 0}</b></div>
          <div className="kv"><span>record</span><b>{wins}W / {(total - wins)}L · {total ? Math.round(wins / total * 100) : 0}%</b></div>
        </section>

        <section className="panel floor-card">
          <h4>BRAIN CONTROL <span className="muted">phase: {phase}</span></h4>
          <div className="ctrl-grid">
            <button className="ghost" onClick={() => void control("pause")}>⏸ Pause brain</button>
            <button className="ghost" onClick={() => void control("resume")}>▶ Resume</button>
            <button className="ghost" onClick={() => void control("block", "night_watch")}>Block NightWatch</button>
            <button className="ghost" onClick={() => void control("unblock", "night_watch")}>Unblock</button>
          </div>
          {ctrlMsg && <p className="settings-msg">{ctrlMsg}</p>}
        </section>

        {pins.length > 0 && (
          <section className="panel floor-card">
            <h4>📍 PINS <span className="muted">{coin?.symbol}</span></h4>
            <ul className="pin-list">
              {pins.map((p) => (
                <li key={p.id}>
                  <span className={`pin-kind ${p.kind}`}>{p.kind === "high" ? "▲ H" : "▼ L"}</span>
                  <span className="pin-price">${fmtPrice(p.price)}</span>
                  <span className="pin-time">{new Date(p.time * 1000).toLocaleTimeString()}</span>
                  <button className="ghost danger" onClick={() => removePin(p.id)}>✕</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="panel floor-card floor-tape">
          <h4>TRADE TAPE</h4>
          <ul>
            {trades.length === 0 && <li className="muted">No trades yet</li>}
            {trades.map((t) => (
              <li key={t.trade_id} className={t.pnl >= 0 ? "pos" : "neg"}>
                <span className="tape-sym">{t.symbol}</span>
                <span className="tape-pnl">{t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct.toFixed(1)}%</span>
                <span className="tape-reason">{t.exit_reason.replace(/_/g, " ")}</span>
                <span className="tape-time">{new Date(t.ts_exit).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </main>
  );
}
