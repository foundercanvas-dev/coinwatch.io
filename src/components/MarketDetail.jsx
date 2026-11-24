import React, { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import {
  ArrowLeft,
  ArrowsClockwise,
  TrendUp,
  TrendDown,
  ShieldCheck,
  Minus,
  Plus,
  Crosshair,
  CornersOut,
  ArrowLineRight,
  ChartBar,
} from "@phosphor-icons/react";
import CoinIcon, { baseAsset } from "./CoinIcon";
import { exchangeName } from "./ExchangeLogo";
import { PageHeader, LivePill, Metric, Segmented, StatCard, FlashValue } from "./ui";
import { fetchKlines, openMarketStream, INTERVALS } from "../lib/marketStream";
import { fmtPrice, fmtUsd, pct, fmtDateTime } from "../lib/format";
import {
  BiasSignalTracker,
  bookImbalance,
  checkTradable,
  computeBiasFeatures,
  scoreBias,
} from "../lib/biasEngine";
import { adaptiveEmaTrend } from "../lib/trendEngine";
import { marketStructureLevels } from "../lib/structureEngine";
import { atrFromCandles, calculateSmartEntry, calculateTradePlan } from "../lib/tradeMath";
import { rewardRatioFor, TRADE_POLICY } from "../lib/signalPolicy";

const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;
const IV_SEC = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function signalTradePlan(signal, riskSettings, market = {}) {
  if (!signal) return null;
  const triggerClose = numeric(signal.entry_price || signal.c || signal.close || signal.price);
  if (!(triggerClose > 0)) return null;
  const side = signal.direction === "SHORT" || signal.type === "DUMP" ? "SHORT" : "LONG";
  const atrAbs = market.atrAbs || numeric(signal.atr_abs);
  const entry = calculateSmartEntry({
    triggerClose,
    open: numeric(signal.o || signal.open),
    high: numeric(signal.h || signal.high),
    low: numeric(signal.l || signal.low),
    side,
    atrAbs,
    currentPrice: market.currentPrice || triggerClose,
    entryMode: riskSettings?.entryMode || "retest",
  });
  const stopLoss =
    numeric(side === "SHORT" ? signal.h || signal.high : signal.l || signal.low) ||
    numeric(signal.stop_loss);
  const riskPct = Math.min(
    Number(riskSettings?.riskPerTrade) || 1,
    Number(riskSettings?.maxLoss) || Number.POSITIVE_INFINITY,
  );
  const balance = Number(riskSettings?.balance) || 10_000;
  const rewardRatio = Number(market.rewardRatio ?? riskSettings?.rewardRatio) || 1.5;
  return calculateTradePlan({
    entry,
    side,
    stopLoss,
    atrAbs,
    rewardRatio,
    spread: market.spread,
    takerFee: market.takerFee ?? TRADE_POLICY.taker_fee_per_side,
    balance,
    riskPct,
  });
}

function confirmationWindowSeconds(model, quickScalp = false) {
  if (!model?.ready) return 60;
  const strength = Math.min(1, Math.abs(model.scored.raw) / 0.3);
  if (quickScalp) {
    let seconds = 8 + (1 - strength) * 6;
    if (!model.evidence.hasBookDepth) seconds += 2;
    if (!model.evidence.hasFlow) seconds += 2;
    if (!model.gate.ok) seconds += 2;
    return Math.round(Math.max(8, Math.min(20, seconds)));
  }
  let seconds = 30 + (1 - strength) * 30;
  if (!model.evidence.hasBookDepth) seconds += 8;
  if (!model.evidence.hasFlow) seconds += 8;
  if (!model.evidence.hasOpenInterest) seconds += 6;
  if (!model.gate.ok) seconds += 12;
  return Math.round(Math.max(30, Math.min(90, seconds)));
}

function precisionFor(p) {
  if (!p) return 2;
  if (p >= 1000) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  if (p >= 0.0001) return 7;
  return 9;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export default function MarketDetail({
  coin,
  sensitivity = 1.5,
  risk,
  onBack,
  onOpenPOA,
  setActiveNav,
}) {
  const exchange = (coin.exchange || "binance").toLowerCase();
  const symbol = String(coin.symbol || "BTCUSDT");
  const base = baseAsset(symbol);
  const signal = coin.candle_ts || coin.change_pct != null ? coin : null;

  const [interval, setIv] = useState(
    signal?.timeframe && IV_SEC[signal.timeframe] ? signal.timeframe : "1m",
  );
  const rewardRatio =
    numeric(signal?.reward_ratio || signal?.trigger_reward_ratio) ||
    rewardRatioFor(signal?.timeframe || interval);
  const [view, setView] = useState("candles");
  const [status, setStatus] = useState("connecting");
  const [ticker, setTicker] = useState({});
  const [book, setBook] = useState({ bids: [], asks: [] });
  const [bars, setBars] = useState([]);
  const [spacing, setSpacing] = useState(8);
  const [showSignal, setShowSignal] = useState(true);
  const [footprint, setFootprint] = useState([]);
  const [trades, setTrades] = useState(0);
  const [biasBars, setBiasBars] = useState([]);
  const [biasWindow, setBiasWindow] = useState({
    state:
      signal?.lifecycle_status === "confirming"
        ? "watching"
        : signal?.lifecycle_status || (signal ? "watching" : "idle"),
    side: signal?.direction?.toLowerCase() || null,
    progress: signal?.lifecycle_status === "confirmed" ? 1 : 0,
    meanScore: 0,
    plan: null,
    reason: signal?.outcome || "",
    windowEndsAt: null,
    expiresAt: signal?.expires_ts || null,
  });
  const confirmedSide = biasWindow.state === "confirmed" ? biasWindow.side?.toUpperCase() : null;
  const [tradePlan, setTradePlan] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  const chartEl = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const volRef = useRef(null);
  const poaLinesRef = useRef([]);
  const barsRef = useRef([]);
  const fpRef = useRef(new Map());
  const tradesRef = useRef(0);
  const tradeTapeRef = useRef([]);
  const biasBarsRef = useRef([]);
  const obiHistRef = useRef([]);
  const oiHistoryRef = useRef([]);
  const fundingHistRef = useRef([]);
  const biasInputRef = useRef(null);
  const frozenPlanKeyRef = useRef(null);
  const biasTrackerRef = useRef(
    new BiasSignalTracker({ cooldownSec: 30, enter: signal ? 0.001 : 0.3 }),
  );
  const pendingBook = useRef(null);
  const fallbackPrice = useRef(coin.price);

  /* chart instance */
  useEffect(() => {
    const chart = createChart(chartEl.current, {
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
        barSpacing: 8,
        rightOffset: 4,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(126,230,163,0.35)", labelBackgroundColor: "#1c1d22" },
        horzLine: { color: "rgba(126,230,163,0.35)", labelBackgroundColor: "#1c1d22" },
      },
    });
    const candles = chart.addCandlestickSeries({
      upColor: "#7ee6a3",
      downColor: "#f2707c",
      borderVisible: false,
      wickUpColor: "#7ee6a3",
      wickDownColor: "#f2707c",
    });
    const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      setSpacing(Math.round(chart.timeScale().options().barSpacing));
    });
    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = vol;
    return () => chart.remove();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /* Stable 1m baseline for the bias model, independent of the chart interval. */
  useEffect(() => {
    let alive = true;
    biasBarsRef.current = [];
    setBiasBars([]);
    fetchKlines(exchange, symbol, "1m", coin.coin).then((rows) => {
      if (!alive) return;
      biasBarsRef.current = rows;
      setBiasBars(rows);
    });
    return () => {
      alive = false;
    };
  }, [exchange, symbol, reloadKey, coin.coin]);

  /* data + stream */
  useEffect(() => {
    let alive = true;
    barsRef.current = [];
    fpRef.current = new Map();
    tradesRef.current = 0;
    tradeTapeRef.current = [];
    obiHistRef.current = [];
    oiHistoryRef.current = [];
    fundingHistRef.current = [];
    setBars([]);
    setBook({ bids: [], asks: [] });
    setFootprint([]);
    setTrades(0);
    setStatus("connecting");

    const toLocal = (b) => ({ ...b, time: b.time + TZ_SHIFT });
    const volColor = (b) =>
      b.close >= b.open ? "rgba(126,230,163,0.28)" : "rgba(242,112,124,0.28)";

    fetchKlines(exchange, symbol, interval, coin.coin).then((rows) => {
      if (!alive || !candleRef.current) return;
      const local = rows.map(toLocal);
      barsRef.current = local;
      const p = local[local.length - 1]?.close || fallbackPrice.current;
      const precision = precisionFor(p);
      candleRef.current.applyOptions({
        priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision },
      });
      candleRef.current.setData(local);
      volRef.current.setData(
        local.map((b) => ({ time: b.time, value: b.volume, color: volColor(b) })),
      );
      chartRef.current.timeScale().scrollToRealTime();
      setBars(local);
    });

    const close = openMarketStream(exchange, symbol, interval, coin.coin, {
      onStatus: (s) => alive && setStatus(s),
      onKline: (b) => {
        if (!alive || !candleRef.current) return;
        const lb = toLocal(b);
        const arr = barsRef.current;
        const last = arr[arr.length - 1];
        if (last && lb.time < last.time) return;
        if (last && last.time === lb.time) arr[arr.length - 1] = lb;
        else arr.push(lb);
        candleRef.current.update(lb);
        volRef.current.update({ time: lb.time, value: lb.volume, color: volColor(lb) });
        if (interval === "1m") {
          const biasRows = biasBarsRef.current;
          const biasLast = biasRows[biasRows.length - 1];
          if (biasLast?.time === b.time) biasRows[biasRows.length - 1] = b;
          else if (!biasLast || b.time > biasLast.time) biasRows.push(b);
          if (biasRows.length > 500) biasRows.splice(0, biasRows.length - 500);
        }
      },
      onTicker: (t) => {
        if (!alive) return;
        const next = Object.fromEntries(
          Object.entries(t).filter(([, value]) => Number.isFinite(value) && value !== 0),
        );
        const now = Date.now() / 1000;
        if (Number.isFinite(next.oi)) {
          const history = oiHistoryRef.current;
          if (!history.length || now - history.at(-1).ts >= 10) {
            history.push({ ts: now, value: next.oi });
            if (history.length > 60) history.shift();
          }
        }
        if (Number.isFinite(next.funding)) {
          const history = fundingHistRef.current;
          if (!history.length || history.at(-1) !== next.funding) {
            history.push(next.funding);
            if (history.length > 60) history.shift();
          }
        }
        setTicker((prev) => ({ ...prev, ...next }));
      },
      onBook: (bk) => {
        pendingBook.current = bk;
      },
      onTrade: (t) => {
        tradesRef.current += 1;
        const timestamp =
          Number(t.time) > 1e12 ? Number(t.time) / 1000 : Number(t.time) || Date.now() / 1000;
        const tape = tradeTapeRef.current;
        tape.push({ ts: timestamp, price: t.price, size: t.size, side: t.side });
        const cutoff = Date.now() / 1000 - 65;
        while (tape.length && tape[0].ts < cutoff) tape.shift();
        if (tape.length > 4000) tape.splice(0, tape.length - 4000);
        const step = Math.max(10 ** (Math.floor(Math.log10(t.price)) - 3), 1e-9);
        const key = (Math.round(t.price / step) * step).toPrecision(8);
        const cur = fpRef.current.get(key) || { price: Number(key), buy: 0, sell: 0 };
        cur[t.side] += t.size * t.price;
        fpRef.current.set(key, cur);
      },
    });

    const flush = setInterval(() => {
      if (!alive) return;
      if (pendingBook.current) {
        const nextBook = pendingBook.current;
        const imbalance = bookImbalance(nextBook);
        const history = obiHistRef.current;
        history.push(imbalance.obi);
        if (history.length > 24) history.shift();
        setBook(nextBook);
        pendingBook.current = null;
      }
      setTrades(tradesRef.current);
      setBars([...barsRef.current]);
      if (biasBarsRef.current.length) setBiasBars([...biasBarsRef.current]);
      if (fpRef.current.size) {
        setFootprint([...fpRef.current.values()].sort((a, b) => b.price - a.price).slice(0, 60));
      }
    }, 500);

    return () => {
      alive = false;
      close();
      clearInterval(flush);
    };
  }, [exchange, symbol, interval, reloadKey, coin.coin]);

  useEffect(() => {
    if (!signal || !confirmedSide || !risk?.configured) {
      frozenPlanKeyRef.current = null;
      setTradePlan(null);
      return;
    }
    const planKey = `${signal.id ?? signal.candle_ts ?? signal.raw_ts ?? symbol}:${confirmedSide}:${risk.balance}:${risk.riskPerTrade}:${risk.maxLoss}:${risk.rewardRatio ?? 1.5}:${risk.entryMode ?? "retest"}`;
    if (frozenPlanKeyRef.current === planKey) return;
    const confirmationPrice =
      numeric(biasWindow.plan?.entryRef) ||
      numeric(signal.entry_price || signal.price || signal.c || signal.close) ||
      ticker.last ||
      coin.price;
    const planCandles = signal.timeframe === "1m" ? biasBars : bars;
    const atrAbs = numeric(signal.atr_abs) || atrFromCandles(planCandles);
    const stopLoss =
      numeric(confirmedSide === "SHORT" ? signal.h || signal.high : signal.l || signal.low) ||
      numeric(signal.stop_loss);
    if (!(atrAbs > 0) && !(stopLoss > 0)) return;
    const liveSpread = bookImbalance(book).spread;
    if (!Number.isFinite(liveSpread)) return;
    const frozenPlan = signalTradePlan(
      {
        ...signal,
        direction: confirmedSide,
        type: confirmedSide === "LONG" ? "PUMP" : "DUMP",
        entry_price: confirmationPrice,
        c: confirmationPrice,
        close: confirmationPrice,
        price: confirmationPrice,
      },
      risk,
      {
        atrAbs,
        currentPrice: ticker.last || coin.price,
        rewardRatio: Number(risk?.rewardRatio) || 1.5,
        spread: liveSpread,
      },
    );
    if (!frozenPlan) return;
    frozenPlanKeyRef.current = planKey;
    setTradePlan({
      ...frozenPlan,
      frozenAt: Date.now(),
      sourcePrice: confirmationPrice,
    });
  }, [
    signal,
    confirmedSide,
    biasWindow.plan?.entryRef,
    symbol,
    ticker.last,
    coin.price,
    risk,
    rewardRatio,
    biasBars,
    bars,
    book,
  ]);

  /* Entry, DCA, invalidation and target overlays for the opened scanner signal. */
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return undefined;
    for (const line of poaLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* chart may already be disposed */
      }
    }
    poaLinesRef.current = [];
    if (!showSignal || !tradePlan) return undefined;

    const levels = [
      ["ENTRY", tradePlan.entry, "#a3d9c4", LineStyle.Solid, 2],
      ["SL", tradePlan.stop, "#f2707c", LineStyle.Solid, 2],
      ...(tradePlan.tp1 > 0 ? [["TP", tradePlan.tp1, "#7ee6a3", LineStyle.Dashed, 2]] : []),
    ];
    poaLinesRef.current = levels.map(([title, price, color, lineStyle, lineWidth]) =>
      series.createPriceLine({
        price,
        title,
        color,
        lineStyle,
        lineWidth,
        lineVisible: true,
        axisLabelVisible: true,
      }),
    );
    return () => {
      for (const line of poaLinesRef.current) {
        try {
          series.removePriceLine(line);
        } catch {
          /* chart may already be disposed */
        }
      }
      poaLinesRef.current = [];
    };
  }, [tradePlan, showSignal]);

  /* signal marker */
  useEffect(() => {
    if (!candleRef.current) return;
    const signalTime = signal?.candle_ts || Number(signal?.raw_ts) * 1000;
    if (!signalTime || !showSignal || !bars.length) {
      candleRef.current.setMarkers([]);
      return;
    }
    const iv = IV_SEC[interval];
    const t = Math.floor(signalTime / 1000 / iv) * iv + TZ_SHIFT;
    const signalSide =
      confirmedSide || signal.direction || (signal.type === "DUMP" ? "SHORT" : "LONG");
    const isPump = signalSide === "LONG";
    const markerTerminal = ["invalidated", "expired", "stopped", "reversed", "target_hit"].includes(
      biasWindow.state,
    );
    const markerOutcome = {
      invalidated: "Invalidated",
      expired: "Expired",
      stopped: "Stopped",
      reversed: "Reversed",
      target_hit: "TP1 hit",
    }[biasWindow.state];
    const markerText =
      biasWindow.state === "confirmed"
        ? "Confirmed"
        : biasWindow.state === "target_hit"
          ? "TP1 hit"
          : markerTerminal
            ? markerOutcome || "Finalized"
            : "Trigger";
    const markerColor =
      biasWindow.state === "confirmed"
        ? isPump
          ? "#7ee6a3"
          : "#f2707c"
        : markerTerminal
          ? "#7c827f"
          : "#e6c97a";
    if (bars.some((b) => b.time === t)) {
      candleRef.current.setMarkers([
        {
          time: t,
          position: isPump ? "belowBar" : "aboveBar",
          color: markerColor,
          shape: isPump ? "arrowUp" : "arrowDown",
          text: markerText,
        },
      ]);
    }
  }, [signal, confirmedSide, showSignal, bars, interval, biasWindow.state]);

  const last = ticker.last || bars[bars.length - 1]?.close || coin.price;
  const change1h = useMemo(() => {
    if (!bars.length || !last) return null;
    const target = bars[bars.length - 1].time - 3600;
    const ref = [...bars].reverse().find((b) => b.time <= target);
    return ref ? ((last - ref.close) / ref.close) * 100 : null;
  }, [bars, last]);
  const bid = ticker.bid || book.bids[0]?.[0];
  const ask = ticker.ask || book.asks[0]?.[0];
  const spread = bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;

  const refCandle = signal?.o
    ? { o: signal.o, h: signal.h, l: signal.l, c: signal.c }
    : bars.length
      ? {
          o: bars[bars.length - 1].open,
          h: bars[bars.length - 1].high,
          l: bars[bars.length - 1].low,
          c: bars[bars.length - 1].close,
        }
      : null;
  const move = signal
    ? Number(signal.change_pct)
    : refCandle
      ? ((refCandle.c - refCandle.o) / refCandle.o) * 100
      : 0;
  const biasModel = useMemo(() => {
    const closedBars = biasBars.length > 1 ? biasBars.slice(0, -1).slice(-121) : [];
    const oiNow = ticker.oi || coin.open_interest_usd || 0;
    const fiveMinutesAgo = Date.now() / 1000 - 300;
    const sampledPrevious = [...oiHistoryRef.current]
      .reverse()
      .find((sample) => sample.ts <= fiveMinutesAgo)?.value;
    const inferredPrevious =
      oiNow && coin.oi_change_5m
        ? oiNow / (1 + Number(coin.oi_change_5m) / 100)
        : oiHistoryRef.current[0]?.value || oiNow;
    const features = computeBiasFeatures({
      candles: closedBars,
      price: last,
      obiHist: obiHistRef.current,
      trades: tradeTapeRef.current,
      now: Date.now() / 1000,
      oi: { now: oiNow, prev: sampledPrevious || inferredPrevious || 0 },
      fundingHist: fundingHistRef.current,
    });
    if (!features) return { ready: false, long: 50, short: 50 };
    const scored = scoreBias(features.features);
    const liquidity = bookImbalance(book);
    const gate = checkTradable({ spread: liquidity.spread, atrPct: features.atrPct });
    return {
      ready: true,
      features,
      scored,
      gate,
      evidence: {
        hasBookDepth: liquidity.depthUsd >= 10_000 && obiHistRef.current.length >= 3,
        hasFlow: features.flowUsd >= 20_000,
        hasOpenInterest: oiNow > 0,
      },
      long: scored.longBias * 100,
      short: scored.shortBias * 100,
      // Normalize against the model's 0.30 signal-window entry threshold.
      strength: Math.min(100, (Math.abs(scored.raw) / 0.3) * 100),
    };
  }, [biasBars, book, ticker, trades, last, coin.open_interest_usd, coin.oi_change_5m]);
  const followSide = (biasModel.features?.features.mom || 0) >= 0 ? "LONG" : "SHORT";
  const strength = biasModel.strength || 0;
  const chartInsights = useMemo(() => {
    const features = biasModel.features?.features || {};
    const pressure =
      0.45 * (features.mom || 0) + 0.35 * (features.flow || 0) + 0.2 * (features.obi || 0);
    const funding = Number(ticker.funding ?? coin.funding_rate ?? 0);
    const crowding = Math.tanh(funding / 0.0005);
    const longLiquidationRisk = clamp(50 - pressure * 35 + crowding * 10, 8, 92);
    const sentimentLong = biasModel.ready ? biasModel.long : clamp(50 + pressure * 40, 10, 90);
    return {
      longLiquidationRisk,
      shortLiquidationRisk: 100 - longLiquidationRisk,
      trend: adaptiveEmaTrend(bars),
      levels: marketStructureLevels(bars, last),
      price: last,
      sentimentLong,
      sentimentShort: 100 - sentimentLong,
      hasLeverageData: Boolean(ticker.oi || coin.open_interest_usd),
    };
  }, [biasModel, bars, last, ticker.funding, ticker.oi, coin.funding_rate, coin.open_interest_usd]);

  biasInputRef.current = biasModel.ready
    ? {
        score:
          signal && Math.abs(biasModel.scored.raw) < 0.001
            ? signal.type === "DUMP"
              ? -0.001
              : 0.001
            : biasModel.scored.raw,
        price: last,
        atrAbs: biasModel.features.atrAbs,
        tradable: biasModel.gate.ok,
      }
    : null;

  const lockedStateRef = useRef(null);

  useEffect(() => {
    const sigKey = `${exchange}:${symbol}:${signal?.id ?? signal?.candle_ts ?? "live"}`;
    const locked = lockedStateRef.current;

    // Never allow a locked terminal/confirmed state to flip-flop back to watching or invalidated
    const sourceState = signal?.lifecycle_status;
    if (locked && locked.key === sigKey) {
      if (locked.state === "invalidated" || locked.state === "stopped") {
        return undefined;
      }
      if (locked.state === "confirmed") {
        if (sourceState === "stopped") {
          lockedStateRef.current = { key: sigKey, state: "stopped", side: locked.side };
          setBiasWindow((prev) => ({ ...prev, state: "stopped", reason: "Stop loss reached" }));
        }
        return undefined;
      }
    }

    if (sourceState && sourceState !== "confirming") {
      lockedStateRef.current = { key: sigKey, state: sourceState, side: signal.direction?.toLowerCase() || null };
      setBiasWindow({
        state: sourceState,
        side: signal.direction?.toLowerCase() || null,
        progress: sourceState === "confirmed" ? 1 : 0,
        meanScore: Number(signal.score || 0) / 100,
        plan: null,
        reason: signal.outcome || "",
        windowEndsAt: null,
        expiresAt: signal.expires_ts || null,
      });
      return undefined;
    }

    const windowSec = confirmationWindowSeconds(biasModel, Boolean(signal));
    biasTrackerRef.current = new BiasSignalTracker({
      cooldownSec: 30,
      enter: signal ? 0.001 : 0.3,
      windowSec,
      minSamples: Math.min(8, Math.max(1, Math.floor(windowSec))),
      oneShot: Boolean(signal),
    });
    setBiasWindow(biasTrackerRef.current.snapshot(Date.now() / 1000));
    const update = () => {
      const curLock = lockedStateRef.current;
      if (curLock && curLock.key === sigKey && ["confirmed", "invalidated", "stopped"].includes(curLock.state)) {
        return;
      }
      const input = biasInputRef.current;
      if (!input) return;
      const next = biasTrackerRef.current.update(
        Date.now() / 1000,
        input.score,
        input.price,
        input.atrAbs,
        input.tradable,
      );
      if (["confirmed", "invalidated", "stopped"].includes(next.state)) {
        lockedStateRef.current = { key: sigKey, state: next.state, side: next.side };
      }
      setBiasWindow(next);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [
    exchange,
    symbol,
    reloadKey,
    signal?.id,
    signal?.lifecycle_status,
    signal?.direction,
    signal?.outcome,
    signal?.expires_ts,
  ]);

  const terminalState = ["invalidated", "expired", "stopped", "reversed", "target_hit"].includes(
    biasWindow.state,
  );
  const invalidState = ["invalidated", "stopped", "reversed"].includes(biasWindow.state);
  const terminalLabel = {
    invalidated: "Signal invalidated",
    expired: "Signal expired",
    stopped: "Signal stopped",
    reversed: "Signal reversed",
    target_hit: "TP1 reached",
  }[biasWindow.state];
  const biasStatus =
    biasWindow.state === "confirmed"
      ? "Signal confirmed"
      : biasWindow.state === "watching"
        ? "Signal window"
        : terminalState
          ? terminalLabel
          : signal
            ? "Signal received"
            : "Market bias";
  const windowStatus =
    biasWindow.state === "watching"
      ? `Signal confirming in ${Math.max(
          0,
          Math.ceil((biasWindow.windowEndsAt || 0) - clock / 1000),
        )} seconds`
      : biasWindow.state === "confirmed"
        ? `${confirmedSide} signal confirmed`
        : terminalState
          ? terminalLabel
          : signal
            ? "Signal received"
            : "Market bias";

  const hasOverlay = useMemo(() => {
    try {
      const local = JSON.parse(localStorage.getItem("cw.poa.local") || "[]");
      return local.some((p) => p.symbol === symbol && p.status !== "CLOSED");
    } catch {
      return false;
    }
  }, [symbol]);

  const zoom = (dir) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const next = Math.max(2, Math.min(40, ts.options().barSpacing * (dir > 0 ? 1.25 : 0.8)));
    ts.applyOptions({ barSpacing: next });
    setSpacing(Math.round(next));
  };

  const plan = (side) => {
    const selectedSignal = {
      ...(signal || coin),
      direction: side,
      type: side === "LONG" ? "PUMP" : "DUMP",
      entry_price: last,
      c: last,
      close: last,
      price: last,
    };
    const liquidity = bookImbalance(book);
    const selectedPlan =
      tradePlan?.side === side
        ? tradePlan
        : signalTradePlan(selectedSignal, risk, {
            atrAbs: numeric(signal?.atr_abs) || atrFromCandles(biasBars),
            rewardRatio: 1.0,
            stopLoss: numeric(side === "SHORT" ? signal?.h || signal?.high : signal?.l || signal?.low) || numeric(signal?.stop_loss),
            spread: Number.isFinite(liquidity.spread) ? liquidity.spread : 0.0004,
          });
    onOpenPOA({
      ...coin,
      symbol,
      exchange,
      price: last,
      preferredSide: side,
      direction: side,
      type: side === "LONG" ? "PUMP" : "DUMP",
      volume_spike_ratio: signal?.vol_spike,
      bias_score: side === "LONG" ? biasModel.long : biasModel.short,
      bias_state: biasWindow.state,
      bias_plan: biasWindow.plan,
      entry_price: selectedPlan?.entry,
      stop_loss: selectedPlan?.stop,
      tp1: selectedPlan?.tp1,
      tp2: selectedPlan?.tp1,
      risk_adjusted: true,
      risk_percentage: selectedPlan?.riskPct,
      risk_usd: selectedPlan?.riskUsd,
      suggested_position_usd: selectedPlan?.positionUsd,
    });
  };

  const maxBook = Math.max(
    1,
    ...book.bids.map((b) => b[1] * b[0]),
    ...book.asks.map((a) => a[1] * a[0]),
  );
  const live = status === "live";

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Market detail"
        eyebrowIcon={ChartBar}
        title={
          <span className="inline-flex items-center gap-3">
            <CoinIcon
              symbol={symbol}
              coin={coin.coin}
              exchange={exchange}
              className="w-10 h-10"
              isPump={move >= 0}
            />
            {base}/USDT
          </span>
        }
        description={`Live market feed with real-time data · ${exchangeName(exchange)} perpetual`}
        actions={
          <>
            <button onClick={() => setActiveNav?.("pump_dump")} className="cw-btn !h-9">
              <ArrowLeft weight="bold" className="w-4 h-4" /> Open scanner
            </button>
            <button onClick={() => setReloadKey((k) => k + 1)} className="cw-btn !h-9">
              <ArrowsClockwise weight="bold" className="w-4 h-4" /> Reload
            </button>
            <LivePill isConnected={live} />
          </>
        }
      />

      {/* Stats strip */}
      <section className="cw-panel grid grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-6 divide-white/[0.06] @5xl:divide-x">
        {[
          ["Last", <FlashValue key="l" value={fmtPrice(last)} className="text-snow" />],
          [
            "24h",
            ticker.change24 != null ? (
              <span className={ticker.change24 >= 0 ? "text-mint" : "text-coral"}>
                {pct(ticker.change24)}
              </span>
            ) : (
              "—"
            ),
          ],
          [
            "Volume",
            ticker.vol24
              ? fmtUsd(ticker.vol24)
              : coin.volume_24h_usd
                ? fmtUsd(coin.volume_24h_usd)
                : "—",
          ],
          [
            "1h",
            change1h != null ? (
              <span className={change1h >= 0 ? "text-mint" : "text-coral"}>{pct(change1h)}</span>
            ) : (
              "—"
            ),
          ],
          ["Bid / Ask", bid && ask ? `${fmtPrice(bid)} / ${fmtPrice(ask)}` : "— / —"],
          ["Spread", spread != null ? `${spread.toFixed(3)}%` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="px-4 py-3.5 min-w-0">
            <div className="text-[11px] text-fog-2">{k}</div>
            <div className="cw-num mt-1 text-[15px] font-medium text-snow truncate">{v}</div>
          </div>
        ))}
      </section>

      {/* Plan of attack */}
      <section className="cw-panel cw-glow p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className={`cw-num inline-flex items-center h-8 px-3 rounded-full border text-[11px] font-medium ${
              biasWindow.state === "watching"
                ? "border-terminal-yellow/30 bg-terminal-yellow/[0.06] text-terminal-yellow"
                : biasWindow.state === "confirmed"
                  ? confirmedSide === "LONG"
                    ? "border-mint/30 bg-mint/[0.06] text-mint"
                    : "border-coral/30 bg-coral/[0.06] text-coral"
                  : invalidState
                    ? "border-coral/30 bg-coral/[0.06] text-coral"
                    : terminalState
                      ? "border-white/[0.08] bg-white/[0.025] text-fog"
                      : "border-white/[0.08] bg-white/[0.025] text-fog-2"
            }`}
          >
            {windowStatus}
          </span>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-[11px] text-fog-2">
              {fmtDateTime(Date.now())}
            </span>
            <button onClick={() => setActiveNav?.("settings")} className="cw-btn !h-8 !text-[12px]">
              <ShieldCheck weight="duotone" className="w-4 h-4" /> Risk
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 @3xl:grid-cols-4 rounded-xl border border-white/[0.06] bg-[#0b0c0f] divide-white/[0.06] @3xl:divide-x">
          {[
            [biasStatus, symbol, biasWindow.state === "confirmed" ? "text-mint" : "text-fog-2"],
            ["Move", pct(move), move >= 0 ? "text-mint" : "text-coral"],
            ["Strength", biasModel.ready ? `${strength.toFixed(1)}%` : "Collecting"],
            [
              "Confirmed",
              confirmedSide || "—",
              confirmedSide === "LONG"
                ? "text-mint"
                : confirmedSide === "SHORT"
                  ? "text-coral"
                  : "text-fog-2",
            ],
          ].map(([k, v, tone]) => (
            <div key={k} className="px-4 py-3 min-w-0">
              <div
                className={`text-[11px] ${tone && k !== "Move" && k !== "Confirmed" ? tone : "text-fog-2"}`}
              >
                {k}
              </div>
              <div
                className={`cw-num mt-0.5 text-[14px] font-medium truncate ${k === "Move" || k === "Confirmed" ? tone : "text-snow"}`}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 @3xl:grid-cols-2">
          {[
            ["LONG", biasModel.long, TrendUp, "mint"],
            ["SHORT", biasModel.short, TrendDown, "coral"],
          ].map(([side, p, Icon, tone]) => {
            const fav = confirmedSide === side;
            const otherConfirmed = confirmedSide && confirmedSide !== side;
            return (
              <div
                key={side}
                className={`relative overflow-hidden h-[72px] rounded-xl text-center transition-all duration-300 ${
                  fav
                    ? tone === "mint"
                      ? "cw-confirmed-long"
                      : "cw-confirmed-short"
                    : otherConfirmed
                      ? "border border-white/[0.04] bg-[#0b0c0f]/60 opacity-40"
                      : "border border-white/[0.07] bg-[#0b0c0f]"
                }`}
              >
                <span
                  className={`absolute inset-y-0 left-0 transition-[width] duration-500 ${
                    fav
                      ? tone === "mint"
                        ? "bg-gradient-to-r from-mint/[0.24] via-mint/[0.14] to-mint/[0.04]"
                        : "bg-gradient-to-r from-coral/[0.24] via-coral/[0.14] to-coral/[0.04]"
                      : tone === "mint"
                        ? "bg-mint/[0.07]"
                        : "bg-coral/[0.07]"
                  }`}
                  style={{ width: `${p}%` }}
                />
                <span className="relative flex items-center justify-center gap-2.5 h-full px-4">
                  <span
                    className={`inline-flex items-center gap-1.5 text-[16px] font-semibold tracking-tight ${
                      tone === "mint" ? "text-mint" : "text-coral"
                    }`}
                  >
                    <Icon weight="bold" className="w-4 h-4" />
                    {fav ? `${side} CONFIRMED` : `${side} BIAS`}
                    <span className="cw-num opacity-90">{p.toFixed(1)}%</span>
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        {!risk?.configured ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0b0c0f] px-4 py-3">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-snow">Risk setup required</div>
              <div className="text-[11px] text-fog-2">
                Set your Balance &amp; Risk % in Settings first to calculate Entry, Stop Loss, Take Profit, and Position Size.
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

      {/* Chart */}
      <section className="cw-panel p-3 md:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="cw-seg cw-seg-sm">
            {INTERVALS.map((iv) => (
              <button key={iv} data-active={interval === iv} onClick={() => setIv(iv)}>
                {iv}
              </button>
            ))}
          </div>
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "candles", label: "Candles" },
              { value: "footprint", label: "Footprint" },
              { value: "liquidity", label: "Liquidity" },
            ]}
          />
        </div>

        <div className="grid gap-3 @5xl:grid-cols-[1fr_250px]">
          <div className="rounded-xl border border-white/[0.06] bg-[#0b0c0f] overflow-hidden flex flex-col">
            <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 border-b border-white/[0.05]">
              <button
                onClick={() => zoom(-1)}
                className="cw-btn !h-7 !w-7 !p-0"
                aria-label="Zoom out"
              >
                <Minus weight="bold" className="w-3.5 h-3.5" />
              </button>
              <span className="cw-num text-[11px] text-fog-2 w-14 text-center">
                {spacing} px/bar
              </span>
              <button
                onClick={() => zoom(1)}
                className="cw-btn !h-7 !w-7 !p-0"
                aria-label="Zoom in"
              >
                <Plus weight="bold" className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setShowSignal((v) => !v)}
                disabled={!signal}
                className={`cw-btn !h-7 !px-2.5 !text-[11px] disabled:opacity-40 ${
                  showSignal && signal ? "!border-mint/40 !text-mint" : ""
                }`}
              >
                <Crosshair weight="duotone" className="w-3.5 h-3.5" /> Signal
              </button>
              <button
                onClick={() => chartRef.current?.timeScale().fitContent()}
                className="cw-btn !h-7 !px-2.5 !text-[11px]"
              >
                <CornersOut weight="duotone" className="w-3.5 h-3.5" /> Fit
              </button>
              <button
                onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
                className="cw-btn !h-7 !px-2.5 !text-[11px] !border-mint/30 !text-mint"
              >
                <ArrowLineRight weight="bold" className="w-3.5 h-3.5" /> Latest
              </button>
              <span className="ml-auto hidden md:inline text-[10px] text-fog-2">
                Drag to pan · wheel to zoom
              </span>
            </div>
            <div className={`relative h-[440px] ${view === "candles" ? "" : "hidden"}`}>
              <div ref={chartEl} className="absolute inset-0" />
              {!bars.length && (
                <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fog-2">
                  Loading candles…
                </div>
              )}
            </div>
            {view === "footprint" && <Footprint rows={footprint} />}
            {view === "liquidity" && <Liquidity book={book} />}
            <ChartInsightCards insights={chartInsights} />
          </div>

          {/* Order book */}
          <div className="rounded-xl border border-white/[0.06] bg-[#0b0c0f] flex flex-col min-h-[300px]">
            <div className="px-3 py-2.5 border-b border-white/[0.05] flex items-center justify-between">
              <div>
                <div className="text-[10px] text-fog-2">Order book</div>
                <div className="text-[13px] font-medium text-snow">{symbol}</div>
              </div>
              <span className={`text-[10px] ${book.bids.length ? "text-mint" : "text-fog-2"}`}>
                {book.bids.length ? "Live" : "Synchronizing"}
              </span>
            </div>
            <div className="grid grid-cols-3 px-3 py-1.5 text-[10px] text-fog-2">
              <span>Price</span>
              <span className="text-right">Size</span>
              <span className="text-right">Notional</span>
            </div>
            <div className="flex-1 overflow-hidden text-[11px] cw-num flex flex-col">
              <div className="flex-1 flex flex-col justify-end overflow-hidden">
                {book.asks
                  .slice(0, 12)
                  .reverse()
                  .map(([p, s]) => (
                    <BookRow key={`a${p}`} p={p} s={s} max={maxBook} side="ask" />
                  ))}
              </div>
              <div className="px-3 py-2 my-0.5 border-y border-white/[0.05] flex items-center justify-between">
                <span className="text-[14px] font-semibold text-mint">{fmtPrice(last)}</span>
                <span className="text-[10px] text-fog-2">{signal ? "— signal" : "mid"}</span>
              </div>
              <div className="flex-1 overflow-hidden">
                {book.bids.slice(0, 12).map(([p, s]) => (
                  <BookRow key={`b${p}`} p={p} s={s} max={maxBook} side="bid" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ChartInsightCards({ insights }) {
  const trendTone =
    insights.trend.direction === "up"
      ? "text-mint"
      : insights.trend.direction === "down"
        ? "text-coral"
        : "text-terminal-yellow";
  const sentimentLong = insights.sentimentLong >= insights.sentimentShort;
  const levelRange = insights.levels.resistance - insights.levels.support;
  const hasStructureRange =
    Number.isFinite(insights.levels.support) &&
    Number.isFinite(insights.levels.resistance) &&
    levelRange > 0;
  const pricePosition = hasStructureRange
    ? clamp(((insights.price - insights.levels.support) / levelRange) * 100, 0, 100)
    : 50;

  return (
    <div className="grid flex-1 auto-rows-fr grid-cols-2 border-t border-white/[0.06] @4xl:grid-cols-4">
      <div className="relative flex min-h-[132px] min-w-0 flex-col border-b border-r border-white/[0.06] bg-gradient-to-br from-coral/[0.07] via-transparent to-mint/[0.04] p-4 @4xl:border-b-0">
        <div className="pointer-events-none absolute -right-10 -top-10 h-24 w-24 rounded-full bg-coral/[0.06] blur-2xl" />
        <div className="relative z-20 flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-snow">Liquidation risk</div>
          <InfoTip label="Liquidation risk">
            Estimated exposure from OI, funding, momentum and live pressure. It is not actual
            liquidated volume.
          </InfoTip>
        </div>
        <div className="relative mt-4 flex items-end justify-between gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-wide text-fog-2">Long</div>
            <div className="cw-num mt-0.5 text-lg font-semibold text-coral">
              {insights.longLiquidationRisk.toFixed(0)}%
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase tracking-wide text-fog-2">Short</div>
            <div className="cw-num mt-0.5 text-lg font-semibold text-mint">
              {insights.shortLiquidationRisk.toFixed(0)}%
            </div>
          </div>
        </div>
        <div className="relative mt-auto pt-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <span
              className="h-full bg-coral/80"
              style={{ width: `${insights.longLiquidationRisk}%` }}
            />
            <span className="h-full flex-1 bg-mint/80" />
          </div>
          <div className="mt-2 truncate text-[9px] text-fog-2">
            Estimated · {insights.hasLeverageData ? "OI + live pressure" : "live pressure"}
          </div>
        </div>
      </div>

      <div className="relative flex min-h-[132px] min-w-0 flex-col border-b border-white/[0.06] bg-gradient-to-br from-coral/[0.06] via-transparent to-transparent p-4 @4xl:border-b-0 @4xl:border-r">
        <div className="relative z-20 flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-snow">Market trend</div>
          <InfoTip label="Market trend">
            Adaptive EMAs use all available closed bars. Alignment, slopes and ATR decide the
            direction and strength.
          </InfoTip>
        </div>
        <div className="relative mt-4 flex items-end justify-between gap-3">
          <div className={`text-lg font-semibold ${trendTone}`}>{insights.trend.label}</div>
          <div className="cw-num text-xs text-snow">{insights.trend.strength.toFixed(0)}%</div>
        </div>
        <div className="relative mt-auto pt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <span
              className={`block h-full rounded-full ${
                insights.trend.direction === "up"
                  ? "bg-mint"
                  : insights.trend.direction === "down"
                    ? "bg-coral"
                    : "bg-terminal-yellow"
              }`}
              style={{ width: `${insights.trend.strength}%` }}
            />
          </div>
          <div className="mt-2 text-[9px] text-fog-2">
            {insights.trend.barsUsed} / {insights.trend.barsAvailable} bars analyzed
          </div>
        </div>
      </div>

      <div className="relative flex min-h-[132px] min-w-0 flex-col border-r border-white/[0.06] bg-gradient-to-br from-mint/[0.05] via-transparent to-coral/[0.05] p-4">
        <div className="relative z-20 flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-snow">Price structure</div>
          <InfoTip label="Price structure">
            The white marker is current price position between support and resistance—not market
            direction.
          </InfoTip>
        </div>
        <div className="relative mt-4 flex items-end justify-between gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-wide text-fog-2">Support</div>
            <div className="cw-num mt-0.5 text-sm font-semibold text-mint">
              {insights.levels.support ? fmtPrice(insights.levels.support) : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase tracking-wide text-fog-2">Resistance</div>
            <div className="cw-num mt-0.5 text-sm font-semibold text-coral">
              {insights.levels.resistance ? fmtPrice(insights.levels.resistance) : "—"}
            </div>
          </div>
        </div>
        <div className="relative mt-auto pt-3">
          <div className="relative h-1.5 rounded-full bg-gradient-to-r from-mint/70 via-white/15 to-coral/70">
            {hasStructureRange && (
              <span
                title={`Current price ${fmtPrice(insights.price)}`}
                className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-snow shadow-[0_0_8px_rgba(255,255,255,0.45)]"
                style={{ left: `${pricePosition}%` }}
              />
            )}
          </div>
          <div className="cw-num mt-2 text-[9px] text-fog-2">
            {hasStructureRange
              ? `Price ${fmtPrice(insights.price)} · ${pricePosition.toFixed(0)}% of S–R range`
              : "Collecting confirmed levels"}
          </div>
        </div>
      </div>

      <div className="relative flex min-h-[132px] min-w-0 flex-col bg-gradient-to-br from-mint/[0.07] via-transparent to-transparent p-4">
        <div className="relative z-20 flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-snow">Market sentiment</div>
          <InfoTip label="Market sentiment">
            Composite bias from momentum, trade flow, order book, OI and funding—not a trader
            headcount.
          </InfoTip>
        </div>
        <div
          className={`relative mt-4 text-lg font-semibold ${
            sentimentLong ? "text-mint" : "text-coral"
          }`}
        >
          {sentimentLong ? "Longs" : "Shorts"} leading
        </div>
        <div className="relative mt-auto pt-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <span className="h-full bg-mint/80" style={{ width: `${insights.sentimentLong}%` }} />
            <span className="h-full flex-1 bg-coral/80" />
          </div>
          <div className="cw-num mt-2 flex justify-between text-[9px] text-fog-2">
            <span>Long {insights.sentimentLong.toFixed(0)}%</span>
            <span>Short {insights.sentimentShort.toFixed(0)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoTip({ label, children }) {
  return (
    <span className="group/info relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={`About ${label}`}
        className="cw-num flex h-4 w-4 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-[9px] font-semibold text-fog transition-colors hover:border-mint/35 hover:text-mint focus-visible:border-mint/35 focus-visible:text-mint focus-visible:outline-none"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-6 z-50 w-48 translate-y-1 rounded-lg border border-white/[0.1] bg-[#15171a]/98 px-3 py-2 text-[10px] font-normal leading-relaxed text-fog opacity-0 shadow-xl backdrop-blur transition-all group-hover/info:translate-y-0 group-hover/info:opacity-100 group-focus-within/info:translate-y-0 group-focus-within/info:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}

function BookRow({ p, s, max, side }) {
  const notional = p * s;
  return (
    <div className="relative grid grid-cols-3 px-3 py-[3px]">
      <span
        className={`absolute inset-y-0 right-0 ${side === "ask" ? "bg-coral/[0.09]" : "bg-mint/[0.08]"}`}
        style={{ width: `${Math.min(100, (notional / max) * 100)}%` }}
      />
      <span className={`relative ${side === "ask" ? "text-coral" : "text-mint"}`}>
        {fmtPrice(p)}
      </span>
      <span className="relative text-right text-snow/80">
        {s >= 1000 ? `${(s / 1000).toFixed(1)}K` : +s.toFixed(3)}
      </span>
      <span className="relative text-right text-fog">{fmtUsd(notional).replace("$", "")}</span>
    </div>
  );
}

function Footprint({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.buy + r.sell));
  if (!rows.length)
    return (
      <div className="h-[440px] flex items-center justify-center text-[12px] text-fog-2">
        Collecting trades…
      </div>
    );
  return (
    <div className="h-[440px] overflow-auto px-3 py-2 space-y-[3px] text-[11px] cw-num">
      {rows.map((r) => (
        <div key={r.price} className="grid grid-cols-[90px_1fr_1fr] items-center gap-2">
          <span className="text-fog">{fmtPrice(r.price)}</span>
          <div className="flex justify-end">
            <span
              className="h-3 rounded-l bg-coral/50"
              style={{ width: `${(r.sell / max) * 100}%` }}
            />
          </div>
          <div>
            <span
              className="block h-3 rounded-r bg-mint/50"
              style={{ width: `${(r.buy / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Liquidity({ book }) {
  const cum = (levels) => {
    let t = 0;
    return levels.slice(0, 30).map(([p, s]) => {
      t += p * s;
      return [p, t];
    });
  };
  const bids = cum(book.bids);
  const asks = cum(book.asks);
  const max = Math.max(1, bids[bids.length - 1]?.[1] || 0, asks[asks.length - 1]?.[1] || 0);
  if (!bids.length && !asks.length)
    return (
      <div className="h-[440px] flex items-center justify-center text-[12px] text-fog-2">
        Waiting for order book…
      </div>
    );
  return (
    <div className="h-[440px] grid grid-cols-2 gap-3 p-3 text-[11px] cw-num overflow-auto">
      {[
        ["Bids", bids, "bg-mint/40", "text-mint"],
        ["Asks", asks, "bg-coral/40", "text-coral"],
      ].map(([label, levels, bar, txt]) => (
        <div key={label} className="space-y-[3px]">
          <div className="text-[10px] text-fog-2 mb-1">{label} · cumulative notional</div>
          {levels.map(([p, t]) => (
            <div key={p} className="relative h-4 rounded overflow-hidden bg-white/[0.02]">
              <span
                className={`absolute inset-y-0 left-0 ${bar}`}
                style={{ width: `${(t / max) * 100}%` }}
              />
              <span className={`relative px-1.5 ${txt}`}>{fmtPrice(p)}</span>
              <span className="absolute right-1.5 top-0 text-fog">{fmtUsd(t)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
