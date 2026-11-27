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
  MagnifyingGlass,
  X,
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
import {
  buildHighConfidenceZones,
  getLookbackForTimeframe,
  getSignalState,
  refreshZonesOnDomUpdate,
} from "../lib/orderflowLogic";
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
const OF_FRESH_MS = 10_000;
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
  const [searchQuery, setSearchQuery] = useState("");
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
    const timer = setInterval(() => scanMarkets(true), 12000);
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
  const normSearch = searchQuery.trim().toLowerCase();
  const visibleSignals = sourceList.filter(
    (s) =>
      (sideFilter === "all" || s.side === sideFilter.toUpperCase()) &&
      (!normSearch || s.symbol.toLowerCase().includes(normSearch)),
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
                className={`cw-btn !h-9 !px-3 gap-2.5 ${popupsEnabled ? "!border-mint/30 !bg-mint/[0.06] !text-snow" : "!text-fog"
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
                  className={`relative w-7 h-4 rounded-full transition-colors ${popupsEnabled ? "bg-mint" : "bg-white/10"
                    }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${popupsEnabled ? "left-3.5 bg-ink" : "left-0.5 bg-fog"
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
            <div className="relative flex items-center">
              <MagnifyingGlass
                weight="bold"
                className="pointer-events-none absolute left-2.5 w-3.5 h-3.5 text-fog-2"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search coin…"
                aria-label="Search coin"
                className="h-8 w-36 sm:w-44 rounded-lg border border-white/[0.08] bg-white/[0.03] pl-8 pr-7 text-[12px] text-snow placeholder:text-fog-2 focus:border-mint/40 focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 text-fog-2 hover:text-snow"
                >
                  <X weight="bold" className="w-3 h-3" />
                </button>
              )}
            </div>
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
                className={`cw-card cw-hover cw-press text-left p-4 space-y-3 ${spanFull ? "col-span-full" : ""
                  } ${isNew
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
                            className={`px-2 py-0.5 rounded-md text-[11px] font-bold cw-num border ${sig.tier === "A+"
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
                      {sig.status === "CONFIRMING" ? (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-terminal-yellow/15 border border-terminal-yellow/35 text-terminal-yellow cw-num">
                          CONFIRMING · {formatCountdown(Math.max(0, (IV_SEC[sig.timeframe] || 300) - ageSec))}
                        </span>
                      ) : isNew ? (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-mint/15 border border-mint/30 text-mint cw-num">
                          CONFIRMED · {formatCountdown(remSec)}
                        </span>
                      ) : null}
                      {(sig.stoppedOut || sig.reversed || sig.expired) && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/[0.06] text-fog">
                          {sig.reversed ? "Reversed" : sig.stoppedOut ? "Stopped out" : "Expired"}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${isLong
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
                      className={`h-full transition-[width] duration-1000 ${isLong ? "bg-mint" : "bg-coral"
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
              ) : scanning ? (
                <div className="w-full grid gap-3 @3xl:grid-cols-2 text-left">
                  {[0, 1, 2, 3].map((idx) => (
                    <div
                      key={`skel-${idx}`}
                      className="cw-card p-4 space-y-3 animate-pulse"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-white/[0.06]" />
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <div className="h-3.5 w-24 rounded bg-white/[0.08]" />
                              <div className="h-4 w-8 rounded bg-white/[0.06]" />
                            </div>
                            <div className="h-2.5 w-16 rounded bg-white/[0.05]" />
                          </div>
                        </div>
                        <div className="space-y-1.5 flex flex-col items-end">
                          <div className="h-5 w-16 rounded-full bg-white/[0.07]" />
                          <div className="h-3 w-12 rounded bg-white/[0.05]" />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 pt-1">
                        <div className="space-y-1">
                          <div className="h-2.5 w-10 rounded bg-white/[0.05]" />
                          <div className="h-3.5 w-14 rounded bg-white/[0.07]" />
                        </div>
                        <div className="space-y-1">
                          <div className="h-2.5 w-10 rounded bg-white/[0.05]" />
                          <div className="h-3.5 w-14 rounded bg-white/[0.07]" />
                        </div>
                        <div className="space-y-1 flex flex-col items-end">
                          <div className="h-2.5 w-10 rounded bg-white/[0.05]" />
                          <div className="h-3.5 w-16 rounded bg-white/[0.07]" />
                        </div>
                      </div>
                      <div className="h-1 w-full rounded-full bg-white/[0.06]" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-fog-2 py-2">
                  {tab === "history"
                    ? "No closed or expired setups in history yet."
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
  const dayCandlesRef = useRef([]);
  const zonesRef = useRef([]);
  const signalStateRef = useRef({ state: "WAITING", message: "Loading high-confidence zones…", zone: null });
  const domRef = useRef({ asks: [], bids: [], avgSize: 0 });
  const hvnHitboxesRef = useRef([]);
  const tfSetupRef = useRef(signal);
  const wallTrackerRef = useRef(new Map());
  const seededRef = useRef(false);
  const [hoveredHvn, setHoveredHvn] = useState(null);
  const [signalState, setSignalState] = useState({
    state: "WAITING",
    message: "Loading high-confidence zones…",
    zone: null,
  });
  const [visibleZones, setVisibleZones] = useState([]);

  const zonesLockedForRef = useRef("");

  const updateHvnState = useCallback((candleList, currentDom = null, lockKey = null) => {
    const profileSource = dayCandlesRef.current.length >= 25 ? dayCandlesRef.current : candleList;
    const hvn = computeHvnProfile(profileSource, 50);
    const hvnsWithReaction = hvn ? computeHvnReactionHistory(profileSource, hvn) : [];
    const maxVol = hvn?.bins?.length ? Math.max(...hvn.bins.map((b) => b.volume)) : 0;
    hvnDataRef.current = {
      bins: hvn?.bins || [],
      hvnsWithReaction,
      poc: hvn?.poc || null,
      maxVol,
    };

    const curPx = candleList?.length ? candleList[candleList.length - 1].close : 0;
    // Keep historical HVN zones FIXED once computed for this symbol+timeframe so they never jump around
    let zones = zonesRef.current;
    if (!zones.length || (lockKey && zonesLockedForRef.current !== lockKey)) {
      zones = buildHighConfidenceZones(profileSource, currentDom || domRef.current, curPx, "15m");
      zonesRef.current = zones;
      setVisibleZones(zones);
      if (lockKey) zonesLockedForRef.current = lockKey;
    }

    const nextState = getSignalState(candleList, zones, currentDom || domRef.current, curPx);
    signalStateRef.current = nextState;
    setSignalState(nextState);
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

    const ts = chart.timeScale();
    const curList = candlesRef.current;
    const lastBarTime = curList.length ? curList[curList.length - 1].time : null;
    const xLastRaw = lastBarTime != null ? ts.timeToCoordinate(lastBarTime) : null;
    const drawEndX =
      xLastRaw != null && Number.isFinite(xLastRaw)
        ? Math.max(width * 0.55, Math.min(width - 78, xLastRaw + 125))
        : Math.max(0, width - 84);

    // 1. Clean HVN Zones (Support / Resistance / POC) from historical data with exact "Volume | %" text
    const zones = zonesRef.current || [];
    const hitboxes = [];
    if (hvnCanvas) {
      if (hvnCanvas.width !== Math.floor(width * dpr) || hvnCanvas.height !== Math.floor(height * dpr)) {
        hvnCanvas.width = Math.floor(width * dpr);
        hvnCanvas.height = Math.floor(height * dpr);
      }
      const hctx = hvnCanvas.getContext("2d");
      hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hctx.clearRect(0, 0, width, height);

      for (const z of zones) {
        const yTop = series.priceToCoordinate(z.high);
        const yBot = series.priceToCoordinate(z.low);
        const yMid = series.priceToCoordinate(z.price);
        if (yMid == null || !Number.isFinite(yMid)) continue;

        // Accurate height from actual z.low..z.high price range (clamped for readability)
        const rawH =
          yTop != null && yBot != null && Number.isFinite(yTop) && Number.isFinite(yBot)
            ? Math.abs(yBot - yTop)
            : 14;
        const barH = Math.max(10, Math.min(28, Math.round(rawH)));
        const yDraw = Math.round(yMid - barH / 2);
        hitboxes.push({ yMin: yDraw - 4, yMax: yDraw + barH + 4, xMax: drawEndX, bin: z });

        const isPoc = Boolean(z.isPoc);
        const isSup = z.side === "SUPPORT" && !isPoc;
        hctx.save();
        // Intuitive colors: Green = Support (Buy), Red = Resistance (Sell), Gold = POC (Key Level)
        hctx.fillStyle = isPoc
          ? "rgba(185, 138, 47, 0.18)"
          : isSup
            ? "rgba(46, 189, 133, 0.13)"
            : "rgba(246, 70, 93, 0.13)";
        hctx.fillRect(0, yDraw, drawEndX, barH);
        hctx.strokeStyle = isPoc
          ? "rgba(185, 138, 47, 0.35)"
          : isSup
            ? "rgba(46, 189, 133, 0.28)"
            : "rgba(246, 70, 93, 0.28)";
        hctx.lineWidth = 0.75;
        hctx.beginPath();
        hctx.moveTo(0, yMid);
        hctx.lineTo(drawEndX, yMid);
        hctx.stroke();
        hctx.restore();

        // Subtle, easy-to-read label at low opacity so candles stay crisp
        const tag = isPoc ? "POC" : isSup ? "SUP" : "RES";
        const domBuy = z.buyersPct >= z.sellersPct;
        const domPct = domBuy ? z.buyersPct : z.sellersPct;
        const volText = `${tag} · ${z.volumeLabel || formatCompactNum(z.volume)} `;
        const pctText = `| ${domPct}%`;

        ctx.save();
        ctx.globalAlpha = 0.52;
        ctx.font = '600 10.5px "Funnel Display", sans-serif';
        const volW = ctx.measureText(volText).width;
        const pctW = ctx.measureText(pctText).width;
        const startX = Math.max(8, drawEndX - volW - pctW - 8);

        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#EAECEF";
        ctx.fillText(volText, startX, yMid);

        ctx.fillStyle = domBuy ? "#7ee6a3" : "#f2707c";
        ctx.fillText(pctText, startX + volW, yMid);
        ctx.restore();
      }
    }
    hvnHitboxesRef.current = hitboxes;

    // 2. Clean Absorption Circles (matching reference: number only inside translucent green/red circle)
    const st = signalStateRef.current;
    const absCircles = [];
    const seenCircleKeys = new Set();

    if (st?.absorption?.confirmed && st.absorption.candle) {
      absCircles.push({
        time: st.absorption.candle.time,
        price: st.zone?.price || st.absorption.candle.close,
        side: st.zone?.side === "SUPPORT" ? "LONG" : "SHORT",
        absorbedVol: st.absorption.absorbedVol,
        isCurrent: true,
      });
      seenCircleKeys.add(st.absorption.candle.time);
    }

    for (const sig of absorptionsRef.current) {
      if (seenCircleKeys.has(sig.time)) continue;
      absCircles.push({
        time: sig.time,
        price: sig.price,
        side: sig.side,
        absorbedVol: sig.absorbedVol,
        isCurrent: Boolean(
          tfSetupRef.current && sig.time === tfSetupRef.current.time && sig.side === tfSetupRef.current.side,
        ),
      });
    }

    for (const c of absCircles) {
      const x = ts.timeToCoordinate(c.time);
      const y = series.priceToCoordinate(c.price);
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;

      const isLong = c.side === "LONG";
      const radius = c.isCurrent ? 18 : 14;

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isLong ? "rgba(126, 230, 163, 0.14)" : "rgba(242, 112, 124, 0.14)";
      ctx.fill();
      ctx.lineWidth = c.isCurrent ? 1.5 : 1;
      ctx.strokeStyle = isLong ? "rgba(126, 230, 163, 0.78)" : "rgba(242, 112, 124, 0.78)";
      ctx.stroke();

      ctx.fillStyle = "#f1f3f1";
      ctx.font = c.isCurrent
        ? '700 10.5px "Funnel Display", sans-serif'
        : '600 9.5px "Funnel Display", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(formatCompactNum(c.absorbedVol), x, y);
      ctx.restore();
    }
  }, []);

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
        barSpacing: 8,
        rightOffset: 24,
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
        const lookbackLimit = getLookbackForTimeframe(chartIv);
        const fetchKlinesSafe = async () => {
          for (const url of [
            `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${chartIv}&limit=${lookbackLimit}`,
            `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${chartIv}&limit=${lookbackLimit}`,
          ]) {
            try {
              const r = await fetch(url);
              if (r.ok) {
                const rows = await r.json();
                if (Array.isArray(rows) && rows.length) return rows;
              }
            } catch {
              /* try next */
            }
          }
          for (const snapUrl of [
            `/api/orderflow/snapshot?timeframe=${encodeURIComponent(chartIv)}`,
            `https://coinwatch-io.onrender.com/api/orderflow/snapshot?timeframe=${encodeURIComponent(chartIv)}`,
          ]) {
            try {
              const r = await fetch(snapUrl);
              if (r.ok) {
                const json = await r.json();
                const rows = json?.klines?.[`${sym}:${chartIv}`];
                if (Array.isArray(rows) && rows.length) return rows;
              }
            } catch {
              /* try next */
            }
          }
          return null;
        };
        const fetchDepthSafe = async () => {
          for (const url of [
            `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=100`,
            `https://api.binance.com/api/v3/depth?symbol=${sym}&limit=100`,
          ]) {
            try {
              const r = await fetch(url);
              if (r.ok) {
                const d = await r.json();
                if (d?.bids && d?.asks) return d;
              }
            } catch {
              /* try next */
            }
          }
          return null;
        };
        const fetchDayKlinesSafe = async () => {
          for (const url of [
            `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=240`,
            `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=240`,
          ]) {
            try {
              const r = await fetch(url);
              if (r.ok) {
                const rows = await r.json();
                if (Array.isArray(rows) && rows.length) return rows;
              }
            } catch {
              /* try next */
            }
          }
          return null;
        };
        const [klineRes, depthRes, dayRes] = await Promise.allSettled([
          fetchKlinesSafe(),
          fetchDepthSafe(),
          fetchDayKlinesSafe(),
        ]);
        if (!alive) return;
        const klineRows = klineRes.status === "fulfilled" ? klineRes.value : null;
        const depthData = depthRes.status === "fulfilled" ? depthRes.value : null;
        const dayRows = dayRes.status === "fulfilled" ? dayRes.value : null;
        if (Array.isArray(dayRows) && dayRows.length) {
          dayCandlesRef.current = parseBinanceKlines(dayRows);
        }
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
        let parsedDom = null;
        if (depthData?.bids) {
          parsedDom = analyzeDomHeatmap(
            depthData.bids,
            depthData.asks,
            wallTrackerRef.current,
            Date.now(),
            parsed[parsed.length - 1]?.close || signal.price,
          );
          domRef.current = parsedDom;
          setDom(parsedDom);
        }
        const hvn = updateHvnState(parsed, parsedDom, `${sym}:${chartIv}`);
        const allAbs = detectAbsorptionSignals(parsed, sym, hvn, { includeStopped: true, includeLive: true });
        const list = [...allAbs];
        if (chartIv === signal.timeframe && !list.some((s) => s.time === signal.time && s.side === signal.side)) {
          list.unshift(signal);
        }
        absorptionsRef.current = list;
        setAbsorptions(list);
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
            domRef.current = analyzed;
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

  const stoppedLatchRef = useRef(new Set());
  // Check if SL was hit (either on load or live) and latch closed so it never flickers back open
  const isStoppedOut = useMemo(() => {
    if (!tfSetup) return false;
    const key = `${tfSetup.symbol}:${tfSetup.timeframe}:${tfSetup.time}`;
    if (stoppedLatchRef.current.has(key)) return true;
    if (tfSetup.stoppedOut) {
      stoppedLatchRef.current.add(key);
      return true;
    }
    if (!candles.length) return false;
    const stopPrice = tradePlan?.stop || (tfSetup.side === "SHORT" ? tfSetup.high : tfSetup.low);
    if (!(stopPrice > 0)) return false;
    if (lastPrice > 0) {
      if ((tfSetup.side === "LONG" && lastPrice <= stopPrice) || (tfSetup.side === "SHORT" && lastPrice >= stopPrice)) {
        stoppedLatchRef.current.add(key);
        return true;
      }
    }
    for (const c of candles) {
      if (c.time <= tfSetup.time) continue;
      if ((tfSetup.side === "LONG" && c.low <= stopPrice) || (tfSetup.side === "SHORT" && c.high >= stopPrice)) {
        stoppedLatchRef.current.add(key);
        return true;
      }
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

  const lockedEntrySlRef = useRef({ key: "", entry: 0, sl: 0 });

  // Plot ENTRY / SL lines on the chart (locked per setup so they never drift on ticks) + redraw circles
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
    if (tfSetup && tfSetup.status !== "CONFIRMING" && !setupClosed && showEntrySl) {
      const lockKey = `${tfSetup.symbol}:${chartIv}:${tfSetup.time}:${tfSetup.side}`;
      let entryPrice = lockedEntrySlRef.current.entry;
      let stopPrice = lockedEntrySlRef.current.sl;
      if (lockedEntrySlRef.current.key !== lockKey || !(entryPrice > 0)) {
        entryPrice =
          tradePlan?.entry ||
          calculateSmartEntry({
            triggerClose: tfSetup.triggerClose || tfSetup.price,
            open: tfSetup.open,
            high: tfSetup.high,
            low: tfSetup.low,
            side: tfSetup.side,
            atrAbs: tfAtr14,
            currentPrice: tfSetup.price,
            entryMode: risk?.entryMode || "retest",
          });
        stopPrice =
          tradePlan?.stop || (tfSetup.side === "SHORT" ? tfSetup.high : tfSetup.low);
        lockedEntrySlRef.current = { key: lockKey, entry: entryPrice, sl: stopPrice };
      }
      const specs = [
        ["ENTRY", entryPrice, "#7ee6a3", LineStyle.Solid],
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
  }, [tfSetup, chartIv, tradePlan, tfAtr14, risk?.entryMode, setupClosed, showEntrySl, absorptions, drawAbsorptionCircles]);

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
            {tfSetup && (
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  tfSetup.status === "CONFIRMING"
                    ? "bg-terminal-yellow/15 text-terminal-yellow"
                    : isLong
                      ? "bg-mint/15 text-mint"
                      : "bg-coral/15 text-coral"
                }`}
              >
                {tfSetup.status === "CONFIRMING"
                  ? "CONFIRMING ABSORPTION"
                  : `CONFIRMED ${tfSetup.side}`}
              </span>
            )}
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
            className={`fixed top-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2rem)] cw-panel cw-glow p-4 shadow-2xl overflow-hidden space-y-3 cw-toast-in ${reversalSignal
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
            {/* Simple color key so users immediately understand zone & circle colors */}
            <div className="pointer-events-none absolute top-2.5 left-3 z-10 flex flex-wrap items-center gap-3 rounded-md bg-[#0b0c0f]/75 px-2.5 py-1 text-[10px] text-fog-2 border border-white/[0.05]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-[#2EBD85]/70" /> Support (Buy Zone)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-[#F6465D]/70" /> Resistance (Sell Zone)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-[#B98A2F]/80" /> POC (Key Volume)
              </span>
            </div>
            {hoveredHvn && (
              <div
                style={{ left: hoveredHvn.x, top: hoveredHvn.y }}
                className="pointer-events-none absolute z-20 w-56 rounded-lg border border-white/[0.14] bg-[#0b0c0f]/95 backdrop-blur-md px-3 py-2 shadow-2xl text-[11px] space-y-1 cw-num"
              >
                <div className="flex items-center justify-between text-fog-2">
                  <span>Zone Price</span>
                  <span className="font-semibold text-snow">{fmtPrice(hoveredHvn.bin.price)}</span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Volume / X</span>
                  <span className="font-semibold text-[#FFD700]">
                    {hoveredHvn.bin.volumeLabel} ({hoveredHvn.bin.xMultiplier}x)
                  </span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Score</span>
                  <span className="font-semibold text-snow">
                    {hoveredHvn.bin.score}/100 · {hoveredHvn.bin.confidenceLabel}
                  </span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Last Tap Flow</span>
                  <span className="font-semibold text-snow">
                    Buyers {hoveredHvn.bin.buyersPct}% vs Sellers {hoveredHvn.bin.sellersPct}%
                  </span>
                </div>
                <div className="flex items-center justify-between text-fog-2">
                  <span>Reactions</span>
                  <span className="font-semibold text-snow">
                    {hoveredHvn.bin.reactions}/{hoveredHvn.bin.touches} ({hoveredHvn.bin.reactionRate}%)
                  </span>
                </div>
                {hoveredHvn.bin.depthRatio > 0 && (
                  <div className="flex items-center justify-between text-fog-2">
                    <span>DOM Depth</span>
                    <span className="font-semibold text-mint">{hoveredHvn.bin.depthRatio}x avg</span>
                  </div>
                )}
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

          {/* MBO DOM Order Book Side Panel */}
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
