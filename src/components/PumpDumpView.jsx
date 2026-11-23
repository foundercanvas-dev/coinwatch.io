import React, { useEffect, useMemo, useState } from "react";
import {
  MagnifyingGlass,
  Trash,
  Broadcast,
  Stack,
  Waveform,
  Clock,
  Crosshair,
  TrendUp,
  TrendDown,
  ChartLineUp,
} from "@phosphor-icons/react";
import SignalCard from "./SignalCard";
import { PageHeader, StatCard, Segmented, LivePill, Metric } from "./ui";
import useLocalStorage from "../lib/useLocalStorage";
import { baseAsset } from "./CoinIcon";
import { LIQUIDITY_TIERS, SENSITIVITY_POLICY, TIMEFRAME_MINUTES } from "../lib/signalPolicy";

const BASE_PRESETS = SENSITIVITY_POLICY.base_presets_pct;
const TF_MINUTES = TIMEFRAME_MINUTES;

const TIMEFRAMES = [
  { id: "1m", label: "1M", title: "Scalp" },
  { id: "5m", label: "5M", title: "Momentum" },
  { id: "15m", label: "15M", title: "Intraday" },
  { id: "1h", label: "1H", title: "Swing" },
  { id: "4h", label: "4H", title: "Macro" },
];

const signalKey = (signal) => `${signal.exchange}:${signal.symbol}`;

/** The strongest absolute mover in a list. */
function topMoverId(list) {
  let best = null;
  for (const s of list) {
    if (!best || Math.abs(s.change_pct || 0) > Math.abs(best.change_pct || 0)) best = s;
  }
  return best?.id ?? null;
}

export default function PumpDumpView({
  sensitivity,
  setSensitivity,
  timeframe = "1m",
  setTimeframe,
  stats,
  liveSignals,
  historySignals,
  selectedCoin,
  onSelectCoin,
  onOpenPOA,
  isConnected,
  historyClearedAt = 0,
  onClearHistory,
  sourceLabel,
  minLiquidity = 0,
  setMinLiquidity,
  marketRows = [],
}) {
  const [tab, setTab] = useState("live");
  const [query, setQuery] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [sideFilter, setSideFilter] = useState("all");
  const [minScore, setMinScore] = useState(0);
  const [sortBy, setSortBy] = useState("score");
  const [pins, setPins] = useLocalStorage("cw.signal.pins", []);
  const [mutes, setMutes] = useLocalStorage("cw.signal.mutes", []);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const visibleHistory = useMemo(
    () =>
      historySignals.filter((s) => !historyClearedAt || (s.raw_ts || 0) * 1000 > historyClearedAt),
    [historySignals, historyClearedAt],
  );

  const applyFilters = (source) => {
    const q = query
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const fromMs = timeFrom ? new Date(timeFrom).getTime() : 0;
    return source
      .filter((s) => {
        if (
          q &&
          !String(s.symbol || "")
            .toUpperCase()
            .includes(q)
        )
          return false;
        if (fromMs && (s.raw_ts || 0) * 1000 < fromMs) return false;
        if (minLiquidity > 0 && Number(s.turnover_24h_usd || 0) < minLiquidity) return false;
        if (sideFilter === "long" && s.type !== "PUMP") return false;
        if (sideFilter === "short" && s.type !== "DUMP") return false;
        if (Number(s.score || 0) < minScore) return false;
        if (mutes.includes(signalKey(s))) return false;
        return true;
      })
      .sort((left, right) => {
        const pinDelta =
          Number(pins.includes(signalKey(right))) - Number(pins.includes(signalKey(left)));
        if (pinDelta) return pinDelta;
        if (sortBy === "volume")
          return Number(right.turnover_24h_usd || 0) - Number(left.turnover_24h_usd || 0);
        if (sortBy === "move")
          return Math.abs(right.change_pct || 0) - Math.abs(left.change_pct || 0);
        return Number(right.score || 0) - Number(left.score || 0);
      });
  };
  const filteredLive = useMemo(
    () => applyFilters(liveSignals),
    [liveSignals, query, timeFrom, minLiquidity, sideFilter, minScore, sortBy, pins, mutes],
  );
  const filteredHistory = useMemo(
    () => applyFilters(visibleHistory),
    [visibleHistory, query, timeFrom, minLiquidity, sideFilter, minScore, sortBy, pins, mutes],
  );
  const source = tab === "live" ? liveSignals : visibleHistory;
  const filtered = tab === "live" ? filteredLive : filteredHistory;

  const hotId = topMoverId(filtered);
  const tf = TIMEFRAMES.find((t) => t.id === timeframe) || TIMEFRAMES[0];
  const thresholdScale = Math.sqrt(TF_MINUTES[timeframe] || 1);
  const presets = BASE_PRESETS.map((value) =>
    Math.min(SENSITIVITY_POLICY.max_pct, Number((value * thresholdScale).toFixed(1))),
  ).filter((value, index, values) => values.indexOf(value) === index);
  const maxSensitivity = SENSITIVITY_POLICY.max_pct;
  const selectTimeframe = (next) => {
    const currentMinutes = TF_MINUTES[timeframe] || 1;
    const nextMinutes = TF_MINUTES[next] || 1;
    setSensitivity(
      Math.min(
        maxSensitivity,
        Math.max(
          SENSITIVITY_POLICY.min_pct,
          Number((sensitivity * Math.sqrt(nextMinutes / currentMinutes)).toFixed(1)),
        ),
      ),
    );
    setTimeframe(next);
  };
  const historyWins = filteredHistory.filter(
    (signal) => signal.lifecycle_status === "target_hit",
  ).length;
  const historyLosses = filteredHistory.filter(
    (signal) => signal.lifecycle_status === "stopped",
  ).length;
  const decided = historyWins + historyLosses;
  const confirmedCount = filteredLive.filter(
    (signal) => signal.lifecycle_status === "confirmed",
  ).length;
  const btc = [...marketRows]
    .filter((row) => baseAsset(row.symbol) === "BTC")
    .sort((left, right) => Number(right.volume_24h_usd || 0) - Number(left.volume_24h_usd || 0))[0];
  const breadthRows = marketRows.filter((row) => Number(row.volume_24h_usd || 0) >= minLiquidity);
  const breadth = breadthRows.length
    ? (breadthRows.filter((row) => Number(row.price_change_1h || 0) > 0).length /
        breadthRows.length) *
      100
    : null;
  const liveClock = new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Live scanner"
        eyebrowIcon={ChartLineUp}
        title="Pump / Dump"
        description="Choose a timeframe to match your trade: lower timeframes surface quick in-and-out setups, while higher timeframes use wider targets and progressively higher reward-to-risk."
        actions={<LivePill isConnected={isConnected} label={sourceLabel} />}
      />

      {/* Controls */}
      <section className="cw-panel cw-glow p-4 md:p-5 space-y-4">
        <div className="grid gap-4 @4xl:grid-cols-[180px_90px_1fr] items-center">
          <div className="text-[14px] font-medium text-snow">Sensitivity</div>
          <div className="cw-num text-[26px] font-semibold text-mint @4xl:text-right">
            {sensitivity.toFixed(1)}%
          </div>
          <div className="space-y-3 min-w-0">
            <input
              type="range"
              min={SENSITIVITY_POLICY.min_pct}
              max={maxSensitivity}
              step="0.5"
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              className="w-full h-1 cursor-pointer"
              aria-label="Sensitivity threshold"
            />
            <div className="flex flex-wrap gap-1.5">
              {presets.map((v) => (
                <button
                  key={v}
                  onClick={() => setSensitivity(v)}
                  className={`cw-num h-7 px-2.5 rounded-full border text-[11px] transition-colors ${
                    sensitivity === v
                      ? "border-mint/45 bg-mint/10 text-mint"
                      : "border-white/[0.08] text-fog hover:text-snow hover:border-white/20"
                  }`}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="h-px bg-white/[0.05]" />
        <div className="grid gap-3 @4xl:grid-cols-[270px_1fr] items-center">
          <div className="text-[14px] font-medium text-snow">Timeframe</div>
          <div className="flex flex-wrap gap-1.5">
            {TIMEFRAMES.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTimeframe(t.id)}
                className={`h-7 px-3 rounded-full border text-[11px] transition-colors inline-flex items-center gap-1.5 ${
                  timeframe === t.id
                    ? "border-mint/45 bg-mint/10 text-mint"
                    : "border-white/[0.08] text-fog hover:text-snow hover:border-white/20"
                }`}
              >
                <span className="cw-num font-medium">{t.label}</span>
                <span className="opacity-70">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-6 gap-3">
        <StatCard
          icon={Stack}
          label="Monitored pairs"
          value={Number(stats.monitored || 1436).toLocaleString()}
          caption={`${stats.crossing_now ?? 0} active moves`}
        />
        <StatCard
          icon={Waveform}
          label="Data health"
          value={stats.stream_batches ? `${stats.stream_batches} feeds` : "Live stream"}
          caption={`${stats.latency_ms ?? "—"}ms latency`}
        />
        <StatCard
          icon={Clock}
          label="Last event"
          value={liveClock}
          caption={stats.last_event ? `Signal: ${stats.last_event}` : "System time"}
        />
        <StatCard icon={Crosshair} label="Confirmed" value={confirmedCount} highlight />
        <StatCard
          icon={TrendUp}
          label="Pumps"
          value={filteredLive.filter((signal) => signal.type === "PUMP").length}
          tone="up"
        />
        <StatCard
          icon={TrendDown}
          label="Dumps"
          value={filteredLive.filter((signal) => signal.type === "DUMP").length}
          tone="down"
        />
      </section>

      <section className="cw-panel grid grid-cols-2 divide-white/[0.06] @4xl:grid-cols-4 @4xl:divide-x">
        <div className="px-4 py-3">
          <Metric
            label="BTC 1h"
            value={btc ? `${Number(btc.price_change_1h || 0).toFixed(2)}%` : "—"}
            tone={Number(btc?.price_change_1h || 0) >= 0 ? "up" : "down"}
          />
        </div>
        <div className="px-4 py-3">
          <Metric
            label="BTC 24h"
            value={btc ? `${Number(btc.price_change_24h || 0).toFixed(2)}%` : "—"}
            tone={Number(btc?.price_change_24h || 0) >= 0 ? "up" : "down"}
          />
        </div>
        <div className="px-4 py-3">
          <Metric
            label="Market breadth"
            value={breadth == null ? "—" : `${breadth.toFixed(0)}% up`}
            tone={breadth == null ? "muted" : breadth >= 50 ? "up" : "down"}
          />
        </div>
        <div className="px-4 py-3">
          <Metric
            label="Context"
            value={
              breadth == null
                ? "Collecting"
                : breadth >= 65
                  ? "Market-wide up"
                  : breadth <= 35
                    ? "Market-wide down"
                    : "Selective"
            }
            tone="accent"
          />
        </div>
      </section>

      {/* Signals */}
      <section className="cw-panel p-3 md:p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "live", label: "Live", badge: liveSignals.length },
              { value: "history", label: "History", badge: visibleHistory.length },
            ]}
          />
          {tab === "history" && (
            <button
              onClick={onClearHistory}
              disabled={visibleHistory.length === 0}
              className="cw-btn !h-8 !text-[12px] disabled:opacity-40 disabled:pointer-events-none"
            >
              <Trash weight="duotone" className="w-4 h-4" />
              Clear history
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative flex-1 min-w-[200px]">
            <MagnifyingGlass
              weight="bold"
              className="w-4 h-4 text-fog-2 absolute left-3 top-1/2 -translate-y-1/2"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search coin"
              className="cw-input !rounded-lg !py-2 pl-9 placeholder:text-fog-2"
              aria-label="Filter signals by coin name"
            />
          </label>
          <select
            value={sideFilter}
            onChange={(event) => setSideFilter(event.target.value)}
            className="cw-input !w-auto !rounded-lg !py-2"
            aria-label="Filter by side"
          >
            <option value="all">All sides</option>
            <option value="long">Pumps</option>
            <option value="short">Dumps</option>
          </select>
          <select
            value={minScore}
            onChange={(event) => setMinScore(Number(event.target.value))}
            className="cw-input !w-auto !rounded-lg !py-2"
            aria-label="Minimum score"
          >
            <option value="0">Any score</option>
            <option value="50">Score 50+</option>
            <option value="70">Score 70+</option>
          </select>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value)}
            className="cw-input !w-auto !rounded-lg !py-2"
            aria-label="Sort signals"
          >
            <option value="score">Sort: score</option>
            <option value="volume">Sort: liquidity</option>
            <option value="move">Sort: move</option>
          </select>
          {mutes.length > 0 && (
            <button type="button" onClick={() => setMutes([])} className="cw-btn !h-9 !text-[11px]">
              Unmute {mutes.length}
            </button>
          )}
          {tab === "history" && (
            <label className="flex items-center gap-2 cw-input !w-auto !rounded-lg !py-1.5 min-w-[250px]">
              <span className="text-[11px] text-fog-2 shrink-0">From</span>
              <input
                type="datetime-local"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
                className="bg-transparent outline-none text-[12px] text-snow/90 cw-num flex-1"
                aria-label="Show signals from this time"
              />
            </label>
          )}
          <span className="cw-num text-[11px] text-fog-2 ml-auto">
            {filtered.length} / {source.length} signals
          </span>
        </div>

        {tab === "history" && (
          <div className="grid grid-cols-2 gap-2 @4xl:grid-cols-4">
            {[
              ["Wins", historyWins, "text-mint"],
              ["Losses", historyLosses, "text-coral"],
              [
                "Win rate",
                decided ? `${((historyWins / decided) * 100).toFixed(1)}%` : "—",
                "text-snow",
              ],
              ["Sample", decided, decided >= 30 ? "text-mint" : "text-terminal-yellow"],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-lg border border-white/[0.06] px-3 py-2">
                <div className="text-[10px] text-fog-2">{label}</div>
                <div className={`cw-num mt-0.5 text-sm font-semibold ${tone}`}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <div className="cw-disc mx-auto w-12 h-12 text-mint">
              <Broadcast weight="duotone" className="w-6 h-6" />
            </div>
            <div className="mt-4 text-[14px] font-medium text-snow">
              {tab === "live"
                ? `Scanning for ${tf.label} moves above ${sensitivity}%`
                : source.length
                  ? "No signals match these filters"
                  : "History is empty"}
            </div>
            <p className="mt-1.5 text-[12px] text-fog-2 max-w-sm mx-auto">
              {tab === "live"
                ? "Streaming live from Hyperliquid, Binance and Bybit. New moves appear here the moment they cross your threshold."
                : "Finalized signals are saved here once their candle window closes."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
            {filtered.map((s, i) => (
              <SignalCard
                key={s.id ?? `${s.exchange}-${s.symbol}-${s.raw_ts}`}
                signal={s}
                index={i}
                view={tab}
                hot={hotId != null && s.id === hotId}
                selected={
                  selectedCoin &&
                  selectedCoin.symbol === s.symbol &&
                  selectedCoin.exchange === s.exchange
                }
                onSelect={onSelectCoin}
                onOpenPOA={onOpenPOA}
                pinned={pins.includes(signalKey(s))}
                onPin={(signal) => {
                  const key = signalKey(signal);
                  setPins((current) =>
                    current.includes(key)
                      ? current.filter((item) => item !== key)
                      : [...current, key],
                  );
                }}
                onMute={(signal) => {
                  const key = signalKey(signal);
                  setMutes((current) => (current.includes(key) ? current : [...current, key]));
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
