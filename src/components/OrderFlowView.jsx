import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import {
  Stack,
  TrendUp,
  TrendDown,
  ArrowLeft,
  ShieldCheck,
  Lightning,
} from "@phosphor-icons/react";
import CoinIcon from "./CoinIcon";
import { PageHeader, LivePill, Segmented, StatCard, Metric } from "./ui";
import { fmtPrice, fmtUsd, fmtTime } from "../lib/format";
import {
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
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
];

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
  const [signals, setSignals] = useState([]);
  const [scanning, setScanning] = useState(true);
  const [selectedSignal, setSelectedSignal] = useState(null);
  const [sideFilter, setSideFilter] = useState("all");

  // Background scanner across liquid Binance Futures pairs (all math runs silently)
  const scanMarkets = useCallback(async () => {
    setScanning(true);
    try {
      const results = await Promise.allSettled(
        WATCH_SYMBOLS.map(async (sym) => {
          const rows = await fetch(
            `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${timeframe}&limit=120`,
          ).then((r) => r.json());
          const candles = parseBinanceKlines(rows);
          if (candles.length < 20) return [];
          const hvn = computeHvnProfile(candles, 50);
          const { divergence } = computeDeltaAndCVD(candles);
          const atr14 = computeAtr14(candles);
          const abs = detectAbsorptionSignals(candles, sym, hvn);

          return abs.map((sig) => ({
            ...sig,
            timeframe,
            atr14,
            hasCvdDivergence: Boolean(divergence && divergence.side === sig.side),
            score: Math.min(99, sig.score + (divergence && divergence.side === sig.side ? 5 : 0)),
          }));
        }),
      );

      const merged = [];
      for (const res of results) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
          merged.push(...res.value);
        }
      }
      // Keep latest signal per symbol + sort newest first
      const bySym = new Map();
      for (const s of merged.sort((a, b) => b.time - a.time)) {
        if (!bySym.has(s.symbol)) bySym.set(s.symbol, s);
      }
      setSignals([...bySym.values()].sort((a, b) => b.time - a.time));
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
        setActiveNav={setActiveNav}
      />
    );
  }

  const visibleSignals = signals.filter(
    (s) => sideFilter === "all" || s.side === sideFilter.toUpperCase(),
  );
  const longCount = signals.filter((s) => s.side === "LONG").length;
  const shortCount = signals.filter((s) => s.side === "SHORT").length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Order Flow Scanner"
        eyebrowIcon={Stack}
        title="Order Flow Signals"
        description="Real-time Buyer/Seller Absorption detected strictly at recent swing highs & lows using background Delta, CVD & HVN math."
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

      {/* Compact Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Monitored Futures" value={WATCH_SYMBOLS.length} caption="Binance Perpetuals" />
        <StatCard label="Active Signals" value={signals.length} caption={`${timeframe} Absorption`} highlight />
        <StatCard label="Long Absorption" value={longCount} caption="At recent swing lows" tone="up" />
        <StatCard label="Short Absorption" value={shortCount} caption="At recent swing highs" tone="down" />
      </div>

      {/* Filter Bar */}
      <section className="cw-panel p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lightning weight="duotone" className="w-4 h-4 text-mint" />
            <span className="text-[13px] font-medium text-snow">
              Recent High / Low Absorption Signals
            </span>
          </div>
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

        <div className="grid gap-3 @3xl:grid-cols-2 @5xl:grid-cols-3">
          {visibleSignals.map((sig) => {
            const isLong = sig.side === "LONG";
            const baseCoin = sig.symbol.replace(/USDT$/, "");
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

                  <div className="text-right shrink-0">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        isLong ? "bg-mint/15 text-mint" : "bg-coral/15 text-coral"
                      }`}
                    >
                      {isLong ? <TrendUp weight="bold" className="w-3.5 h-3.5" /> : <TrendDown weight="bold" className="w-3.5 h-3.5" />}
                      {sig.side}
                    </span>
                    <div className="text-[11px] text-fog-2 mt-1 cw-num">Score {sig.score}</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.05] text-[11px]">
                  <div>
                    <div className="text-fog-2">Level</div>
                    <div className="cw-num text-snow font-medium mt-0.5">{fmtPrice(sig.price)}</div>
                  </div>
                  <div>
                    <div className="text-fog-2">Absorbed</div>
                    <div className={`cw-num font-medium mt-0.5 ${isLong ? "text-mint" : "text-coral"}`}>
                      {formatCompactNum(sig.absorbedVol)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-fog-2">Confluence</div>
                    <div className="text-snow font-medium mt-0.5">
                      {sig.nearHvn ? "HVN" : sig.deltaFlip ? "Delta Flip" : "Swing"}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}

          {!visibleSignals.length && (
            <div className="col-span-full py-14 text-center text-[12px] text-fog-2">
              {scanning
                ? "Scanning Binance Futures order flow for absorption at recent highs & lows…"
                : "No recent swing high/low absorption signals right now."}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Clean Chart View for a selected Order Flow Signal:
 * - Only Candlestick chart + 10% opacity Absorption circles at recent swing highs/lows
 * - Entry / SL / TP lines strictly from Risk Setup
 */
function OrderFlowSignalChart({ signal, timeframe, risk, onBack, setActiveNav }) {
  const [candles, setCandles] = useState([]);
  const [absorptions, setAbsorptions] = useState([signal]);
  const [live, setLive] = useState(false);

  const chartWrapRef = useRef(null);
  const chartElRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const priceLinesRef = useRef([]);
  const candlesRef = useRef([]);
  const absorptionsRef = useRef([signal]);

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
      const radius = 24;

      // 10% opacity fill circle (matching screenshot style in Coinwach branding)
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isLong ? "rgba(126, 230, 163, 0.10)" : "rgba(242, 112, 124, 0.10)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isLong ? "rgba(126, 230, 163, 0.65)" : "rgba(242, 112, 124, 0.65)";
      ctx.stroke();

      // Absorbed volume label inside circle
      ctx.fillStyle = "#f1f3f1";
      ctx.font = '600 11px "Funnel Display", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(formatCompactNum(sig.absorbedVol), x, y);
    }
  }, []);

  // Init clean candlestick chart
  useEffect(() => {
    if (!chartElRef.current) return;
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
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      requestAnimationFrame(drawAbsorptionCircles);
    });

    const ro = new ResizeObserver(() => requestAnimationFrame(drawAbsorptionCircles));
    if (chartWrapRef.current) ro.observe(chartWrapRef.current);

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [drawAbsorptionCircles]);

  // Load klines + live WS stream for the selected symbol
  useEffect(() => {
    let alive = true;
    const sym = signal.symbol;
    const load = async () => {
      try {
        const rows = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${timeframe}&limit=160`,
        ).then((r) => r.json());
        if (!alive) return;
        const parsed = parseBinanceKlines(rows);
        candlesRef.current = parsed;
        setCandles(parsed);
        const hvn = computeHvnProfile(parsed, 50);
        const abs = detectAbsorptionSignals(parsed, sym, hvn);
        const list = abs.length ? abs : [signal];
        absorptionsRef.current = list;
        setAbsorptions(list);
      } catch {
        /* ignore */
      }
    };
    load();

    const ws = new WebSocket(
      `wss://fstream.binance.com/ws/${sym.toLowerCase()}@kline_${timeframe}`,
    );
    ws.onopen = () => alive && setLive(true);
    ws.onmessage = (evt) => {
      if (!alive) return;
      try {
        const data = JSON.parse(evt.data);
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
        const list = candlesRef.current;
        const idx = list.findIndex((b) => b.time === t);
        const updated =
          idx >= 0 ? [...list.slice(0, idx), bar, ...list.slice(idx + 1)] : [...list, bar].slice(-180);
        candlesRef.current = updated;
        setCandles(updated);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => alive && setLive(false);

    return () => {
      alive = false;
      ws.close();
    };
  }, [signal, timeframe]);

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

  // Update chart candles + ONLY Entry/SL/TP lines + redraw circles
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
    if (tradePlan) {
      const specs = [
        ["ENTRY", tradePlan.entry, "#a3d9c4", LineStyle.Solid],
        ["SL", tradePlan.stop, "#f2707c", LineStyle.Solid],
        ...(tradePlan.tp1 > 0 ? [["TP", tradePlan.tp1, "#7ee6a3", LineStyle.Dashed]] : []),
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
  }, [candles, tradePlan, absorptions, drawAbsorptionCircles]);

  const baseCoin = signal.symbol.replace(/USDT$/, "");
  const isLong = signal.side === "LONG";

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Order Flow Absorption"
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
        description={`${signal.side} Absorption at recent swing ${isLong ? "low" : "high"} · ${timeframe} Binance Perpetual`}
        actions={
          <>
            <button onClick={onBack} className="cw-btn !h-9">
              <ArrowLeft weight="bold" className="w-4 h-4" /> Back to signals
            </button>
            <LivePill isConnected={live} />
          </>
        }
      />

      {/* Risk Setup Gate / Trade Plan */}
      <section className="cw-panel cw-glow p-4 space-y-3">
        {!risk?.configured ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0b0c0f] px-4 py-3">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-snow">Risk setup required</div>
              <div className="text-[11px] text-fog-2">
                Set your Balance, Risk %, Entry placement &amp; R:R in Settings to plot Entry, SL and TP on the chart.
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
            <div className="grid grid-cols-2 @3xl:grid-cols-5 gap-px overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.06]">
              {[
                ["Entry", tradePlan.entry, "accent"],
                ["Stop loss", tradePlan.stop, "down"],
                ["Take profit", tradePlan.tp1, "up"],
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
      </section>

      {/* Clean Candlestick Chart with 10% Opacity Absorption Circle Overlay */}
      <section className="cw-panel p-3 md:p-4">
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
      </section>
    </div>
  );
}
