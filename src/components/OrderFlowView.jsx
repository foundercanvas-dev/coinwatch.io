import React, { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import {
  Stack,
  Lightning,
  TrendUp,
  TrendDown,
  ChartBar,
  ShieldWarning,
  Play,
  BookOpen,
  CaretDown,
  ArrowUpRight,
  Pulse,
} from "@phosphor-icons/react";
import CoinIcon from "./CoinIcon";
import { PageHeader, LivePill, Segmented, StatCard } from "./ui";
import { fmtPrice, fmtUsd, pct, fmtTime } from "../lib/format";
import {
  analyzeDomHeatmap,
  buildFootprintLevels,
  calculateOrderFlowPlan,
  computeAtr14,
  computeDeltaAndCVD,
  computeHvnProfile,
  detectAbsorptionSignals,
  runOrderFlowBacktest,
} from "../lib/orderflowMath";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const TIMEFRAMES = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
];

const TICK_STEP = {
  BTCUSDT: 10,
  ETHUSDT: 1,
  SOLUSDT: 0.1,
  BNBUSDT: 0.5,
};

const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;

export default function OrderFlowView({ risk, onSelectCoin, soundEnabled }) {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState("5m");
  const [chartMode, setChartMode] = useState("candles"); // candles | footprint
  const [status, setStatus] = useState("connecting");
  const [candles, setCandles] = useState([]);
  const [ticker, setTicker] = useState({
    price: 0,
    change24: 0,
    fundingRate: null,
    openInterest: null,
  });
  const [dom, setDom] = useState({ bids: [], asks: [], buyWalls: [], sellWalls: [], spoofs: [] });
  const [spoofLog, setSpoofLog] = useState([]);
  const [liveTrades, setLiveTrades] = useState([]);
  const [selectedSignalId, setSelectedSignalId] = useState(null);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const chartEl = useRef(null);
  const cvdEl = useRef(null);
  const mainChartRef = useRef(null);
  const cvdChartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const deltaSeriesRef = useRef(null);
  const cvdSeriesRef = useRef(null);
  const priceLinesRef = useRef([]);
  const wallTrackerRef = useRef(new Map());
  const candlesRef = useRef([]);

  // 1. Initialize Lightweight Charts (Main + Delta/CVD)
  useEffect(() => {
    if (!chartEl.current || !cvdEl.current) return;

    const mainChart = createChart(chartEl.current, {
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

    const candleSeries = mainChart.addCandlestickSeries({
      upColor: "#7ee6a3",
      downColor: "#f2707c",
      borderVisible: false,
      wickUpColor: "#7ee6a3",
      wickDownColor: "#f2707c",
    });

    const cvdChart = createChart(cvdEl.current, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#7c827f",
        fontFamily: "Funnel Display, sans-serif",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.02)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.06)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 9,
      },
    });

    const deltaSeries = cvdChart.addHistogramSeries({
      priceScaleId: "delta",
      priceFormat: { type: "volume" },
    });
    cvdChart.priceScale("delta").applyOptions({ scaleMargins: { top: 0.45, bottom: 0 } });

    const cvdSeries = cvdChart.addLineSeries({
      color: "#7ee6a3",
      lineWidth: 2,
      priceScaleId: "right",
    });

    // Sync time scales safely
    mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || !candlesRef.current.length) return;
      try {
        cvdChart.timeScale().setVisibleLogicalRange(range);
      } catch {
        /* ignore before cvd series has data */
      }
    });

    mainChartRef.current = mainChart;
    cvdChartRef.current = cvdChart;
    candleSeriesRef.current = candleSeries;
    deltaSeriesRef.current = deltaSeries;
    cvdSeriesRef.current = cvdSeries;

    return () => {
      mainChart.remove();
      cvdChart.remove();
    };
  }, []);

  // 2. Fetch Free Public Binance Futures Data + Live WebSockets (aggTrade + depth20@100ms + kline)
  useEffect(() => {
    let alive = true;
    setStatus("connecting");
    setCandles([]);
    setLiveTrades([]);
    setSpoofLog([]);
    setBacktestResult(null);
    wallTrackerRef.current.clear();

    const loadInitial = async () => {
      try {
        const [klineRes, depthRes, aggRes, tickerRes, oiRes, fundRes] = await Promise.allSettled([
          fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${timeframe}&limit=200`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=500`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&limit=500`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`).then((r) => r.json()),
        ]);
        if (!alive) return;

        if (klineRes.status === "fulfilled" && Array.isArray(klineRes.value)) {
          const parsed = klineRes.value.map((k) => {
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
          candlesRef.current = parsed;
          setCandles(parsed);
        }

        if (aggRes.status === "fulfilled" && Array.isArray(aggRes.value)) {
          const parsedTrades = aggRes.value.map((t) => ({
            price: Number(t.p),
            qty: Number(t.q),
            isSell: Boolean(t.m),
            time: Number(t.T),
          }));
          setLiveTrades(parsedTrades.slice(-300));
        }

        if (depthRes.status === "fulfilled" && depthRes.value?.bids) {
          const analyzed = analyzeDomHeatmap(
            depthRes.value.bids,
            depthRes.value.asks,
            wallTrackerRef.current,
            Date.now(),
            candlesRef.current[candlesRef.current.length - 1]?.close || 0,
          );
          setDom(analyzed);
        }

        const t24 = tickerRes.status === "fulfilled" ? tickerRes.value : null;
        const oi = oiRes.status === "fulfilled" ? oiRes.value : null;
        const fund = fundRes.status === "fulfilled" && Array.isArray(fundRes.value) ? fundRes.value[0] : null;
        setTicker({
          price: Number(t24?.lastPrice || candlesRef.current[candlesRef.current.length - 1]?.close || 0),
          change24: Number(t24?.priceChangePercent || 0),
          openInterest: oi?.openInterest ? Number(oi.openInterest) : null,
          fundingRate: fund?.fundingRate != null ? Number(fund.fundingRate) * 100 : null,
        });
      } catch {
        /* fallback handled by WS */
      }
    };

    loadInitial();

    const symLower = symbol.toLowerCase();
    const wsUrl = `wss://fstream.binance.com/stream?streams=${symLower}@aggTrade/${symLower}@depth20@100ms/${symLower}@kline_${timeframe}`;
    let ws = null;
    let reconnectTimer = null;

    const connectWs = () => {
      if (!alive) return;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (alive) setStatus("live");
      };
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
            setTicker((prev) => ({ ...prev, price }));
            setLiveTrades((prev) => {
              const next = [...prev, { price, qty, isSell, time: Number(data.T) }];
              return next.length > 450 ? next.slice(-450) : next;
            });
            // Update active candle buy/sell delta
            const list = candlesRef.current;
            if (list.length) {
              const last = { ...list[list.length - 1] };
              last.close = price;
              if (price > last.high) last.high = price;
              if (price < last.low) last.low = price;
              last.volume += qty;
              if (isSell) last.sellVol += qty;
              else last.buyVol += qty;
              const updated = [...list.slice(0, -1), last];
              candlesRef.current = updated;
              setCandles(updated);
            }
          } else if (stream.includes("@depth20")) {
            const lastPrice = candlesRef.current[candlesRef.current.length - 1]?.close || 0;
            const analyzed = analyzeDomHeatmap(
              data.b || data.bids,
              data.a || data.asks,
              wallTrackerRef.current,
              Date.now(),
              lastPrice,
            );
            setDom(analyzed);
            if (analyzed.spoofs.length) {
              setSpoofLog((prev) => [...analyzed.spoofs, ...prev].slice(0, 8));
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
            const list = candlesRef.current;
            const idx = list.findIndex((b) => b.time === t);
            const updated =
              idx >= 0 ? [...list.slice(0, idx), bar, ...list.slice(idx + 1)] : [...list, bar].slice(-250);
            candlesRef.current = updated;
            setCandles(updated);
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connectWs, 2500);
      };
      ws.onerror = () => ws?.close();
    };

    connectWs();

    // Refresh OI & Funding every 30s
    const metaTimer = setInterval(async () => {
      try {
        const [oi, fund] = await Promise.all([
          fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setTicker((prev) => ({
          ...prev,
          openInterest: oi?.openInterest ? Number(oi.openInterest) : prev.openInterest,
          fundingRate: fund?.[0]?.fundingRate != null ? Number(fund[0].fundingRate) * 100 : prev.fundingRate,
        }));
      } catch {
        /* ignore */
      }
    }, 30000);

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearInterval(metaTimer);
      ws?.close();
    };
  }, [symbol, timeframe]);

  // 3. Derived Order Flow Analytics
  const deltaCvd = useMemo(() => computeDeltaAndCVD(candles), [candles]);
  const hvnProfile = useMemo(() => computeHvnProfile(candles, 50), [candles]);
  const atr14 = useMemo(() => computeAtr14(candles), [candles]);
  const absorptions = useMemo(() => detectAbsorptionSignals(candles, symbol), [candles, symbol]);

  const footprintRows = useMemo(() => {
    const tick = TICK_STEP[symbol] || Math.max(0.0001, (ticker.price || 1) * 0.0004);
    const minVol = symbol === "BTCUSDT" ? 2 : symbol === "ETHUSDT" ? 10 : 50;
    return buildFootprintLevels(liveTrades, tick, minVol);
  }, [liveTrades, symbol, ticker.price]);

  // Combine Absorption + CVD Divergence + Strong Walls into unified Order Flow Signals
  const orderFlowSignals = useMemo(() => {
    const list = [...absorptions];
    if (deltaCvd.divergence) {
      list.unshift({
        id: `div-${deltaCvd.divergence.time}`,
        type: "CVD_DIVERGENCE",
        side: deltaCvd.divergence.side,
        symbol,
        time: deltaCvd.divergence.time,
        price: deltaCvd.divergence.price,
        label: deltaCvd.divergence.label.toUpperCase(),
        reason: deltaCvd.divergence.detail,
        score: 88,
      });
    }
    return list.slice(0, 12);
  }, [absorptions, deltaCvd.divergence, symbol]);

  const activeSignal = useMemo(
    () =>
      orderFlowSignals.find((s) => s.id === selectedSignalId) || orderFlowSignals[0] || null,
    [orderFlowSignals, selectedSignalId],
  );
  const activePlan = useMemo(
    () => calculateOrderFlowPlan(activeSignal, atr14, risk),
    [activeSignal, atr14, risk],
  );

  // 4. Update Chart Series + HVN/POC/VAH/VAL/Entry/SL/TP Lines + Absorption Markers
  useEffect(() => {
    if (!candleSeriesRef.current || !deltaSeriesRef.current || !cvdSeriesRef.current) return;
    if (!candles.length) return;

    // Ensure strictly ascending unique timestamps for lightweight-charts
    const seenTime = new Set();
    const cleanCandles = [];
    for (const c of [...candles].sort((a, b) => a.time - b.time)) {
      if (!Number.isFinite(c.time) || seenTime.has(c.time)) continue;
      seenTime.add(c.time);
      cleanCandles.push(c);
    }
    if (!cleanCandles.length) return;

    const cleanDelta = deltaCvd.series.filter((d) => seenTime.has(d.time));
    const cleanCvd = deltaCvd.cvdSeries.filter((d) => seenTime.has(d.time));

    try {
      candleSeriesRef.current.setData(cleanCandles);
      deltaSeriesRef.current.setData(cleanDelta);
      cvdSeriesRef.current.setData(cleanCvd);

      // Markers for Heavy Absorption (sorted ascending by time)
      const markers = [...absorptions]
        .filter((sig) => seenTime.has(sig.time))
        .sort((a, b) => a.time - b.time)
        .map((sig) => ({
          time: sig.time,
          position: sig.side === "LONG" ? "belowBar" : "aboveBar",
          color: sig.side === "LONG" ? "#7ee6a3" : "#f2707c",
          shape: "circle",
          text: sig.label,
        }));
      candleSeriesRef.current.setMarkers(markers);
    } catch {
      /* ignore transient chart sync errors */
    }

    // Price lines: POC, VAH, VAL, Top 3 HVN levels, and active signal Entry/SL/TP
    for (const line of priceLinesRef.current) {
      try {
        candleSeriesRef.current.removePriceLine(line);
      } catch {
        /* ignore */
      }
    }
    const nextLines = [];
    const addLine = (price, title, color, style = LineStyle.Solid, width = 1) => {
      if (!(price > 0) || !Number.isFinite(price)) return;
      try {
        nextLines.push(
          candleSeriesRef.current.createPriceLine({
            price,
            title,
            color,
            lineStyle: style,
            lineWidth: width,
            lineVisible: true,
            axisLabelVisible: true,
          }),
        );
      } catch {
        /* ignore chart line errors */
      }
    };

    if (hvnProfile.poc) {
      addLine(
        hvnProfile.poc.price,
        `POC (${Math.round(hvnProfile.poc.volume)})`,
        "#e6c97a",
        LineStyle.Solid,
        2,
      );
    }
    hvnProfile.hvns.slice(0, 3).forEach((h) => {
      if (hvnProfile.poc && Math.abs(h.price - hvnProfile.poc.price) < 1e-6) return;
      addLine(
        h.price,
        `HVN ${h.role === "SUPPORT" ? "SUP" : "RES"} · ${Math.round(h.volume)}`,
        "rgba(230, 201, 122, 0.65)",
        LineStyle.Dotted,
        2,
      );
    });
    if (hvnProfile.vah) addLine(hvnProfile.vah, "VAH", "rgba(143, 149, 146, 0.45)", LineStyle.Dashed, 1);
    if (hvnProfile.val) addLine(hvnProfile.val, "VAL", "rgba(143, 149, 146, 0.45)", LineStyle.Dashed, 1);

    if (activePlan) {
      addLine(activePlan.entry, "ENTRY", "#a3d9c4", LineStyle.Solid, 2);
      addLine(activePlan.sl, "SL", "#f2707c", LineStyle.Solid, 2);
      addLine(activePlan.tp2, "TP2 (3.76R)", "#7ee6a3", LineStyle.Dashed, 1);
    }

    priceLinesRef.current = nextLines;
  }, [candles, deltaCvd, hvnProfile, absorptions, activePlan]);

  // 5. 7-Day Backtest Runner (fetches up to 1000 15m/5m Binance klines)
  const handleBacktest = async () => {
    setBacktestLoading(true);
    try {
      const iv = timeframe === "1m" ? "5m" : timeframe;
      const rows = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${iv}&limit=1000`,
      ).then((r) => r.json());
      if (Array.isArray(rows)) {
        const parsed = rows.map((k) => {
          const vol = Number(k[5]);
          const buyVol = Number(k[9]);
          return {
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: vol,
            buyVol,
            sellVol: Math.max(0, vol - buyVol),
          };
        });
        const res = runOrderFlowBacktest(parsed, computeAtr14(parsed));
        setBacktestResult(res);
      }
    } catch {
      /* ignore */
    } finally {
      setBacktestLoading(false);
    }
  };

  const latestDelta = deltaCvd.series[deltaCvd.series.length - 1]?.value || 0;
  const latestCvd = deltaCvd.cvdSeries[deltaCvd.cvdSeries.length - 1]?.value || 0;
  const baseCoin = symbol.replace(/USDT$/, "");

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Binance Futures Order Flow"
        eyebrowIcon={Stack}
        title={
          <span className="inline-flex items-center gap-3">
            <CoinIcon symbol={symbol} coin={baseCoin} exchange="binance" className="w-9 h-9" isPump={ticker.change24 >= 0} />
            Order Flow Suite
          </span>
        }
        description="Real-time Delta, CVD Divergence, HVN Profile, Footprint Imbalances (3x+), Heavy Absorption & MBO DOM Heatmap."
        actions={
          <>
            <Segmented
              size="sm"
              value={symbol}
              onChange={setSymbol}
              options={SYMBOLS.map((s) => ({ value: s, label: s.replace("USDT", "") }))}
            />
            <Segmented
              size="sm"
              value={timeframe}
              onChange={setTimeframe}
              options={TIMEFRAMES}
            />
            <button
              onClick={handleBacktest}
              disabled={backtestLoading}
              className="cw-btn !h-9 !text-[12px]"
            >
              <Play weight="fill" className="w-3.5 h-3.5 text-mint" />
              {backtestLoading ? "Testing…" : "Backtest 7D"}
            </button>
            <LivePill isConnected={status === "live"} />
          </>
        }
      />

      {/* Top Metrics Strip */}
      <div className="grid grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-6 gap-3">
        <StatCard
          label={`${baseCoin}/USDT`}
          value={fmtPrice(ticker.price)}
          caption={`${pct(ticker.change24)} (24h)`}
          tone={ticker.change24 >= 0 ? "up" : "down"}
          highlight
        />
        <StatCard
          label="Candle Delta"
          value={`${latestDelta >= 0 ? "+" : ""}${latestDelta.toFixed(1)}`}
          caption={latestDelta >= 0 ? "Buyers aggressive" : "Sellers aggressive"}
          tone={latestDelta >= 0 ? "up" : "down"}
        />
        <StatCard
          label="Session CVD"
          value={`${latestCvd >= 0 ? "+" : ""}${latestCvd.toFixed(0)}`}
          caption={deltaCvd.divergence ? deltaCvd.divergence.label : "No divergence"}
          tone={latestCvd >= 0 ? "up" : "down"}
        />
        <StatCard
          label="POC / Value Area"
          value={hvnProfile.poc ? fmtPrice(hvnProfile.poc.price) : "—"}
          caption={
            hvnProfile.vah && hvnProfile.val
              ? `${fmtPrice(hvnProfile.val)} – ${fmtPrice(hvnProfile.vah)}`
              : "Calculating"
          }
        />
        <StatCard
          label="Funding / OI"
          value={ticker.fundingRate != null ? `${ticker.fundingRate.toFixed(4)}%` : "—"}
          caption={ticker.openInterest ? `OI: ${Number(ticker.openInterest).toLocaleString()} ${baseCoin}` : "—"}
        />
        <StatCard
          label="Active Signals"
          value={orderFlowSignals.length}
          caption={`${dom.buyWalls.length} Buy / ${dom.sellWalls.length} Sell Walls`}
          tone="up"
        />
      </div>

      {/* Backtest Summary Banner (when triggered) */}
      {backtestResult && (
        <section className="cw-panel cw-glow p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <ChartBar weight="duotone" className="w-5 h-5 text-mint" />
            <div>
              <div className="text-[13px] font-semibold text-snow">
                Order Flow Strategy Backtest ({symbol} · Absorption + HVN + Delta Flip)
              </div>
              <div className="text-[11px] text-fog-2">
                Simulated across last 1,000 real Binance Futures candles at 1:2 R:R
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-6 cw-num text-[13px]">
            <div>
              <span className="text-fog-2 text-[11px] block">Trades</span>
              <span className="font-semibold text-snow">{backtestResult.trades}</span>
            </div>
            <div>
              <span className="text-fog-2 text-[11px] block">Win Rate</span>
              <span className="font-semibold text-mint">{backtestResult.winRate}%</span>
            </div>
            <div>
              <span className="text-fog-2 text-[11px] block">Total PnL</span>
              <span className={`font-semibold ${backtestResult.totalPnlPct >= 0 ? "text-mint" : "text-coral"}`}>
                {backtestResult.totalPnlPct >= 0 ? "+" : ""}
                {backtestResult.totalPnlPct}%
              </span>
            </div>
            <div>
              <span className="text-fog-2 text-[11px] block">Max DD</span>
              <span className="font-semibold text-coral">-{backtestResult.maxDrawdownPct}%</span>
            </div>
            <div>
              <span className="text-fog-2 text-[11px] block">Avg R:R</span>
              <span className="font-semibold text-snow">{backtestResult.avgRR}R</span>
            </div>
          </div>
        </section>
      )}

      {/* Main Workspace: Chart + Footprint | MBO DOM Heatmap */}
      <div className="grid gap-4 @5xl:grid-cols-[1fr_300px]">
        {/* Left: Chart + Delta/CVD */}
        <section className="cw-panel p-3 md:p-4 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Segmented
                size="sm"
                value={chartMode}
                onChange={setChartMode}
                options={[
                  { value: "candles", label: "Chart + HVN" },
                  { value: "footprint", label: "Footprint 3x+" },
                ]}
              />
              {deltaCvd.divergence && (
                <span
                  className={`inline-flex items-center gap-1 px-2.5 h-7 rounded-full text-[11px] font-medium border ${
                    deltaCvd.divergence.side === "LONG"
                      ? "border-mint/35 bg-mint/10 text-mint"
                      : "border-coral/35 bg-coral/10 text-coral"
                  }`}
                >
                  <Pulse weight="bold" className="w-3.5 h-3.5" />
                  {deltaCvd.divergence.label}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-fog-2">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-terminal-yellow" /> HVN / POC
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-mint" /> Buy Absorption
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-coral" /> Sell Absorption
              </span>
              <button
                onClick={() =>
                  onSelectCoin?.({
                    symbol,
                    coin: baseCoin,
                    exchange: "binance",
                    price: ticker.price,
                  })
                }
                className="cw-btn !h-7 !px-2.5 !text-[11px]"
              >
                Full Detail <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Candlestick + HVN Chart */}
          <div className={chartMode === "candles" ? "space-y-2" : "hidden"}>
            <div className="relative h-[380px] rounded-xl border border-white/[0.06] bg-[#0b0c0f] overflow-hidden">
              <div ref={chartEl} className="absolute inset-0" />
              {!candles.length && (
                <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fog-2">
                  Connecting to Binance Futures Order Flow…
                </div>
              )}
            </div>
            <div className="relative h-[140px] rounded-xl border border-white/[0.06] bg-[#0b0c0f] overflow-hidden">
              <div className="absolute left-3 top-1.5 z-10 text-[10px] text-fog-2 pointer-events-none">
                Delta Bars &amp; CVD Line
              </div>
              <div ref={cvdEl} className="absolute inset-0" />
            </div>
          </div>

          {/* Live Footprint Imbalance Matrix */}
          {chartMode === "footprint" && (
            <div className="rounded-xl border border-white/[0.06] bg-[#0b0c0f] p-3 h-[528px] overflow-y-auto">
              <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-white/[0.06]">
                <div className="text-[12px] font-medium text-snow">
                  Live Bid × Ask Footprint &amp; Imbalance Levels (Ratio ≥ 3.0x)
                </div>
                <div className="text-[11px] text-fog-2">
                  {liveTrades.length} live aggTrades aggregated
                </div>
              </div>
              <div className="grid grid-cols-[110px_1fr_1fr_90px] text-[10px] text-fog-2 px-2 pb-1.5">
                <span>Price</span>
                <span className="text-right">Sell (Bid)</span>
                <span className="text-right">Buy (Ask)</span>
                <span className="text-right">Imbalance</span>
              </div>
              <div className="space-y-1 cw-num text-[12px]">
                {footprintRows.map((row) => (
                  <div
                    key={row.price}
                    className={`grid grid-cols-[110px_1fr_1fr_90px] items-center px-2 py-1.5 rounded-lg border ${
                      row.imbalanceSide === "BUY"
                        ? "border-mint/35 bg-mint/[0.08]"
                        : row.imbalanceSide === "SELL"
                          ? "border-coral/35 bg-coral/[0.08]"
                          : "border-white/[0.03] bg-white/[0.01]"
                    }`}
                  >
                    <span className="text-snow font-medium">{fmtPrice(row.price)}</span>
                    <span
                      className={`text-right ${
                        row.imbalanceSide === "SELL" ? "text-coral font-bold" : "text-coral/80"
                      }`}
                    >
                      {row.sell.toFixed(2)}
                    </span>
                    <span
                      className={`text-right ${
                        row.imbalanceSide === "BUY" ? "text-mint font-bold" : "text-mint/80"
                      }`}
                    >
                      {row.buy.toFixed(2)}
                    </span>
                    <span className="text-right text-[11px]">
                      {row.imbalanceSide ? (
                        <span
                          className={`px-1.5 py-0.5 rounded font-semibold ${
                            row.imbalanceSide === "BUY"
                              ? "bg-mint/20 text-mint"
                              : "bg-coral/20 text-coral"
                          }`}
                        >
                          {row.ratio >= 99 ? "MAX" : `${row.ratio}x`} {row.imbalanceSide}
                        </span>
                      ) : (
                        <span className="text-fog-2">—</span>
                      )}
                    </span>
                  </div>
                ))}
                {!footprintRows.length && (
                  <div className="py-12 text-center text-fog-2 text-[12px]">
                    Collecting live Binance aggTrades…
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Right: MBO DOM Heatmap + Spoof & Wall Alerts */}
        <section className="cw-panel p-3.5 flex flex-col gap-3 h-full">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-snow">MBO DOM Heatmap</div>
              <div className="text-[10px] text-fog-2">100ms Depth · Wall ≥ 3x · Spoof &lt; 5s</div>
            </div>
            {spoofLog.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-yellow/15 border border-terminal-yellow/35 text-terminal-yellow text-[10px] font-semibold">
                <ShieldWarning weight="fill" className="w-3 h-3" /> SPOOF ({spoofLog.length})
              </span>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-[#0b0c0f] overflow-hidden flex-1 flex flex-col">
            <div className="grid grid-cols-3 px-2.5 py-1.5 text-[10px] text-fog-2 border-b border-white/[0.05]">
              <span>Price</span>
              <span className="text-right">Size</span>
              <span className="text-right">Wall</span>
            </div>

            <div className="flex-1 overflow-y-auto cw-num text-[11px]">
              {/* Asks */}
              {dom.asks.slice(-12).map((a) => (
                <div key={`a-${a.price}`} className="relative grid grid-cols-3 px-2.5 py-1 items-center">
                  <span
                    className="absolute inset-y-0 right-0 pointer-events-none"
                    style={{
                      width: `${Math.round(a.intensity * 100)}%`,
                      background: a.isWall
                        ? "rgba(242, 112, 124, 0.32)"
                        : "rgba(242, 112, 124, 0.12)",
                    }}
                  />
                  <span className="relative text-coral">{fmtPrice(a.price)}</span>
                  <span className="relative text-right text-snow">{a.qty.toFixed(2)}</span>
                  <span className="relative text-right">
                    {a.isWall ? (
                      <span className="text-[9px] px-1 rounded bg-coral/25 text-coral font-semibold">
                        SELL {a.ratio}x
                      </span>
                    ) : (
                      <span className="text-fog-2 text-[10px]">{fmtUsd(a.usd)}</span>
                    )}
                  </span>
                </div>
              ))}

              {/* Mid Price */}
              <div className="px-2.5 py-1.5 my-0.5 border-y border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
                <span className="text-[13px] font-semibold text-mint">{fmtPrice(ticker.price)}</span>
                <span className="text-[10px] text-fog-2">LIVE MID</span>
              </div>

              {/* Bids */}
              {dom.bids.slice(0, 12).map((b) => (
                <div key={`b-${b.price}`} className="relative grid grid-cols-3 px-2.5 py-1 items-center">
                  <span
                    className="absolute inset-y-0 right-0 pointer-events-none"
                    style={{
                      width: `${Math.round(b.intensity * 100)}%`,
                      background: b.isWall
                        ? "rgba(126, 230, 163, 0.32)"
                        : "rgba(126, 230, 163, 0.12)",
                    }}
                  />
                  <span className="relative text-mint">{fmtPrice(b.price)}</span>
                  <span className="relative text-right text-snow">{b.qty.toFixed(2)}</span>
                  <span className="relative text-right">
                    {b.isWall ? (
                      <span className="text-[9px] px-1 rounded bg-mint/25 text-mint font-semibold">
                        BUY {b.ratio}x
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
            <div className="rounded-xl border border-terminal-yellow/25 bg-terminal-yellow/[0.05] p-2.5 space-y-1">
              <div className="text-[10px] font-semibold text-terminal-yellow">Recent Spoof Alerts</div>
              {spoofLog.slice(0, 3).map((sp, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] cw-num">
                  <span className={sp.side === "BID" ? "text-mint" : "text-coral"}>
                    {sp.side} @ {fmtPrice(sp.price)}
                  </span>
                  <span className="text-fog-2">{(sp.ageMs / 1000).toFixed(1)}s vanished</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Order Flow Signals Feed (Coinwach Signal Card Style) + Risk/Reward Plan */}
      <section className="cw-panel cw-glow p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lightning weight="duotone" className="w-5 h-5 text-mint" />
            <h2 className="text-[15px] font-semibold text-snow">
              Order Flow Signals Feed
            </h2>
          </div>
          {activePlan && activeSignal && (
            <div className="flex flex-wrap items-center gap-3 text-[12px] cw-num rounded-lg border border-white/[0.08] bg-[#0b0c0f] px-3 py-1.5">
              <span className={activeSignal.side === "LONG" ? "text-mint font-semibold" : "text-coral font-semibold"}>
                {activeSignal.side}
              </span>
              <span className="text-fog-2">Entry <strong className="text-snow">{fmtPrice(activePlan.entry)}</strong></span>
              <span className="text-fog-2">SL <strong className="text-coral">{fmtPrice(activePlan.sl)}</strong></span>
              <span className="text-fog-2">TP1 <strong className="text-mint">{fmtPrice(activePlan.tp1)}</strong></span>
              <span className="text-fog-2">TP2 <strong className="text-mint">{fmtPrice(activePlan.tp2)}</strong> (1:3.76R)</span>
              <span className="text-mint">Est. +{fmtUsd(activePlan.profitTp2Usd)}</span>
            </div>
          )}
        </div>

        <div className="grid gap-3 @3xl:grid-cols-2 @5xl:grid-cols-3">
          {orderFlowSignals.map((sig) => {
            const isLong = sig.side === "LONG";
            const selected = activeSignal?.id === sig.id;
            return (
              <button
                key={sig.id}
                type="button"
                onClick={() => setSelectedSignalId(sig.id)}
                className={`cw-card cw-hover text-left p-3.5 transition-all ${
                  selected
                    ? isLong
                      ? "!border-mint/50 bg-mint/[0.05]"
                      : "!border-coral/50 bg-coral/[0.05]"
                    : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${
                      isLong ? "text-mint" : "text-coral"
                    }`}
                  >
                    {isLong ? <TrendUp weight="bold" className="w-4 h-4" /> : <TrendDown weight="bold" className="w-4 h-4" />}
                    {sig.label}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.05] text-fog cw-num">
                    {fmtTime((sig.time - TZ_SHIFT) * 1000)}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-[15px] font-semibold text-snow cw-num">
                    {fmtPrice(sig.price)}
                  </span>
                  <span className="text-[11px] text-fog-2">
                    {sig.deltaFlip ? "Delta Flip ✓" : sig.type === "CVD_DIVERGENCE" ? "Divergence" : `Score ${sig.score}`}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-fog-2 line-clamp-2">{sig.reason}</p>
              </button>
            );
          })}
          {!orderFlowSignals.length && (
            <div className="col-span-full py-8 text-center text-[12px] text-fog-2">
              Scanning live Binance Futures order flow for Heavy Absorption &amp; CVD Divergences…
            </div>
          )}
        </div>
      </section>

      {/* Collapsible Education Guide */}
      <section className="cw-panel overflow-hidden">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/[0.02]"
        >
          <span className="inline-flex items-center gap-2 text-[13px] font-medium text-snow">
            <BookOpen weight="duotone" className="w-4 h-4 text-mint" />
            Order Flow Guide (HVN · Absorption · Imbalance · MBO DOM)
          </span>
          <CaretDown className={`w-4 h-4 text-fog-2 transition-transform ${guideOpen ? "rotate-180" : ""}`} />
        </button>
        {guideOpen && (
          <div className="px-4 pb-4 pt-1 grid gap-3 sm:grid-cols-2 @5xl:grid-cols-4 border-t border-white/[0.05] text-[11px] text-fog-2">
            <div>
              <div className="text-snow font-medium mb-0.5">HVN &amp; POC</div>
              High Volume Nodes (&gt;1.5x avg) act as institutional support/resistance magnets; POC is the heaviest traded price.
            </div>
            <div>
              <div className="text-snow font-medium mb-0.5">Heavy Absorption</div>
              Aggressive market selling/buying fails to move price (&lt;0.05%–0.12%) — passive limit whales are absorbing the flow.
            </div>
            <div>
              <div className="text-snow font-medium mb-0.5">Imbalance (3x+)</div>
              When Buy vs Sell volume at a single price level exceeds 3:1 ratio, highlighting aggressive trapped traders.
            </div>
            <div>
              <div className="text-snow font-medium mb-0.5">MBO DOM &amp; Spoof</div>
              Order book walls &gt;3x average depth show real liquidity; walls pulled in &lt;5s without fills are flagged as SPOOF.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
