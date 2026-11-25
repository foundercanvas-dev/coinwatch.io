import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import {
  Stack,
  TrendUp,
  TrendDown,
  ArrowLeft,
  ShieldCheck,
  Lightning,
  ShieldWarning,
} from "@phosphor-icons/react";
import CoinIcon from "./CoinIcon";
import { PageHeader, LivePill, Segmented, StatCard, Metric } from "./ui";
import { fmtPrice, fmtUsd, fmtTime, pct } from "../lib/format";
import {
  analyzeDomHeatmap,
  computeAtr14,
  computeDeltaAndCVD,
  computeHvnProfile,
  detectAbsorptionSignals,
} from "../lib/orderflowMath";
import { calculateSmartEntry, calculateTradePlan } from "../lib/tradeMath";

const WATCH_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "NEARUSDT",
  "ARBUSDT",
  "OPUSDT",
];

const TIMEFRAMES = [
  { value: "1m", label: "1m" },
  { value: "3m", label: "3m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const IV_SEC = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;

function parseBinanceKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((k) => {
    const vol = Number(k[5]);
    const buyVol = Number(k[9]);
    return {
      time: Math.floor(Number(k[0]) / 1000) + TZ_SHIFT,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: vol,
      buyVol,
      sellVol: Math.max(0, vol - buyVol),
    };
  });
}

function formatCompactNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export default function OrderFlowView({ risk, setActiveNav }) {
  const [timeframe, setTimeframe] = useState("5m");
  const [tab, setTab] = useState("active"); // active | history
  const [signals, setSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [flowStats, setFlowStats] = useState({ inflowUsd: 0, outflowUsd: 0 });
  const [scanning, setScanning] = useState(true);
  const [selectedSignal, setSelectedSignal] = useState(null);
  const [sideFilter, setSideFilter] = useState("all");

  // Background scanner across liquid Binance Futures pairs (all math runs silently)
  const scanMarkets = useCallback(async () => {
    setScanning(true);
    try {
      let totalInflowUsd = 0;
      let totalOutflowUsd = 0;

      const results = await Promise.allSettled(
        WATCH_SYMBOLS.map(async (sym) => {
          const rows = await fetch(
            `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${timeframe}&limit=120`,
          ).then((r) => r.json());
          const candles = parseBinanceKlines(rows);
          if (candles.length < 20) return [];

          // Sum recent 12 candles buy/sell USD flow for live Inflow / Outflow cards
          for (const c of candles.slice(-12)) {
            totalInflowUsd += (c.buyVol || 0) * c.close;
            totalOutflowUsd += (c.sellVol || 0) * c.close;
          }

          const hvn = computeHvnProfile(candles, 50);
          const { divergence } = computeDeltaAndCVD(candles);
          const atr14 = computeAtr14(candles);
          const abs = detectAbsorptionSignals(candles, sym, hvn, { includeStopped: true });

          return abs.map((sig) => ({
            ...sig,
            timeframe,
            atr14,
            hasCvdDivergence: Boolean(divergence && divergence.side === sig.side),
            score: Math.min(99, sig.score + (divergence && divergence.side === sig.side ? 5 : 0)),
          }));
        }),
      );

      setFlowStats({ inflowUsd: totalInflowUsd, outflowUsd: totalOutflowUsd });

      const activeMerged = [];
      const historyMerged = [];
      for (const res of results) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
          for (const s of res.value) {
            if (s.stoppedOut || s.reversed) historyMerged.push(s);
            else activeMerged.push(s);
          }
        }
      }
      // Keep latest active signal per symbol
      const bySym = new Map();
      for (const s of activeMerged.sort((a, b) => b.time - a.time)) {
        if (!bySym.has(s.symbol)) bySym.set(s.symbol, s);
      }
      setSignals([...bySym.values()].sort((a, b) => b.time - a.time));
      setHistorySignals(historyMerged.sort((a, b) => b.time - a.time).slice(0, 30));
    } catch {
      /* keep previous signals */
    } finally {
      setScanning(false);
    }
  }, [timeframe]);

  useEffect(() => {
    scanMarkets();
    const timer = setInterval(scanMarkets, 25000);
    return () => clearInterval(timer);
  }, [scanMarkets]);

  if (selectedSignal) {
    return (
      <OrderFlowSignalChart
        signal={selectedSignal}
        timeframe={timeframe}
        risk={risk}
        onBack={() => setSelectedSignal(null)}
        onSwitchSignal={(nextSig) => setSelectedSignal(nextSig)}
        setActiveNav={setActiveNav}
      />
    );
  }

  const sourceList = tab === "active" ? signals : historySignals;
  const visibleSignals = sourceList.filter(
    (s) => sideFilter === "all" || s.side === sideFilter.toUpperCase(),
  );
  const longCount = signals.filter((s) => s.side === "LONG").length;
  const shortCount = signals.filter((s) => s.side === "SHORT").length;
  const totalFlow = flowStats.inflowUsd + flowStats.outflowUsd;
  const inflowPct = totalFlow > 0 ? (flowStats.inflowUsd / totalFlow) * 100 : 50;
  const outflowPct = 100 - inflowPct;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Live Signals"
        eyebrowIcon={Stack}
        title="Order Flow"
        description="Clean trade setups at key highs and lows. Pick any signal to view Entry, Stop Loss, and live order depth."
        actions={
          <>
            <Segmented
              size="sm"
              value={timeframe}
              onChange={setTimeframe}
              options={TIMEFRAMES}
            />
            <LivePill isConnected={!scanning || signals.length > 0} />
          </>
        }
      />

      {/* Live Crypto Inflow / Outflow 2 Cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="cw-panel cw-glow cw-glow-soft p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fog">
              <TrendUp weight="bold" className="w-4 h-4 text-mint" /> Crypto Inflow (Live)
            </span>
            <span className="cw-num text-[20px] font-bold text-mint">{inflowPct.toFixed(1)}%</span>
          </div>
          <div className="cw-num text-[22px] font-semibold text-snow">{fmtUsd(flowStats.inflowUsd)}</div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full bg-mint transition-[width] duration-500" style={{ width: `${inflowPct}%` }} />
          </div>
        </div>

        <div className="cw-panel cw-glow cw-glow-soft p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fog">
              <TrendDown weight="bold" className="w-4 h-4 text-coral" /> Crypto Outflow (Live)
            </span>
            <span className="cw-num text-[20px] font-bold text-coral">{outflowPct.toFixed(1)}%</span>
          </div>
          <div className="cw-num text-[22px] font-semibold text-snow">{fmtUsd(flowStats.outflowUsd)}</div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full bg-coral transition-[width] duration-500" style={{ width: `${outflowPct}%` }} />
          </div>
        </div>
      </div>

      {/* Compact Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Watched Pairs" value={WATCH_SYMBOLS.length} caption="Live market feed" />
        <StatCard label="Active Setups" value={signals.length} caption={`${timeframe} timeframe`} highlight />
        <StatCard label="Buy Setups" value={longCount} caption="Near recent lows" tone="up" />
        <StatCard label="Sell Setups" value={shortCount} caption="Near recent highs" tone="down" />
      </div>

      {/* Filter Bar + Active / History */}
      <section className="cw-panel p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "active", label: "Active", badge: signals.length },
              { value: "history", label: "History", badge: historySignals.length },
            ]}
          />
          <Segmented
            size="sm"
            value={sideFilter}
            onChange={setSideFilter}
            options={[
              { value: "all", label: "All" },
              { value: "long", label: "Long" },
              { value: "short", label: "Short" },
            ]}
          />
        </div>

        <div className="grid gap-3 @3xl:grid-cols-2">
          {visibleSignals.map((sig) => {
            const isLong = sig.side === "LONG";
            const baseCoin = sig.symbol.replace(/USDT$/, "");
            const moveVal = Number(sig.movePct || 0);
            return (
              <button
                key={sig.id}
                type="button"
                onClick={() => setSelectedSignal(sig)}
                className="cw-card cw-hover cw-press text-left p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <CoinIcon
                      symbol={sig.symbol}
                      coin={baseCoin}
                      exchange="binance"
                      className="w-8 h-8 shrink-0"
                      isPump={isLong}
                    />
                    <div className="min-w-0">
                      <div className="text-[14px] font-semibold text-snow truncate">
                        {baseCoin}
                        <span className="text-fog-2 font-normal">/USDT</span>
                      </div>
                      <div className="text-[11px] text-fog-2 cw-num">
                        {fmtTime((sig.time - TZ_SHIFT) * 1000)} · {sig.timeframe}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      {(sig.stoppedOut || sig.reversed) && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/[0.06] text-fog">
                          {sig.reversed ? "Reversed" : "Stopped out"}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          isLong ? "bg-mint/15 text-mint" : "bg-coral/15 text-coral"
                        }`}
                      >
                        {isLong ? <TrendUp weight="bold" className="w-3.5 h-3.5" /> : <TrendDown weight="bold" className="w-3.5 h-3.5" />}
                        {sig.side}
                      </span>
                    </div>
                    <div className={`cw-num text-[13px] font-semibold ${moveVal >= 0 ? "text-mint" : "text-coral"}`}>
                      {pct(moveVal)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.05] text-[11px]">
                  <div>
                    <div className="text-fog-2">Price</div>
                    <div className="cw-num text-snow font-medium mt-0.5">{fmtPrice(sig.price)}</div>
                  </div>
                  <div>
                    <div className="text-fog-2">Volume</div>
                    <div className={`cw-num font-medium mt-0.5 ${isLong ? "text-mint" : "text-coral"}`}>
                      {formatCompactNum(sig.absorbedVol)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-fog-2">Zone</div>
                    <div className="text-snow font-medium mt-0.5">
                      {isLong ? "Recent Low" : "Recent High"}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}

          {!visibleSignals.length && (
            <div className="col-span-full py-14 text-center text-[12px] text-fog-2">
              {tab === "history"
                ? "No stopped-out setups in history yet."
                : scanning
                  ? "Looking for clean setups at recent highs and lows…"
                  : "No active setups right now. Check back shortly."}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function precisionFor(p) {
  if (!p) return 2;
  if (p >= 1000) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  if (p >= 0.0001) return 7;
  return 8;
}

/**
 * Clean Chart View for a selected Order Flow Signal:
 * - Real-time Candlestick chart + 10% opacity Absorption circles at recent swing highs/lows
 * - Entry / SL / TP lines strictly from Risk Setup
 * - MBO DOM Heatmap side panel (100ms depth + Wall + Spoof alerts)
 */
function OrderFlowSignalChart({ signal, timeframe, risk, onBack, onSwitchSignal, setActiveNav }) {
  const [chartIv, setChartIv] = useState(timeframe || "5m");
  const [candles, setCandles] = useState([]);
  const [absorptions, setAbsorptions] = useState([signal]);
  const [live, setLive] = useState(false);
  const [lastPrice, setLastPrice] = useState(signal.price || 0);
  const [liveVol, setLiveVol] = useState({ buyUsd: 0, sellUsd: 0 });
  const [dom, setDom] = useState({ bids: [], asks: [], buyWalls: [], sellWalls: [], spoofs: [] });
  const [spoofLog, setSpoofLog] = useState([]);
  const [popupDismissedId, setPopupDismissedId] = useState(null);

  const chartWrapRef = useRef(null);
  const chartElRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const priceLinesRef = useRef([]);
  const candlesRef = useRef([]);
  const absorptionsRef = useRef([signal]);
  const wallTrackerRef = useRef(new Map());
  const seededRef = useRef(false);

  const drawAbsorptionCircles = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const ts = chart.timeScale();
    for (const sig of absorptionsRef.current) {
      const x = ts.timeToCoordinate(sig.time);
      const y = series.priceToCoordinate(sig.price);
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;

      const isLong = sig.side === "LONG";
      const isCurrent = sig.time === signal.time && sig.side === signal.side;
      const radius = isCurrent ? 25 : 16;

      // Active setup circle is bright & crisp; past setups are smaller and dimmed
      if (isCurrent) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = isLong ? "rgba(126, 230, 163, 0.22)" : "rgba(242, 112, 124, 0.22)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isCurrent
        ? isLong
          ? "rgba(126, 230, 163, 0.12)"
          : "rgba(242, 112, 124, 0.12)"
        : isLong
          ? "rgba(126, 230, 163, 0.05)"
          : "rgba(242, 112, 124, 0.05)";
      ctx.fill();
      ctx.lineWidth = isCurrent ? 1.75 : 1;
      ctx.strokeStyle = isCurrent
        ? isLong
          ? "rgba(126, 230, 163, 0.80)"
          : "rgba(242, 112, 124, 0.80)"
        : isLong
          ? "rgba(126, 230, 163, 0.28)"
          : "rgba(242, 112, 124, 0.28)";
      ctx.stroke();

      // Volume label inside circle
      ctx.fillStyle = isCurrent ? "#f1f3f1" : "rgba(241, 243, 241, 0.55)";
      ctx.font = isCurrent
        ? '600 11px "Funnel Display", sans-serif'
        : '500 9.5px "Funnel Display", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(formatCompactNum(sig.absorbedVol), x, y);
    }
  }, [signal.time, signal.side]);

  // Init clean candlestick chart
  useEffect(() => {
    if (!chartElRef.current) return;
    const prec = precisionFor(signal.price);
    const chart = createChart(chartElRef.current, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#7c827f",
        fontFamily: "Funnel Display, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.025)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.06)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 9,
        rightOffset: 4,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(126,230,163,0.35)", labelBackgroundColor: "#1c1d22" },
        horzLine: { color: "rgba(126,230,163,0.35)", labelBackgroundColor: "#1c1d22" },
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#7ee6a3",
      downColor: "#f2707c",
      borderVisible: false,
      wickUpColor: "#7ee6a3",
      wickDownColor: "#f2707c",
      priceFormat: { type: "price", precision: prec, minMove: Math.pow(10, -prec) },
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      requestAnimationFrame(drawAbsorptionCircles);
    });

    const ro = new ResizeObserver(() => requestAnimationFrame(drawAbsorptionCircles));
    if (chartWrapRef.current) ro.observe(chartWrapRef.current);

    chartRef.current = chart;
    seriesRef.current = series;
    seededRef.current = false;

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [drawAbsorptionCircles, signal.price]);

  // Load klines + depth + combined live WebSocket (aggTrade + depth20@100ms + kline)
  useEffect(() => {
    let alive = true;
    const sym = signal.symbol;
    const symLower = sym.toLowerCase();
    const ivSec = IV_SEC[chartIv] || 300;
    wallTrackerRef.current.clear();
    setSpoofLog([]);
    seededRef.current = false;

    const load = async () => {
      try {
        const [klineRows, depthData] = await Promise.all([
          fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${chartIv}&limit=180`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=500`).then((r) => r.json()),
        ]);
        if (!alive) return;
        const parsed = parseBinanceKlines(klineRows);
        candlesRef.current = parsed;
        setCandles(parsed);
        if (parsed.length) {
          const lastBar = parsed[parsed.length - 1];
          setLastPrice(lastBar.close);
          setLiveVol({
            buyUsd: (lastBar.buyVol || 0) * lastBar.close,
            sellUsd: (lastBar.sellVol || 0) * lastBar.close,
          });
        }
        const hvn = computeHvnProfile(parsed, 50);
        const abs = detectAbsorptionSignals(parsed, sym, hvn);
        const list = abs.length ? abs : [signal];
        absorptionsRef.current = list;
        setAbsorptions(list);

        if (depthData?.bids) {
          setDom(
            analyzeDomHeatmap(
              depthData.bids,
              depthData.asks,
              wallTrackerRef.current,
              Date.now(),
              parsed[parsed.length - 1]?.close || signal.price,
            ),
          );
        }
      } catch {
        /* ignore */
      }
    };
    load();

    let ws = null;
    let reconnectTimer = null;
    const connect = () => {
      if (!alive) return;
      ws = new WebSocket(
        `wss://fstream.binance.com/stream?streams=${symLower}@aggTrade/${symLower}@depth20@100ms/${symLower}@kline_${chartIv}`,
      );
      ws.onopen = () => alive && setLive(true);
      ws.onmessage = (evt) => {
        if (!alive) return;
        try {
          const msg = JSON.parse(evt.data);
          const stream = msg.stream || "";
          const data = msg.data;
          if (!data) return;

          if (stream.endsWith("@aggTrade")) {
            const price = Number(data.p);
            const qty = Number(data.q);
            const isSell = Boolean(data.m);
            const tradeSec = Math.floor(Number(data.T || Date.now()) / 1000);
            const bucketTime = Math.floor(tradeSec / ivSec) * ivSec + TZ_SHIFT;
            if (!(price > 0)) return;
            setLastPrice(price);
            const list = candlesRef.current;
            if (list.length) {
              const last = list[list.length - 1];
              if (bucketTime > last.time) {
                const newBar = {
                  time: bucketTime,
                  open: last.close,
                  high: Math.max(last.close, price),
                  low: Math.min(last.close, price),
                  close: price,
                  volume: qty,
                  buyVol: isSell ? 0 : qty,
                  sellVol: isSell ? qty : 0,
                };
                candlesRef.current = [...list, newBar].slice(-200);
                setLiveVol({
                  buyUsd: newBar.buyVol * price,
                  sellUsd: newBar.sellVol * price,
                });
                try {
                  seriesRef.current?.update(newBar);
                  requestAnimationFrame(drawAbsorptionCircles);
                } catch {
                  /* ignore */
                }
              } else if (bucketTime === last.time) {
                const updatedLast = {
                  ...last,
                  close: price,
                  high: Math.max(last.high, price),
                  low: Math.min(last.low, price),
                  volume: last.volume + qty,
                  buyVol: last.buyVol + (isSell ? 0 : qty),
                  sellVol: last.sellVol + (isSell ? qty : 0),
                };
                candlesRef.current = [...list.slice(0, -1), updatedLast];
                setLiveVol({
                  buyUsd: updatedLast.buyVol * price,
                  sellUsd: updatedLast.sellVol * price,
                });
                try {
                  seriesRef.current?.update(updatedLast);
                  requestAnimationFrame(drawAbsorptionCircles);
                } catch {
                  /* ignore */
                }
              }
            }
          } else if (stream.includes("@depth20")) {
            const curPrice = candlesRef.current[candlesRef.current.length - 1]?.close || signal.price;
            const analyzed = analyzeDomHeatmap(
              data.b || data.bids,
              data.a || data.asks,
              wallTrackerRef.current,
              Date.now(),
              curPrice,
            );
            setDom(analyzed);
            if (analyzed.spoofs.length) {
              setSpoofLog((prev) => [...analyzed.spoofs, ...prev].slice(0, 6));
            }
          } else if (stream.includes("@kline_")) {
            const k = data.k;
            if (!k) return;
            const t = Math.floor(Number(k.t) / 1000) + TZ_SHIFT;
            const vol = Number(k.v);
            const buyVol = Number(k.V);
            const bar = {
              time: t,
              open: Number(k.o),
              high: Number(k.h),
              low: Number(k.l),
              close: Number(k.c),
              volume: vol,
              buyVol,
              sellVol: Math.max(0, vol - buyVol),
            };
            setLastPrice(bar.close);
            setLiveVol({
              buyUsd: bar.buyVol * bar.close,
              sellUsd: bar.sellVol * bar.close,
            });
            const list = candlesRef.current;
            const last = list[list.length - 1];
            if (!last || t >= last.time) {
              const idx = list.findIndex((b) => b.time === t);
              const updated =
                idx >= 0 ? [...list.slice(0, idx), bar, ...list.slice(idx + 1)] : [...list, bar].slice(-200);
              candlesRef.current = updated;
              if (k.x) {
                const hvn = computeHvnProfile(updated, 50);
                const abs = detectAbsorptionSignals(updated, sym, hvn);
                if (abs.length) {
                  absorptionsRef.current = abs;
                  setAbsorptions(abs);
                }
              }
              try {
                seriesRef.current?.update(bar);
                requestAnimationFrame(drawAbsorptionCircles);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        setLive(false);
        reconnectTimer = setTimeout(connect, 2500);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    // Periodic lightweight REST sync so bars never stall
    const syncTimer = setInterval(async () => {
      try {
        const rows = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${chartIv}&limit=5`,
        ).then((r) => r.json());
        if (!alive) return;
        const fresh = parseBinanceKlines(rows);
        for (const bar of fresh) {
          const list = candlesRef.current;
          const last = list[list.length - 1];
          if (!last || bar.time >= last.time) {
            const idx = list.findIndex((b) => b.time === bar.time);
            candlesRef.current =
              idx >= 0 ? [...list.slice(0, idx), bar, ...list.slice(idx + 1)] : [...list, bar].slice(-200);
            try {
              seriesRef.current?.update(bar);
            } catch {
              /* ignore */
            }
          }
        }
        const hvn = computeHvnProfile(candlesRef.current, 50);
        const abs = detectAbsorptionSignals(candlesRef.current, sym, hvn);
        if (abs.length) {
          absorptionsRef.current = abs;
          setAbsorptions(abs);
        }
        requestAnimationFrame(drawAbsorptionCircles);
      } catch {
        /* ignore */
      }
    }, 12000);

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearInterval(syncTimer);
      ws?.close();
    };
  }, [signal, chartIv, drawAbsorptionCircles]);

  // Risk Setup Trade Plan (mandatory)
  const tradePlan = useMemo(() => {
    if (!risk?.configured) return null;
    const entry = calculateSmartEntry({
      triggerClose: signal.triggerClose || signal.price,
      open: signal.open,
      high: signal.high,
      low: signal.low,
      side: signal.side,
      atrAbs: signal.atr14 || 0,
      currentPrice: candles[candles.length - 1]?.close || signal.price,
      entryMode: risk.entryMode || "retest",
    });
    const stopLoss = signal.side === "SHORT" ? signal.high : signal.low;
    return calculateTradePlan({
      entry,
      side: signal.side,
      stopLoss,
      atrAbs: signal.atr14 || 0,
      rewardRatio: Number(risk.rewardRatio) || 1.5,
      balance: Number(risk.balance) || 10000,
      riskPct: Math.min(Number(risk.riskPerTrade) || 1, Number(risk.maxLoss) || Infinity),
    });
  }, [risk, signal, candles]);

  // Detect opposite-side reversal after this signal
  const reversalSignal = useMemo(() => {
    const rev = absorptions.find((s) => s.time > signal.time && s.side !== signal.side);
    return rev || null;
  }, [absorptions, signal.time, signal.side]);

  // Check if SL was hit (either on load or live)
  const isStoppedOut = useMemo(() => {
    if (signal.stoppedOut) return true;
    const stopPrice = tradePlan?.stop || (signal.side === "SHORT" ? signal.high : signal.low);
    if (!(stopPrice > 0)) return false;
    if (lastPrice > 0) {
      if (signal.side === "LONG" && lastPrice <= stopPrice) return true;
      if (signal.side === "SHORT" && lastPrice >= stopPrice) return true;
    }
    for (const c of candles) {
      if (c.time <= signal.time) continue;
      if (signal.side === "LONG" && c.low <= stopPrice) return true;
      if (signal.side === "SHORT" && c.high >= stopPrice) return true;
    }
    return false;
  }, [signal, tradePlan, lastPrice, candles]);

  // Check whether pullback Entry has been filled yet
  const entryFilled = useMemo(() => {
    const entryPrice = tradePlan?.entry;
    if (!(entryPrice > 0)) return false;
    for (const c of candles) {
      if (c.time < signal.time) continue;
      if (signal.side === "LONG" && c.low <= entryPrice) return true;
      if (signal.side === "SHORT" && c.high >= entryPrice) return true;
    }
    if (lastPrice > 0) {
      if (signal.side === "LONG" && lastPrice <= entryPrice) return true;
      if (signal.side === "SHORT" && lastPrice >= entryPrice) return true;
    }
    return false;
  }, [tradePlan, candles, signal.time, signal.side, lastPrice]);

  const setupClosed = isStoppedOut || Boolean(reversalSignal);

  // Update chart candles + ONLY Entry/SL lines (removed when stopped out or reversed) + redraw circles
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.length) return;

    const seen = new Set();
    const clean = [];
    for (const c of [...candles].sort((a, b) => a.time - b.time)) {
      if (!Number.isFinite(c.time) || seen.has(c.time)) continue;
      seen.add(c.time);
      clean.push(c);
    }
    try {
      series.setData(clean);
    } catch {
      /* ignore */
    }

    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* ignore */
      }
    }
    const lines = [];
    if (tradePlan && !setupClosed) {
      const specs = [
        ["ENTRY", tradePlan.entry, "#a3d9c4", LineStyle.Solid],
        ["SL", tradePlan.stop, "#f2707c", LineStyle.Solid],
      ];
      for (const [title, price, color, lineStyle] of specs) {
        if (!(price > 0)) continue;
        try {
          lines.push(
            series.createPriceLine({
              price,
              title,
              color,
              lineStyle,
              lineWidth: 2,
              lineVisible: true,
              axisLabelVisible: true,
            }),
          );
        } catch {
          /* ignore */
        }
      }
    }
    priceLinesRef.current = lines;
    requestAnimationFrame(drawAbsorptionCircles);
  }, [candles, tradePlan, setupClosed, absorptions, drawAbsorptionCircles]);

  const baseCoin = signal.symbol.replace(/USDT$/, "");
  const isLong = signal.side === "LONG";

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Trade Setup"
        eyebrowIcon={Stack}
        title={
          <span className="inline-flex items-center gap-3">
            <CoinIcon
              symbol={signal.symbol}
              coin={baseCoin}
              exchange="binance"
              className="w-9 h-9"
              isPump={isLong}
            />
            {baseCoin}/USDT
          </span>
        }
        description={
          <span className="inline-flex items-center gap-2">
            <span>{`${isLong ? "Buy" : "Sell"} setup near recent ${isLong ? "low" : "high"} · ${chartIv}`}</span>
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                reversalSignal
                  ? "bg-terminal-yellow/15 text-terminal-yellow"
                  : isStoppedOut
                    ? "bg-coral/15 text-coral"
                    : entryFilled
                      ? "bg-mint/15 text-mint"
                      : "bg-white/[0.06] text-fog"
              }`}
            >
              {reversalSignal
                ? "Reversed"
                : isStoppedOut
                  ? "Stopped out"
                  : entryFilled
                    ? "Active"
                    : "Waiting"}
            </span>
          </span>
        }
        actions={
          <>
            <Segmented
              size="sm"
              value={chartIv}
              onChange={setChartIv}
              options={TIMEFRAMES}
            />
            <button onClick={onBack} className="cw-btn !h-9">
              <ArrowLeft weight="bold" className="w-4 h-4" /> Back to signals
            </button>
            <LivePill isConnected={live} />
          </>
        }
      />

      {/* Actionable Popup Notification on Reversal or Signal Close */}
      {(() => {
        const activePopupKey = reversalSignal
          ? `rev-${reversalSignal.id}`
          : isStoppedOut
            ? `stop-${signal.id}`
            : null;
        if (!activePopupKey || popupDismissedId === activePopupKey) return null;

        return (
          <div className="fixed bottom-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2rem)] cw-panel cw-glow p-4 shadow-2xl border border-white/[0.12] space-y-3">
            {reversalSignal ? (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-semibold text-terminal-yellow">
                      Setup Reversing — Exit {signal.side}
                    </div>
                    <p className="mt-1 text-[11px] text-fog-2">
                      Opposite {reversalSignal.side === "LONG" ? "Buy" : "Sell"} setup triggered at{" "}
                      <span className="cw-num text-snow">{fmtPrice(reversalSignal.price)}</span>. Exit current trade or switch sides.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPopupDismissedId(activePopupKey)}
                    className="text-fog-2 hover:text-snow text-[13px] px-1"
                    aria-label="Dismiss notification"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSwitchSignal?.({ ...reversalSignal, timeframe: chartIv, atr14: signal.atr14 })}
                    className="cw-btn cw-btn-primary !h-8 !px-3 !text-[11px] flex-1"
                  >
                    Switch to {reversalSignal.side} Entry
                  </button>
                  <button
                    type="button"
                    onClick={onBack}
                    className="cw-btn !h-8 !px-3 !text-[11px]"
                  >
                    Back to Scanner
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-semibold text-coral">
                      Signal Closed — Stopped Out
                    </div>
                    <p className="mt-1 text-[11px] text-fog-2">
                      {baseCoin}/USDT reached Stop Loss. This setup has been closed and moved to History.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPopupDismissedId(activePopupKey)}
                    className="text-fog-2 hover:text-snow text-[13px] px-1"
                    aria-label="Dismiss notification"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onBack}
                    className="cw-btn cw-btn-primary !h-8 !px-3 !text-[11px] flex-1"
                  >
                    Back to Scanner
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Risk Setup Gate / Trade Plan + Live Volume Bar */}
      <section className="cw-panel cw-glow p-4 space-y-3">
        {setupClosed ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-coral/30 bg-coral/[0.06] px-4 py-3">
            <div className="space-y-0.5">
              <div className="text-[13px] font-semibold text-coral">
                {reversalSignal ? `Reversed — Exit ${signal.side}` : "Stopped out"}
              </div>
              <div className="text-[11px] text-fog-2">
                {reversalSignal
                  ? `Opposite ${reversalSignal.side} setup appeared — Entry & SL removed.`
                  : "Stop loss level was reached — Entry & SL removed from chart."}
              </div>
            </div>
            {reversalSignal ? (
              <button
                type="button"
                onClick={() => onSwitchSignal?.({ ...reversalSignal, timeframe: chartIv, atr14: signal.atr14 })}
                className="cw-btn cw-btn-primary !h-8 !px-3 !text-[11px]"
              >
                Switch to {reversalSignal.side}
              </button>
            ) : (
              <button type="button" onClick={onBack} className="cw-btn !h-8 !px-3 !text-[11px]">
                Back to Scanner
              </button>
            )}
          </div>
        ) : !risk?.configured ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0b0c0f] px-4 py-3">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-snow">Risk setup required</div>
              <div className="text-[11px] text-fog-2">
                Set your Balance &amp; Risk % in Settings first to calculate Entry, Stop Loss, and Position Size.
              </div>
            </div>
            <button
              onClick={() => setActiveNav?.("settings")}
              className="cw-btn cw-btn-primary !h-8 !px-3.5 !text-[12px] shrink-0"
            >
              <ShieldCheck weight="duotone" className="w-4 h-4" /> Setup Risk
            </button>
          </div>
        ) : (
          tradePlan && (
            <div className="grid grid-cols-2 @3xl:grid-cols-4 gap-px overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.06]">
              {[
                ["Entry", tradePlan.entry, "accent"],
                ["Stop loss", tradePlan.stop, "down"],
                ["Position size", fmtUsd(tradePlan.positionUsd), "default"],
                ["Max risk", fmtUsd(tradePlan.riskUsd), "muted"],
              ].map(([label, value, tone]) => (
                <div key={label} className="bg-[#0b0c0f] px-3 py-2.5">
                  <Metric
                    label={label}
                    value={typeof value === "string" ? value : fmtPrice(value)}
                    tone={tone}
                  />
                </div>
              ))}
            </div>
          )
        )}

        {/* Live Volume Bar below Entry / SL */}
        {(() => {
          const totalUsd = liveVol.buyUsd + liveVol.sellUsd;
          const buyPct = totalUsd > 0 ? (liveVol.buyUsd / totalUsd) * 100 : 50;
          const sellPct = 100 - buyPct;
          return (
            <div className="relative h-12 overflow-hidden rounded-xl border border-white/[0.07] bg-[#0b0c0f]">
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-mint/[0.24] via-mint/[0.13] to-mint/[0.03] transition-[width] duration-300"
                style={{ width: `${buyPct}%` }}
              />
              <div
                className="absolute inset-y-0 right-0 bg-gradient-to-l from-coral/[0.24] via-coral/[0.13] to-coral/[0.03] transition-[width] duration-300"
                style={{ width: `${sellPct}%` }}
              />
              <div className="relative flex h-full items-center justify-between gap-2 px-4 text-[12px] cw-num">
                <span className="text-mint font-semibold">
                  Buy {fmtUsd(liveVol.buyUsd)} <span className="opacity-80">({buyPct.toFixed(0)}%)</span>
                </span>
                <span className="hidden sm:inline text-fog-2">
                  {chartIv} Volume: <strong className="text-snow">{fmtUsd(totalUsd)}</strong>
                </span>
                <span className="text-coral font-semibold">
                  Sell {fmtUsd(liveVol.sellUsd)} <span className="opacity-80">({sellPct.toFixed(0)}%)</span>
                </span>
              </div>
            </div>
          );
        })()}
      </section>

      {/* Clean Candlestick Chart with 10% Opacity Absorption Circle Overlay + MBO DOM Side Panel */}
      <section className="cw-panel p-3 md:p-4">
        <div className="grid gap-3 @5xl:grid-cols-[1fr_280px]">
          <div
            ref={chartWrapRef}
            className="relative h-[480px] rounded-xl border border-white/[0.06] bg-[#0b0c0f] overflow-hidden"
          >
            <div ref={chartElRef} className="absolute inset-0" />
            <canvas
              ref={overlayCanvasRef}
              className="pointer-events-none absolute inset-0 z-10 w-full h-full"
            />
            {!candles.length && (
              <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fog-2">
                Loading chart…
              </div>
            )}
          </div>

          {/* Order Book Side Panel */}
          <div className="rounded-xl border border-white/[0.06] bg-[#0b0c0f] flex flex-col h-[480px] overflow-hidden">
            <div className="px-3 py-2.5 border-b border-white/[0.05] flex items-center justify-between gap-2">
              <div>
                <div className="text-[12px] font-semibold text-snow">Order Book</div>
                <div className="text-[10px] text-fog-2">Live depth &amp; big orders</div>
              </div>
              {spoofLog.length > 0 ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-yellow/15 border border-terminal-yellow/35 text-terminal-yellow text-[10px] font-semibold">
                  <ShieldWarning weight="fill" className="w-3 h-3" /> Pulled ({spoofLog.length})
                </span>
              ) : (
                <span className={`text-[10px] ${dom.bids.length ? "text-mint" : "text-fog-2"}`}>
                  {dom.bids.length ? "Live" : "Syncing"}
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 px-2.5 py-1.5 text-[10px] text-fog-2 border-b border-white/[0.05]">
              <span>Price</span>
              <span className="text-right">Size</span>
              <span className="text-right">Value</span>
            </div>

            <div className="flex-1 overflow-y-auto cw-num text-[11px] flex flex-col justify-between">
              <div>
                {dom.asks.slice(-11).map((a) => (
                  <div key={`a-${a.price}`} className="relative grid grid-cols-3 px-2.5 py-1 items-center">
                    <span
                      className="absolute inset-y-0 right-0 pointer-events-none"
                      style={{
                        width: `${Math.round(a.intensity * 100)}%`,
                        background: a.isWall
                          ? "rgba(242, 112, 124, 0.34)"
                          : "rgba(242, 112, 124, 0.12)",
                      }}
                    />
                    <span className="relative text-coral">{fmtPrice(a.price)}</span>
                    <span className="relative text-right text-snow">{a.qty.toFixed(2)}</span>
                    <span className="relative text-right">
                      {a.isWall ? (
                        <span className="text-[9px] px-1 rounded bg-coral/25 text-coral font-semibold">
                          {a.ratio}x
                        </span>
                      ) : (
                        <span className="text-fog-2 text-[10px]">{fmtUsd(a.usd)}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              <div className="px-2.5 py-1.5 border-y border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
                <span className="text-[13px] font-semibold text-mint">{fmtPrice(lastPrice)}</span>
                <span className="text-[10px] text-fog-2">MID</span>
              </div>

              <div>
                {dom.bids.slice(0, 11).map((b) => (
                  <div key={`b-${b.price}`} className="relative grid grid-cols-3 px-2.5 py-1 items-center">
                    <span
                      className="absolute inset-y-0 right-0 pointer-events-none"
                      style={{
                        width: `${Math.round(b.intensity * 100)}%`,
                        background: b.isWall
                          ? "rgba(126, 230, 163, 0.34)"
                          : "rgba(126, 230, 163, 0.12)",
                      }}
                    />
                    <span className="relative text-mint">{fmtPrice(b.price)}</span>
                    <span className="relative text-right text-snow">{b.qty.toFixed(2)}</span>
                    <span className="relative text-right">
                      {b.isWall ? (
                        <span className="text-[9px] px-1 rounded bg-mint/25 text-mint font-semibold">
                          {b.ratio}x
                        </span>
                      ) : (
                        <span className="text-fog-2 text-[10px]">{fmtUsd(b.usd)}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {spoofLog.length > 0 && (
              <div className="px-2.5 py-1.5 border-t border-terminal-yellow/25 bg-terminal-yellow/[0.05] flex items-center justify-between text-[10px] cw-num">
                <span className="text-terminal-yellow font-medium">
                  Large order pulled @ {fmtPrice(spoofLog[0].price)}
                </span>
                <span className="text-fog-2">{(spoofLog[0].ageMs / 1000).toFixed(1)}s</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
