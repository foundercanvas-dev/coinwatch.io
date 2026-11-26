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
  Bell,
  BellSlash,
} from "@phosphor-icons/react";
import CoinIcon from "./CoinIcon";
import { PageHeader, LivePill, Segmented, StatCard, Metric } from "./ui";
import { fmtPrice, fmtUsd, fmtTime, pct } from "../lib/format";
import {
  analyzeDomHeatmap,
  classifySignalTier,
  computeAtr14,
  computeDeltaAndCVD,
  computeHvnProfile,
  computeHvnReactionHistory,
  detectAbsorptionSignals,
} from "../lib/orderflowMath";
import { calculateSmartEntry, calculateTradePlan } from "../lib/tradeMath";

const FALLBACK_SYMBOLS = [
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

const EXCLUDED_OF_SYMBOLS = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "BUSDUSDT", "DAIUSDT", "USD1USDT", "EURUSDT",
  "XAUUSDT", "XAGUSDT", "XAUTUSDT", "PAXGUSDT", "SPYUSDT", "QQQUSDT", "TQQQUSDT", "SOXLUSDT", "SOXSUSDT",
  "NVDAUSDT", "AMDUSDT", "INTCUSDT", "GOOGLUSDT", "MSTRUSDT", "SPCXUSDT", "SNDKUSDT",
  "SKHYNIXUSDT", "SKHYUSDT", "MUUSDT", "NBISUSDT", "EWYUSDT", "KORUUSDT", "SAMSUNGUSDT",
  "DRAMUSDT", "SNXXUSDT", "CLUSDT", "BZUSDT", "ZHONGJIUSDT",
]);

let cachedFuturesSymbols = null;
let cachedSymbolsAt = 0;

async function fetchLiquidFuturesSymbols() {
  if (cachedFuturesSymbols && Date.now() - cachedSymbolsAt < 300_000) {
    return cachedFuturesSymbols;
  }
  try {
    const tickers = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr").then((r) =>
      r.json(),
    );
    if (Array.isArray(tickers)) {
      const liquid = tickers
        .filter(
          (t) =>
            typeof t.symbol === "string" &&
            t.symbol.endsWith("USDT") &&
            !t.symbol.includes("_") &&
            !EXCLUDED_OF_SYMBOLS.has(t.symbol) &&
            Number(t.quoteVolume) >= 15_000_000 &&
            Number(t.count || 0) >= 15_000,
        )
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
        .slice(0, 120)
        .map((t) => t.symbol);
      if (liquid.length >= 12) {
        cachedFuturesSymbols = liquid;
        cachedSymbolsAt = Date.now();
        return liquid;
      }
    }
  } catch {
    /* fallback below */
  }
  return FALLBACK_SYMBOLS;
}

const CHART_TIMEFRAMES = [
  { value: "1m", label: "1m" },
  { value: "3m", label: "3m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const TIMEFRAMES = [{ value: "all", label: "All" }, ...CHART_TIMEFRAMES];

const ALL_SCAN_TFS = ["1m", "5m", "15m", "1h"];

const IV_SEC = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const NEW_WINDOW_SEC = {
  "1m": 180,
  "3m": 360,
  "5m": 600,
  "15m": 1200,
  "1h": 1800,
  "4h": 2700,
  "1d": 3600,
};

const newWindowFor = (tf) => NEW_WINDOW_SEC[tf] || 600;

const OF_CACHE_PREFIX = "cw.of.cache.v1.";
const OF_FRESH_MS = 20_000;
const OF_STALE_MAX_MS = 300_000;
const memoryOrderFlowCache = new Map();
const inflightOrderFlowScans = new Map();

function readOrderFlowCache(tf) {
  const mem = memoryOrderFlowCache.get(tf);
  if (mem && Date.now() - mem.updatedAt < OF_STALE_MAX_MS) {
    return mem;
  }
  try {
    const raw = localStorage.getItem(`${OF_CACHE_PREFIX}${tf}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Date.now() - Number(parsed.updatedAt || 0) < OF_STALE_MAX_MS) {
      memoryOrderFlowCache.set(tf, parsed);
      return parsed;
    }
  } catch {
    /* ignore storage errors */
  }
  return null;
}

function writeOrderFlowCache(tf, data) {
  memoryOrderFlowCache.set(tf, data);
  try {
    localStorage.setItem(`${OF_CACHE_PREFIX}${tf}`, JSON.stringify(data));
  } catch {
    /* ignore quota errors */
  }
}

function processOrderFlowSnapshot(snapshot, timeframe) {
  const targetTfs = timeframe === "all" ? ["1m", "5m", "15m"] : [timeframe];
  const symbols = Array.isArray(snapshot?.symbols) ? snapshot.symbols : FALLBACK_SYMBOLS;
  const klinesMap = snapshot?.klines || {};
  const depthsMap = snapshot?.depths || {};
  const fundingMap = snapshot?.funding || {};

  let totalInflowUsd = 0;
  let totalOutflowUsd = 0;
  const activeMerged = [];
  const historyMerged = [];

  for (const tf of targetTfs) {
    for (const sym of symbols) {
      const rows = klinesMap[`${sym}:${tf}`];
      if (!Array.isArray(rows) || !rows.length) continue;
      const candles = parseBinanceKlines(rows);
      if (candles.length < 20) continue;

      if (tf === targetTfs[0]) {
        for (const c of candles.slice(-12)) {
          totalInflowUsd += (c.buyVol || 0) * c.close;
          totalOutflowUsd += (c.sellVol || 0) * c.close;
        }
      }

      const hvn = computeHvnProfile(candles, 50);
      const { divergence } = computeDeltaAndCVD(candles);
      const atr14 = computeAtr14(candles);
      const abs = detectAbsorptionSignals(candles, sym, hvn, {
        includeStopped: true,
        includeLive: true,
      });

      for (const sig of abs) {
        const item = {
          ...sig,
          timeframe: tf,
          atr14,
          hasCvdDivergence: Boolean(divergence && divergence.side === sig.side),
          score: Math.min(99, sig.score + (divergence && divergence.side === sig.side ? 5 : 0)),
        };
        if (item.stoppedOut || item.reversed) historyMerged.push(item);
        else activeMerged.push(item);
      }
    }
  }

  const byKey = new Map();
  for (const s of activeMerged.sort((a, b) => b.time - a.time)) {
    const key = `${s.symbol}:${s.timeframe}`;
    if (!byKey.has(key)) {
      byKey.set(key, s);
    } else {
      historyMerged.push({ ...s, expired: true });
    }
  }

  const wallBySym = new Map();
  for (const [sym, depth] of Object.entries(depthsMap)) {
    if (depth?.bids && depth?.asks) {
      const analyzed = analyzeDomHeatmap(depth.bids, depth.asks, new Map(), Date.now(), 0);
      wallBySym.set(sym, {
        hasBuyWall: analyzed.buyWalls.length > 0,
        hasSellWall: analyzed.sellWalls.length > 0,
        buyCluster: analyzed.buyCluster,
        sellCluster: analyzed.sellCluster,
      });
    }
  }

  const enrichedActive = [...byKey.values()]
    .map((s) => {
      const w = wallBySym.get(s.symbol);
      const hasWallConfirm = Boolean(w) && (s.side === "LONG" ? w.hasBuyWall : w.hasSellWall);
      const hasCluster = Boolean(w) && (s.side === "LONG" ? w.buyCluster : w.sellCluster);
      const fundingRate = Number(fundingMap[s.symbol] || 0);
      const classified = classifySignalTier(s, {
        hasWallConfirm,
        hasCluster,
        fundingRate,
      });
      return {
        ...s,
        hasWallConfirm,
        hasCluster: classified.hasCluster,
        tier: classified.tier,
        score: classified.score,
      };
    })
    .filter((s) => s.tier !== "C")
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === "A+" ? -1 : 1;
      return b.time - a.time;
    });

  return {
    watchedCount: Number(snapshot?.watchedCount || symbols.length),
    signals: enrichedActive,
    historySignals: historyMerged.sort((a, b) => b.time - a.time).slice(0, 60),
    flowStats: { inflowUsd: totalInflowUsd, outflowUsd: totalOutflowUsd },
    updatedAt: Date.now(),
  };
}

async function fetchBackendSnapshot(timeframe) {
  const url = `/api/orderflow/snapshot?timeframe=${encodeURIComponent(timeframe)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json && json.klines && Object.keys(json.klines).length > 0) {
        return json;
      }
    }
  } catch {
    /* fallback below */
  }
  return null;
}

async function runSharedOrderFlowScan(timeframe = "all", { force = false } = {}) {
  const existing = readOrderFlowCache(timeframe);
  if (!force && existing && Date.now() - existing.updatedAt < OF_FRESH_MS) {
    return existing;
  }
  if (inflightOrderFlowScans.has(timeframe)) {
    return inflightOrderFlowScans.get(timeframe);
  }

  const job = (async () => {
    // Fast path: 1 shared cached call to backend instead of 120+ per-user Binance calls
    const snapshot = await fetchBackendSnapshot(timeframe);
    if (snapshot) {
      const processed = processOrderFlowSnapshot(snapshot, timeframe);
      writeOrderFlowCache(timeframe, processed);
      if (timeframe === "all") {
        for (const subTf of ["1m", "5m", "15m"]) {
          writeOrderFlowCache(subTf, processOrderFlowSnapshot(snapshot, subTf));
        }
      }
      return processed;
    }

    // Fallback path: direct throttled Binance scan
    const allSymbols = await fetchLiquidFuturesSymbols();
    const targetTfs = timeframe === "all" ? ["1m", "5m", "15m"] : [timeframe];
    const symbols = allSymbols.slice(0, 120);
    const klinesMap = {};
    const batchSize = 12;
    const jobs = [];
    for (const tf of targetTfs) {
      for (const sym of symbols) jobs.push({ sym, tf });
    }
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async ({ sym, tf }) => {
          let rows = await fetch(
            `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=100`,
          ).then((r) => r.json());
          if (!Array.isArray(rows)) {
            rows = await fetch(
              `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=100`,
            ).then((r) => r.json());
          }
          if (Array.isArray(rows) && rows.length) {
            klinesMap[`${sym}:${tf}`] = rows;
          }
        }),
      );
      void results;
      if (i + batchSize < jobs.length) await new Promise((r) => setTimeout(r, 120));
    }

    const processed = processOrderFlowSnapshot(
      { watchedCount: symbols.length, symbols, klines: klinesMap, depths: {}, funding: {} },
      timeframe,
    );
    writeOrderFlowCache(timeframe, processed);
    return processed;
  })();

  inflightOrderFlowScans.set(timeframe, job);
  try {
    return await job;
  } finally {
    inflightOrderFlowScans.delete(timeframe);
  }
}

let didPrefetchAllTfs = false;
function prefetchAllOrderFlowTimeframes() {
  if (didPrefetchAllTfs) return;
  didPrefetchAllTfs = true;
  (async () => {
    for (const tf of ["3m", "1h", "4h", "1d"]) {
      if (!readOrderFlowCache(tf)) {
        try {
          await runSharedOrderFlowScan(tf);
        } catch {
          /* ignore background prefetch errors */
        }
      }
    }
  })();
}

export async function fetchOrderFlowNewSignals() {
  const result = await runSharedOrderFlowScan("all");
  prefetchAllOrderFlowTimeframes();
  const nowS = Math.floor(Date.now() / 1000);
  const fresh = (result.signals || []).filter(
    (s) => s.tier !== "C" && nowS - (s.time - TZ_SHIFT) <= newWindowFor(s.timeframe),
  );
  return fresh.sort((a, b) => b.time - a.time);
}

function formatCountdown(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

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

export default function OrderFlowView({
  risk,
  setActiveNav,
  initialSignal,
  onConsumedInitialSignal,
  onNewSignals,
  popupsEnabled = true,
  onTogglePopups,
}) {
  const initialCache = useMemo(() => readOrderFlowCache("all"), []);
  const [timeframe, setTimeframe] = useState("all");
  const [tab, setTab] = useState("new"); // new | active | history
  const [watchedCount, setWatchedCount] = useState(
    () => initialCache?.watchedCount || FALLBACK_SYMBOLS.length,
  );
  const [signals, setSignals] = useState(() => initialCache?.signals || []);
  const [historySignals, setHistorySignals] = useState(() => initialCache?.historySignals || []);
  const [flowStats, setFlowStats] = useState(
    () => initialCache?.flowStats || { inflowUsd: 0, outflowUsd: 0 },
  );
  const [scanning, setScanning] = useState(() => !initialCache);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(() => Boolean(initialCache));
  const [selectedSignal, setSelectedSignal] = useState(initialSignal || null);
  const [sideFilter, setSideFilter] = useState("all");
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (initialSignal) {
      setSelectedSignal(initialSignal);
      onConsumedInitialSignal?.();
    }
  }, [initialSignal, onConsumedInitialSignal]);

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const scanReqIdRef = useRef(0);

  // Shared cached scanner across liquid Binance Futures pairs & timeframes
  const scanMarkets = useCallback(
    async (force = false) => {
      const reqId = ++scanReqIdRef.current;
      const cached = readOrderFlowCache(timeframe);
      if (cached) {
        setWatchedCount(cached.watchedCount);
        setSignals(cached.signals);
        setHistorySignals(cached.historySignals);
        setFlowStats(cached.flowStats);
        setScanning(false);
      } else {
        setSignals([]);
        setHistorySignals([]);
        setScanning(true);
      }
      try {
        const result = await runSharedOrderFlowScan(timeframe, { force });
        if (reqId !== scanReqIdRef.current) return;
        setWatchedCount(result.watchedCount);
        setSignals(result.signals);
        setHistorySignals(result.historySignals);
        setFlowStats(result.flowStats);
        setHasConnectedOnce(true);
        prefetchAllOrderFlowTimeframes();
        const nowS = Math.floor(Date.now() / 1000);
        const freshNew = (result.signals || []).filter(
          (s) => s.tier !== "C" && nowS - (s.time - TZ_SHIFT) <= newWindowFor(s.timeframe),
        );
        onNewSignals?.(freshNew);
      } catch {
        /* keep previous/cached signals */
      } finally {
        if (reqId === scanReqIdRef.current) {
          setScanning(false);
        }
      }
    },
    [timeframe],
  );

  useEffect(() => {
    scanMarkets(false);
    const timer = setInterval(() => scanMarkets(true), 40000);
    return () => clearInterval(timer);
  }, [scanMarkets]);

  if (selectedSignal) {
    return (
      <OrderFlowSignalChart
        signal={selectedSignal}
        timeframe={selectedSignal.timeframe || "5m"}
        risk={risk}
        onBack={() => setSelectedSignal(null)}
        onSwitchSignal={(nextSig) => setSelectedSignal(nextSig)}
        setActiveNav={setActiveNav}
        popupsEnabled={popupsEnabled}
      />
    );
  }

  const tfSignals =
    timeframe === "all" ? signals : signals.filter((s) => s.timeframe === timeframe);
  const tfHistory =
    timeframe === "all" ? historySignals : historySignals.filter((s) => s.timeframe === timeframe);
  const newSignals = tfSignals.filter(
    (s) => nowSec - (s.time - TZ_SHIFT) <= newWindowFor(s.timeframe),
  );
  const activeSignals = tfSignals.filter(
    (s) => nowSec - (s.time - TZ_SHIFT) > newWindowFor(s.timeframe),
  );
  const sourceList =
    tab === "new" ? newSignals : tab === "active" ? activeSignals : tfHistory;
  const visibleSignals = sourceList.filter(
    (s) => sideFilter === "all" || s.side === sideFilter.toUpperCase(),
  );
  const longCount = tfSignals.filter((s) => s.side === "LONG").length;
  const shortCount = tfSignals.filter((s) => s.side === "SHORT").length;
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
          <div className="flex items-center gap-2">
            {onTogglePopups && (
              <button
                type="button"
                onClick={onTogglePopups}
                aria-pressed={popupsEnabled}
                title={popupsEnabled ? "Turn off popup notifications" : "Turn on popup notifications"}
                className={`cw-btn !h-9 !px-3 gap-2.5 ${
                  popupsEnabled ? "!border-mint/30 !bg-mint/[0.06] !text-snow" : "!text-fog"
                }`}
              >
                {popupsEnabled ? (
                  <Bell weight="fill" className="w-4 h-4 text-mint" />
                ) : (
                  <BellSlash weight="duotone" className="w-4 h-4 text-fog-2" />
                )}
                <span className="text-[12px] font-medium">Alerts</span>
                <span
                  aria-hidden="true"
                  className={`relative w-7 h-4 rounded-full transition-colors ${
                    popupsEnabled ? "bg-mint" : "bg-white/10"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                      popupsEnabled ? "left-3.5 bg-ink" : "left-0.5 bg-fog"
                    }`}
                  />
                </span>
              </button>
            )}
            <LivePill isConnected={hasConnectedOnce || !scanning || signals.length > 0} />
          </div>
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
        <StatCard label="Watched Pairs" value={watchedCount} caption="Live market feed" />
        <StatCard
          label="New Setups"
          value={newSignals.length}
          caption="Per-timeframe live window"
          highlight
        />
        <StatCard label="Active Setups" value={activeSignals.length} caption="Open until SL / new signal" />
        <StatCard
          label="Buy / Sell"
          value={`${longCount} / ${shortCount}`}
          caption="Live directional split"
          tone={longCount >= shortCount ? "up" : "down"}
        />
      </div>

      {/* Filter Bar + New / Active / History + Timeframe + Side */}
      <section className="cw-panel p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "new", label: "New", badge: newSignals.length },
              { value: "active", label: "Active", badge: activeSignals.length },
              { value: "history", label: "History", badge: tfHistory.length },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              value={timeframe}
              onChange={setTimeframe}
              options={TIMEFRAMES}
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
        </div>

        <div className="grid gap-3 @3xl:grid-cols-2">
          {visibleSignals.map((sig) => {
            const isLong = sig.side === "LONG";
            const baseCoin = sig.symbol.replace(/USDT$/, "");
            const moveVal = Number(sig.movePct || 0);
            const winSec = newWindowFor(sig.timeframe);
            const ageSec = Math.max(0, nowSec - (sig.time - TZ_SHIFT));
            const remSec = Math.max(0, winSec - ageSec);
            const remPct = Math.max(0, Math.min(100, (remSec / winSec) * 100));
            const isNew = tab === "new" && remSec > 0;
            const spanFull = visibleSignals.length === 1;

            return (
              <button
                key={sig.id}
                type="button"
                onClick={() => setSelectedSignal(sig)}
                className={`cw-card cw-hover cw-press text-left p-4 space-y-3 ${
                  spanFull ? "col-span-full" : ""
                } ${
                  isNew
                    ? isLong
                      ? "cw-vol-mid-up !border-mint/35"
                      : "cw-vol-mid-down !border-coral/35"
                    : ""
                }`}
              >
                {isNew && (
                  <div className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/[0.04] to-transparent cw-sweep" />
                )}

                <div className="relative flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <CoinIcon
                      symbol={sig.symbol}
                      coin={baseCoin}
                      exchange="binance"
                      className="w-9 h-9 shrink-0"
                      isPump={isLong}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold text-snow truncate">
                          {baseCoin}
                          <span className="text-fog-2 font-normal">/USDT</span>
                        </span>
                        <span className="px-2 py-0.5 rounded-md bg-white/[0.08] border border-white/[0.12] text-[12px] font-bold uppercase text-snow cw-num">
                          {sig.timeframe}
                        </span>
                        {sig.tier && (
                          <span
                            className={`px-2 py-0.5 rounded-md text-[11px] font-bold cw-num border ${
                              sig.tier === "A+"
                                ? "bg-terminal-yellow/15 border-terminal-yellow/40 text-terminal-yellow"
                                : "bg-white/[0.05] border-white/[0.10] text-fog"
                            }`}
                          >
                            {sig.tier}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-fog-2 cw-num mt-0.5">
                        {fmtTime((sig.time - TZ_SHIFT) * 1000)}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0 flex flex-col items-end gap-1.5">
                    <div className="flex items-center gap-1.5">
                      {isNew && (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-mint/15 border border-mint/30 text-mint cw-num">
                          NEW · {formatCountdown(remSec)}
                        </span>
                      )}
                      {(sig.stoppedOut || sig.reversed || sig.expired) && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/[0.06] text-fog">
                          {sig.reversed ? "Reversed" : sig.stoppedOut ? "Stopped out" : "Expired"}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
                          isLong
                            ? "bg-mint/15 border-mint/40 text-mint cw-vol-high-up"
                            : "bg-coral/15 border-coral/40 text-coral cw-vol-high-down"
                        }`}
                      >
                        {isLong ? <TrendUp weight="bold" className="w-3.5 h-3.5" /> : <TrendDown weight="bold" className="w-3.5 h-3.5" />}
                        {sig.side}
                      </span>
                    </div>
                    <div className={`cw-num text-[14px] font-semibold ${moveVal >= 0 ? "text-mint" : "text-coral"}`}>
                      {pct(moveVal)}
                    </div>
                  </div>
                </div>

                <div className="relative grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.05] text-[11px]">
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

                {isNew && (
                  <div className="relative h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
                    <div
                      className={`h-full transition-[width] duration-1000 ${
                        isLong ? "bg-mint" : "bg-coral"
                      }`}
                      style={{ width: `${remPct}%` }}
                    />
                  </div>
                )}
              </button>
            );
          })}

          {!visibleSignals.length && (
            <div className="col-span-full py-12 flex flex-col items-center justify-center gap-3.5 text-center">
              {tab === "new" ? (
                <>
                  <div className="relative w-20 h-20 rounded-full border border-mint/25 bg-mint/[0.03] flex items-center justify-center overflow-hidden shadow-[0_0_24px_rgba(45,212,191,0.08)]">
                    {/* Concentric radar rings */}
                    <div className="absolute inset-2.5 rounded-full border border-mint/15" />
                    <div className="absolute inset-5 rounded-full border border-mint/15" />
                    {/* Crosshair lines */}
                    <div className="absolute inset-x-0 top-1/2 h-px bg-mint/10" />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-mint/10" />
                    {/* Rotating radar sweep beam */}
                    <div
                      className="absolute inset-0 rounded-full animate-spin"
                      style={{
                        animationDuration: "2.4s",
                        background:
                          "conic-gradient(from 0deg, rgba(45,212,191,0.34) 0deg, rgba(45,212,191,0.08) 45deg, transparent 85deg, transparent 360deg)",
                      }}
                    />
                    {/* Blip dots */}
                    <span className="absolute top-3.5 right-4 w-1.5 h-1.5 rounded-full bg-mint/80 animate-ping" />
                    <span
                      className="absolute bottom-4 left-4 w-1 h-1 rounded-full bg-mint/60 animate-pulse"
                      style={{ animationDelay: "0.7s" }}
                    />
                    {/* Center pulse */}
                    <span className="relative w-2.5 h-2.5 rounded-full bg-mint shadow-[0_0_10px_rgba(45,212,191,0.9)]" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-[13px] font-medium text-snow">
                      Scanning live market for new setups…
                    </div>
                    <div className="text-[11px] text-fog-2">
                      {scanning
                        ? `Watching ${watchedCount} pairs in real time`
                        : "Watching live pairs — check Active for ongoing setups"}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-fog-2 py-2">
                  {tab === "history"
                    ? "No closed or expired setups in history yet."
                    : scanning
                      ? "Looking for active setups…"
                      : "No active setups right now."}
                </div>
              )}
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
function OrderFlowSignalChart({
  signal,
  timeframe,
  risk,
  onBack,
  onSwitchSignal,
  setActiveNav,
  popupsEnabled = true,
}) {
  const [chartIv, setChartIv] = useState(timeframe || "5m");
  const [candles, setCandles] = useState([]);
  const [absorptions, setAbsorptions] = useState([signal]);
  const [live, setLive] = useState(false);
  const [lastPrice, setLastPrice] = useState(signal.price || 0);
  const [liveVol, setLiveVol] = useState({ buyUsd: 0, sellUsd: 0 });
  const [dom, setDom] = useState({ bids: [], asks: [], buyWalls: [], sellWalls: [], spoofs: [] });
  const [spoofLog, setSpoofLog] = useState([]);
  const [popupDismissedId, setPopupDismissedId] = useState(null);
  const [chartMenu, setChartMenu] = useState(null);
  const [customLinesCount, setCustomLinesCount] = useState(0);
  const [showEntrySl, setShowEntrySl] = useState(true);

  const chartWrapRef = useRef(null);
  const chartElRef = useRef(null);
  const hvnCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const priceLinesRef = useRef([]);
  const customLinesRef = useRef([]);
  const candlesRef = useRef([]);
  const absorptionsRef = useRef([signal]);
  const hvnDataRef = useRef({ bins: [], hvnsWithReaction: [], poc: null, maxVol: 0 });
  const hvnHitboxesRef = useRef([]);
  const tfSetupRef = useRef(signal);
  const wallTrackerRef = useRef(new Map());
  const seededRef = useRef(false);
  const [hoveredHvn, setHoveredHvn] = useState(null);

  const updateHvnState = useCallback((candleList) => {
    const hvn = computeHvnProfile(candleList, 50);
    const hvnsWithReaction = hvn ? computeHvnReactionHistory(candleList, hvn) : [];
    const maxVol = hvn?.bins?.length ? Math.max(...hvn.bins.map((b) => b.volume)) : 0;
    hvnDataRef.current = {
      bins: hvn?.bins || [],
      hvnsWithReaction,
      poc: hvn?.poc || null,
      maxVol,
    };
    return hvn;
  }, []);

  const drawAbsorptionCircles = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const hvnCanvas = hvnCanvasRef.current;
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

    // 1. Draw Horizontal Volume Profile / HVN bars behind candles on hvnCanvas
    const { bins, hvnsWithReaction, maxVol } = hvnDataRef.current;
    const hvnByIdx = new Map(hvnsWithReaction.map((h) => [h.index, h]));
    if (hvnCanvas) {
      if (hvnCanvas.width !== Math.floor(width * dpr) || hvnCanvas.height !== Math.floor(height * dpr)) {
        hvnCanvas.width = Math.floor(width * dpr);
        hvnCanvas.height = Math.floor(height * dpr);
      }
      const hctx = hvnCanvas.getContext("2d");
      hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hctx.clearRect(0, 0, width, height);

      const maxBarWidth = width * 0.48;
      for (const bin of bins) {
        const yTop = series.priceToCoordinate(bin.high);
        const yBot = series.priceToCoordinate(bin.low);
        if (yTop == null || yBot == null || !Number.isFinite(yTop) || !Number.isFinite(yBot)) continue;
        const rawH = Math.abs(yBot - yTop);
        const top = Math.min(yTop, yBot);
        const barW = maxVol > 0 ? Math.max(16, (bin.volume / maxVol) * maxBarWidth) : 16;
        const hvnEntry = hvnByIdx.get(bin.index);

        if (hvnEntry) {
          const barH = Math.max(hvnEntry.isPoc ? 16 : 13, rawH * 0.9);
          const yDraw = top + (rawH - barH) / 2;
          hctx.fillStyle = hvnEntry.isPoc
            ? "rgba(180, 108, 24, 0.44)"
            : "rgba(128, 92, 32, 0.32)";
          hctx.fillRect(0, yDraw, barW, barH);
        } else {
          const barH = Math.max(1.5, Math.min(3, rawH * 0.35));
          const yDraw = top + (rawH - barH) / 2;
          hctx.fillStyle = "rgba(156, 163, 175, 0.06)";
          hctx.fillRect(0, yDraw, barW, barH);
        }
      }
    }

    // 2. Draw clean ATAS-style X Data + Reaction History inside right end of each HVN bar
    const hitboxes = [];
    const placedPillYs = [];
    const maxBarWidth = width * 0.48;
    const sortedHvns = [...hvnsWithReaction].sort((a, b) => {
      if (a.isPoc !== b.isPoc) return a.isPoc ? -1 : 1;
      return b.volume - a.volume;
    });

    for (const bin of sortedHvns) {
      const yTop = series.priceToCoordinate(bin.high);
      const yBot = series.priceToCoordinate(bin.low);
      const yMid = series.priceToCoordinate(bin.price);
      if (yMid == null || !Number.isFinite(yMid)) continue;

      const barW = maxVol > 0 ? Math.max(120, (bin.volume / maxVol) * maxBarWidth) : 120;
      const yMin = yTop != null && yBot != null ? Math.min(yTop, yBot) - 3 : yMid - 8;
      const yMax = yTop != null && yBot != null ? Math.max(yTop, yBot) + 3 : yMid + 8;
      hitboxes.push({ yMin, yMax, xMax: Math.max(barW + 40, width * 0.52), bin });

      if (placedPillYs.some((py) => Math.abs(py - yMid) < 18)) continue;
      placedPillYs.push(yMid);

      const volPart = `${formatCompactNum(bin.volume)} | `;
      const pctPart = `${bin.percent}%`;
      const reactPart =
        bin.touches > 0 ? ` | ${bin.reactions}/${bin.touches} (${bin.reactionRate}%)` : "";

      ctx.save();
      ctx.font = '700 11px "Funnel Display", sans-serif';
      const volW = ctx.measureText(volPart).width;
      const pctW = ctx.measureText(pctPart).width;
      ctx.font = '600 10px "Funnel Display", sans-serif';
      const reactW = reactPart ? ctx.measureText(reactPart).width : 0;
      const totalTextW = volW + pctW + reactW + 14;

      const labelX = Math.max(8, Math.min(width - totalTextW - 76, barW - totalTextW + 10));
      const labelY = Math.max(8, Math.min(height - 8, yMid));

      // Subtle dark backing only behind text so it stays legible over candles
      ctx.fillStyle = "rgba(11, 12, 15, 0.72)";
      ctx.fillRect(labelX - 4, labelY - 7, totalTextW + 6, 14);

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = '700 11px "Funnel Display", sans-serif';
      ctx.fillStyle = "#FFD700";
      ctx.fillText(volPart, labelX, labelY);

      ctx.fillStyle = bin.role === "SUPPORT" ? "#7ee6a3" : "#f2707c";
      ctx.fillText(pctPart, labelX + volW, labelY);

      if (reactPart) {
        ctx.font = '600 10px "Funnel Display", sans-serif';
        ctx.fillStyle = "#FFD700";
        ctx.fillText(reactPart, labelX + volW + pctW, labelY);
      }

      // Clean confidence dot right after text
      const dotX = labelX + volW + pctW + reactW + 7;
      ctx.beginPath();
      ctx.arc(dotX, labelY, 3, 0, Math.PI * 2);
      ctx.fillStyle = bin.confidenceColor;
      ctx.fill();
      ctx.restore();
    }
    hvnHitboxesRef.current = hitboxes;

    // 3. Absorption circles
    const ts = chart.timeScale();
    for (const sig of absorptionsRef.current) {
      const x = ts.timeToCoordinate(sig.time);
      const y = series.priceToCoordinate(sig.price);
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;

      const isLong = sig.side === "LONG";
      const curTfSetup = tfSetupRef.current;
      const isCurrent = Boolean(curTfSetup && sig.time === curTfSetup.time && sig.side === curTfSetup.side);
      const radius = isCurrent ? 25 : 16;

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

      ctx.fillStyle = isCurrent ? "#f1f3f1" : "rgba(241, 243, 241, 0.55)";
      ctx.font = isCurrent
        ? '600 11px "Funnel Display", sans-serif'
        : '500 9.5px "Funnel Display", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(formatCompactNum(sig.absorbedVol), x, y);
    }

    // 4. X Imbalance inside current candle when price is within 0.1% of any HVN bar
    const curList = candlesRef.current;
    if (curList.length && hvnsWithReaction.length) {
      const curBar = curList[curList.length - 1];
      const nearHvn = hvnsWithReaction.some(
        (h) => h.price > 0 && Math.abs(curBar.close - h.price) / h.price <= 0.001,
      );
      if (nearHvn) {
        const xCur = ts.timeToCoordinate(curBar.time);
        const yCur = series.priceToCoordinate(curBar.close);
        if (xCur != null && yCur != null && Number.isFinite(xCur) && Number.isFinite(yCur)) {
          const buyV = Number(curBar.buyVol || 0);
          const sellV = Number(curBar.sellVol || 0);
          const maxV = Math.max(buyV, sellV);
          const minV = Math.min(buyV, sellV);
          const ratio = minV > 0 ? Math.round(maxV / minV) : maxV > 0 ? 99 : 1;
          const delta = Math.round(buyV - sellV);
          const imbText = `${ratio}x | ${delta >= 0 ? "+" : ""}${formatCompactNum(delta)}`;
          const isExtreme = ratio >= 5;

          ctx.save();
          ctx.font = '700 11px "Funnel Display", sans-serif';
          const tw = ctx.measureText(imbText).width + 14;
          const th = 19;
          const bx = Math.max(6, Math.min(width - tw - 76, xCur - tw / 2));
          const by = Math.max(6, yCur - 26);
          if (isExtreme) {
            ctx.shadowColor = "rgba(255, 215, 0, 0.75)";
            ctx.shadowBlur = 12;
          }
          ctx.fillStyle = isExtreme ? "rgba(255, 215, 0, 0.22)" : "rgba(11, 12, 15, 0.90)";
          ctx.strokeStyle = isExtreme ? "#FFD700" : "rgba(255, 215, 0, 0.45)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(bx, by, tw, th, 5);
          ctx.fill();
          ctx.stroke();

          ctx.shadowBlur = 0;
          ctx.fillStyle = "#FFD700";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(imbText, bx + tw / 2, by + th / 2);
          ctx.restore();
        }
      }
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

    const load = async (attempt = 0) => {
      try {
        const [klineRes, depthRes] = await Promise.allSettled([
          fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${chartIv}&limit=180`).then((r) => r.json()),
          fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=100`).then((r) => r.json()),
        ]);
        if (!alive) return;
        const klineRows = klineRes.status === "fulfilled" ? klineRes.value : null;
        const depthData = depthRes.status === "fulfilled" ? depthRes.value : null;
        const parsed = parseBinanceKlines(klineRows);
        if (!parsed.length && attempt < 2) {
          setTimeout(() => alive && load(attempt + 1), 1500);
          return;
        }
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
        const hvn = updateHvnState(parsed);
        const allAbs = detectAbsorptionSignals(parsed, sym, hvn, { includeStopped: true, includeLive: true });
        const list = [...allAbs];
        if (chartIv === signal.timeframe && !list.some((s) => s.time === signal.time && s.side === signal.side)) {
          list.unshift(signal);
        }
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
      let pendingPrice = null;
      let pendingVol = null;
      let pendingDom = null;
      let circleRaf = 0;
      const scheduleCircles = () => {
        if (circleRaf) return;
        circleRaf = requestAnimationFrame(() => {
          circleRaf = 0;
          drawAbsorptionCircles();
        });
      };
      const uiFlushTimer = setInterval(() => {
        if (!alive) return;
        if (pendingPrice !== null) {
          setLastPrice(pendingPrice);
          pendingPrice = null;
        }
        if (pendingVol !== null) {
          setLiveVol(pendingVol);
          pendingVol = null;
        }
        if (pendingDom !== null) {
          setDom(pendingDom);
          pendingDom = null;
        }
      }, 100);

      ws = new WebSocket(
        `wss://fstream.binance.com/stream?streams=${symLower}@trade/${symLower}@depth20@100ms/${symLower}@kline_${chartIv}`,
      );
      ws.onopen = () => alive && setLive(true);
      ws.onmessage = (evt) => {
        if (!alive) return;
        try {
          const msg = JSON.parse(evt.data);
          const stream = msg.stream || "";
          const data = msg.data;
          if (!data) return;

          if (stream.endsWith("@trade") || stream.endsWith("@aggTrade")) {
            const price = Number(data.p);
            const qty = Number(data.q);
            const isSell = Boolean(data.m);
            const tradeSec = Math.floor(Number(data.T || data.E || Date.now()) / 1000);
            const bucketTime = Math.floor(tradeSec / ivSec) * ivSec + TZ_SHIFT;
            if (!(price > 0)) return;
            pendingPrice = price;
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
                list.push(newBar);
                if (list.length > 200) list.shift();
                pendingVol = {
                  buyUsd: newBar.buyVol * price,
                  sellUsd: newBar.sellVol * price,
                };
                try {
                  seriesRef.current?.update(newBar);
                  scheduleCircles();
                } catch {
                  /* ignore */
                }
              } else if (bucketTime === last.time) {
                last.close = price;
                if (price > last.high) last.high = price;
                if (price < last.low) last.low = price;
                last.volume += qty;
                if (isSell) last.sellVol += qty;
                else last.buyVol += qty;
                pendingVol = {
                  buyUsd: last.buyVol * price,
                  sellUsd: last.sellVol * price,
                };
                try {
                  seriesRef.current?.update(last);
                  scheduleCircles();
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
            pendingDom = analyzed;
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
            const list = candlesRef.current;
            const last = list[list.length - 1];
            if (!last || t > last.time) {
              list.push(bar);
              if (list.length > 200) list.shift();
              pendingPrice = bar.close;
              pendingVol = { buyUsd: bar.buyVol * bar.close, sellUsd: bar.sellVol * bar.close };
              try {
                seriesRef.current?.update(bar);
                scheduleCircles();
              } catch {
                /* ignore */
              }
            } else if (t === last.time) {
              // Sync official open/high/low/volume without snapping live tick price backwards
              last.open = bar.open;
              last.high = Math.max(last.high, bar.high);
              last.low = Math.min(last.low, bar.low);
              last.volume = Math.max(last.volume, bar.volume);
              last.buyVol = Math.max(last.buyVol, bar.buyVol);
              last.sellVol = Math.max(last.sellVol, bar.sellVol);
              if (k.x) {
                last.close = bar.close;
                const hvn = updateHvnState(list);
                const allAbs = detectAbsorptionSignals(list, sym, hvn, { includeStopped: true, includeLive: true });
                const nextAbs = [...allAbs];
                if (chartIv === signal.timeframe && !nextAbs.some((s) => s.time === signal.time && s.side === signal.side)) {
                  nextAbs.unshift(signal);
                }
                absorptionsRef.current = nextAbs;
                setAbsorptions(nextAbs);
              }
              try {
                seriesRef.current?.update(last);
                scheduleCircles();
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
        clearInterval(uiFlushTimer);
        if (circleRaf) cancelAnimationFrame(circleRaf);
        if (!alive) return;
        setLive(false);
        reconnectTimer = setTimeout(connect, 1500);
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
        const hvn = updateHvnState(candlesRef.current);
        const allAbs = detectAbsorptionSignals(candlesRef.current, sym, hvn, { includeStopped: true, includeLive: true });
        const list = [...allAbs];
        if (chartIv === signal.timeframe && !list.some((s) => s.time === signal.time && s.side === signal.side)) {
          list.unshift(signal);
        }
        absorptionsRef.current = list;
        setAbsorptions(list);
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

  // Active setup for the currently selected timeframe (so each TF has its own circle, Entry & SL)
  const tfSetup = useMemo(() => {
    const activeOnTf = absorptions.find((s) => !s.stoppedOut && !s.reversed);
    if (chartIv === signal.timeframe) {
      return activeOnTf || signal;
    }
    return activeOnTf || null;
  }, [absorptions, chartIv, signal]);
  tfSetupRef.current = tfSetup;

  const tfAtr14 = useMemo(() => computeAtr14(candles) || signal.atr14 || 0, [candles, signal.atr14]);

  // Risk Setup Trade Plan (mandatory)
  const tradePlan = useMemo(() => {
    if (!risk?.configured || !tfSetup) return null;
    const entry = calculateSmartEntry({
      triggerClose: tfSetup.triggerClose || tfSetup.price,
      open: tfSetup.open,
      high: tfSetup.high,
      low: tfSetup.low,
      side: tfSetup.side,
      atrAbs: tfAtr14,
      currentPrice: candles[candles.length - 1]?.close || tfSetup.price,
      entryMode: risk.entryMode || "retest",
    });
    const stopLoss = tfSetup.side === "SHORT" ? tfSetup.high : tfSetup.low;
    return calculateTradePlan({
      entry,
      side: tfSetup.side,
      stopLoss,
      atrAbs: tfAtr14,
      rewardRatio: Number(risk.rewardRatio) || 1.5,
      balance: Number(risk.balance) || 10000,
      riskPct: Math.min(Number(risk.riskPerTrade) || 1, Number(risk.maxLoss) || Infinity),
    });
  }, [risk, tfSetup, tfAtr14, candles]);

  // Detect opposite-side reversal after this setup
  const reversalSignal = useMemo(() => {
    if (!tfSetup) return null;
    const rev = absorptions.find((s) => s.time > tfSetup.time && s.side !== tfSetup.side);
    return rev || null;
  }, [absorptions, tfSetup]);

  // Check if SL was hit (either on load or live)
  const isStoppedOut = useMemo(() => {
    if (!tfSetup) return false;
    if (tfSetup.stoppedOut) return true;
    if (!candles.length) return false;
    const stopPrice = tradePlan?.stop || (tfSetup.side === "SHORT" ? tfSetup.high : tfSetup.low);
    if (!(stopPrice > 0)) return false;
    if (lastPrice > 0) {
      if (tfSetup.side === "LONG" && lastPrice <= stopPrice) return true;
      if (tfSetup.side === "SHORT" && lastPrice >= stopPrice) return true;
    }
    for (const c of candles) {
      if (c.time <= tfSetup.time) continue;
      if (tfSetup.side === "LONG" && c.low <= stopPrice) return true;
      if (tfSetup.side === "SHORT" && c.high >= stopPrice) return true;
    }
    return false;
  }, [tfSetup, tradePlan, lastPrice, candles]);

  // Check whether pullback Entry has been filled yet
  const entryFilled = useMemo(() => {
    if (!tfSetup) return false;
    const entryPrice = tradePlan?.entry;
    if (!(entryPrice > 0)) return false;
    for (const c of candles) {
      if (c.time < tfSetup.time) continue;
      if (tfSetup.side === "LONG" && c.low <= entryPrice) return true;
      if (tfSetup.side === "SHORT" && c.high >= entryPrice) return true;
    }
    if (lastPrice > 0) {
      if (tfSetup.side === "LONG" && lastPrice <= entryPrice) return true;
      if (tfSetup.side === "SHORT" && lastPrice >= entryPrice) return true;
    }
    return false;
  }, [tfSetup, tradePlan, candles, lastPrice]);

  const setupClosed = isStoppedOut || Boolean(reversalSignal);

  // Seed chart data ONLY ONCE per load/timeframe so live series.update() never gets overwritten
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.length || seededRef.current) return;

    const seen = new Set();
    const clean = [];
    for (const c of [...candles].sort((a, b) => a.time - b.time)) {
      if (!Number.isFinite(c.time) || seen.has(c.time)) continue;
      seen.add(c.time);
      clean.push(c);
    }
    try {
      series.setData(clean);
      seededRef.current = true;
    } catch {
      /* ignore */
    }
    requestAnimationFrame(drawAbsorptionCircles);
  }, [candles, drawAbsorptionCircles]);

  // Plot ENTRY / SL lines on the chart (removed automatically if stopped out or reversed) + redraw circles
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* ignore */
      }
    }
    const lines = [];
    if (tfSetup && !setupClosed && showEntrySl) {
      const entryPrice =
        tradePlan?.entry ||
        calculateSmartEntry({
          triggerClose: tfSetup.triggerClose || tfSetup.price,
          open: tfSetup.open,
          high: tfSetup.high,
          low: tfSetup.low,
          side: tfSetup.side,
          atrAbs: tfAtr14,
          currentPrice: lastPrice || tfSetup.price,
          entryMode: risk?.entryMode || "retest",
        });
      const stopPrice =
        tradePlan?.stop || (tfSetup.side === "SHORT" ? tfSetup.high : tfSetup.low);
      const specs = [
        ["ENTRY", entryPrice, "#a3d9c4", LineStyle.Solid],
        ["SL", stopPrice, "#f2707c", LineStyle.Solid],
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
  }, [tfSetup, tradePlan, tfAtr14, lastPrice, risk?.entryMode, setupClosed, showEntrySl, absorptions, drawAbsorptionCircles]);

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
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{`${isLong ? "Buy" : "Sell"} setup near recent ${isLong ? "low" : "high"} · ${chartIv}`}</span>
            {tfSetup?.time && (
              <span className="cw-num text-fog">
                · {fmtTime((tfSetup.time - TZ_SHIFT) * 1000)}
              </span>
            )}
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
              options={CHART_TIMEFRAMES}
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
        if (!activePopupKey || !popupsEnabled || popupDismissedId === activePopupKey) return null;

        return (
          <div
            className={`fixed top-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2rem)] cw-panel cw-glow p-4 shadow-2xl overflow-hidden space-y-3 cw-toast-in ${
              reversalSignal
                ? "!border-terminal-yellow/50 cw-vol-mid-up"
                : "!border-coral/50 cw-vol-high-down"
            }`}
          >
            <div className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent cw-sweep" />
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

      {/* Live Buy / Sell Volume Bar (single clean card) */}
      {(() => {
        const totalUsd = liveVol.buyUsd + liveVol.sellUsd;
        const buyPct = totalUsd > 0 ? (liveVol.buyUsd / totalUsd) * 100 : 50;
        const sellPct = 100 - buyPct;
        return (
          <div className="cw-panel relative h-12 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-mint/[0.24] via-mint/[0.13] to-mint/[0.03] transition-[width] duration-150 ease-out"
              style={{ width: `${buyPct}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-gradient-to-l from-coral/[0.24] via-coral/[0.13] to-coral/[0.03] transition-[width] duration-150 ease-out"
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

      {/* Clean Candlestick Chart with 10% Opacity Absorption Circle Overlay + MBO DOM Side Panel */}
      <section className="cw-panel p-3 md:p-4">
        <div className="grid gap-3 @5xl:grid-cols-[1fr_280px]">
          <div
            ref={chartWrapRef}
            onClick={() => chartMenu && setChartMenu(null)}
            onMouseMove={(e) => {
              const rect = chartWrapRef.current?.getBoundingClientRect();
              if (!rect) return;
              const localX = e.clientX - rect.left;
              const localY = e.clientY - rect.top;
              const hit = hvnHitboxesRef.current.find(
                (hb) => localY >= hb.yMin && localY <= hb.yMax && localX <= hb.xMax,
              );
              if (hit) {
                setHoveredHvn({
                  x: Math.min(rect.width - 210, Math.max(12, localX + 14)),
                  y: Math.min(rect.height - 170, Math.max(12, localY - 12)),
                  bin: hit.bin,
                });
              } else if (hoveredHvn) {
                setHoveredHvn(null);
              }
            }}
            onMouseLeave={() => hoveredHvn && setHoveredHvn(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const rect = chartWrapRef.current?.getBoundingClientRect();
              if (!rect) return;
              const localX = Math.min(rect.width - 190, Math.max(8, e.clientX - rect.left));
              const localY = Math.min(rect.height - 190, Math.max(8, e.clientY - rect.top));
              let price = null;
              try {
                price = seriesRef.current?.coordinateToPrice(e.clientY - rect.top) ?? null;
              } catch {
                price = null;
              }
              setChartMenu({ x: localX, y: localY, price });
            }}
            className="relative h-[600px] rounded-xl border border-white/[0.06] bg-[#0b0c0f] overflow-hidden select-none"
          >
            <canvas
              ref={hvnCanvasRef}
              className="pointer-events-none absolute inset-0 z-0 w-full h-full"
            />
            <div ref={chartElRef} className="absolute inset-0 z-[1]" />
            <canvas
              ref={overlayCanvasRef}
              className="pointer-events-none absolute inset-0 z-10 w-full h-full"
            />
            {hoveredHvn && (
              <div
                style={{ left: hoveredHvn.x, top: hoveredHvn.y }}
                className="pointer-events-none absolute z-20 w-48 rounded-lg border border-white/[0.14] bg-[#0b0c0f]/95 backdrop-blur-md px-3 py-2 shadow-2xl text-[11px] space-y-1 cw-num"
              >
                <div className="flex items-center justify-between text-fog-2">
                  <span>Price</span>
                  <span className="font-semibold text-snow">{fmtPrice(hoveredHvn.bin.price)}</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Volume</span>
                  <span className="font-semibold text-[#FFD700]">{formatCompactNum(hoveredHvn.bin.volume)}</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Share</span>
                  <span className="font-semibold text-[#FFD700]">{hoveredHvn.bin.percent}%</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Touches</span>
                  <span className="font-semibold text-snow">{hoveredHvn.bin.touches}</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Reactions</span>
                  <span className="font-semibold text-snow">{hoveredHvn.bin.reactions}</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Reaction Rate</span>
                  <span className="font-semibold text-snow">{hoveredHvn.bin.reactionRate}%</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Type</span>
                  <span className="font-semibold text-amber-400">
                    {hoveredHvn.bin.isPoc ? "POC · HVN Strong" : "HVN Strong"}
                  </span>
                </div>
                <div className="pt-1 border-t border-white/[0.08] flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: hoveredHvn.bin.confidenceColor }}
                  />
                  <span className="font-semibold text-[10px]" style={{ color: hoveredHvn.bin.confidenceColor }}>
                    {hoveredHvn.bin.confidenceLabel}
                  </span>
                </div>
              </div>
            )}
            {!candles.length && (
              <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fog-2">
                Loading chart…
              </div>
            )}

            {/* Custom Chart Right-Click Context Menu */}
            {chartMenu && (
              <div
                style={{ left: chartMenu.x, top: chartMenu.y }}
                onClick={(e) => e.stopPropagation()}
                className="absolute z-30 w-48 rounded-xl border border-white/[0.12] bg-[#131417]/95 backdrop-blur-md p-1.5 shadow-2xl text-[12px]"
              >
                <button
                  type="button"
                  onClick={() => {
                    chartRef.current?.timeScale().fitContent();
                    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
                    setChartMenu(null);
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-snow hover:bg-white/[0.06]"
                >
                  Reset chart view
                </button>
                <button
                  type="button"
                  onClick={() => {
                    chartRef.current?.timeScale().scrollToRealTime();
                    setChartMenu(null);
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-snow hover:bg-white/[0.06]"
                >
                  Jump to latest
                </button>
                {chartMenu.price > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        const line = seriesRef.current?.createPriceLine({
                          price: chartMenu.price,
                          title: "LINE",
                          color: "#e6c97a",
                          lineStyle: LineStyle.Dashed,
                          lineWidth: 1,
                          lineVisible: true,
                          axisLabelVisible: true,
                        });
                        if (line) {
                          customLinesRef.current.push(line);
                          setCustomLinesCount(customLinesRef.current.length);
                        }
                      } catch {
                        /* ignore */
                      }
                      setChartMenu(null);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-mint hover:bg-white/[0.06] cw-num"
                  >
                    + Add line @ {fmtPrice(chartMenu.price)}
                  </button>
                )}
                {customLinesCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const l of customLinesRef.current) {
                        try {
                          seriesRef.current?.removePriceLine(l);
                        } catch {
                          /* ignore */
                        }
                      }
                      customLinesRef.current = [];
                      setCustomLinesCount(0);
                      setChartMenu(null);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-coral hover:bg-white/[0.06]"
                  >
                    Remove custom lines ({customLinesCount})
                  </button>
                )}
                <div className="my-1 border-t border-white/[0.06]" />
                <button
                  type="button"
                  onClick={() => {
                    setShowEntrySl((v) => !v);
                    setChartMenu(null);
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-fog hover:text-snow hover:bg-white/[0.06]"
                >
                  {showEntrySl ? "Hide Entry / SL lines" : "Show Entry / SL lines"}
                </button>
              </div>
            )}
          </div>

          {/* Order Book Side Panel (full height, zero scroll) */}
          <div className="rounded-xl border border-white/[0.06] bg-[#0b0c0f] flex flex-col h-[600px] overflow-hidden">
            <div className="px-3 py-2.5 border-b border-white/[0.05] flex items-center justify-between gap-2 shrink-0">
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

            <div className="grid grid-cols-3 px-2.5 py-1.5 text-[10px] text-fog-2 border-b border-white/[0.05] shrink-0">
              <span>Price</span>
              <span className="text-right">Size</span>
              <span className="text-right">Value</span>
            </div>

            <div className="flex-1 overflow-hidden cw-num text-[11px] flex flex-col justify-between">
              <div>
                {dom.asks.slice(-10).map((a) => (
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

              <div className="px-2.5 py-1.5 border-y border-white/[0.06] bg-white/[0.02] flex items-center justify-between shrink-0">
                <span className="text-[13px] font-semibold text-mint">{fmtPrice(lastPrice)}</span>
                <span className="text-[10px] text-fog-2">MID</span>
              </div>

              <div>
                {dom.bids.slice(0, 10).map((b) => (
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
