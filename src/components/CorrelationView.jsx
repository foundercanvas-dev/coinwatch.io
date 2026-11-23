import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleNotch,
  LinkSimple,
  ShareNetwork,
  Stack,
  Timer,
  WarningCircle,
} from "@phosphor-icons/react";
import CoinIcon, { baseAsset } from "./CoinIcon";
import { exchangeName } from "./ExchangeLogo";
import { PageHeader, Segmented, StatCard } from "./ui";
import { fetchKlines } from "../lib/marketStream";
import {
  analyzeAnchorRelationships,
  CORRELATION_DEFAULTS,
  marketFactor,
} from "../lib/correlationEngine";
import { fmtUsd } from "../lib/format";

const CATEGORY_GROUPS = [
  {
    value: "majors",
    label: "Majors",
    coins: ["BTC", "ETH", "SOL", "BNB", "XRP"],
  },
  {
    value: "layer-1",
    label: "Layer 1",
    coins: ["ADA", "AVAX", "SUI", "APT", "NEAR", "TON"],
  },
  {
    value: "layer-2",
    label: "Layer 2",
    coins: ["ARB", "OP", "POL", "STRK", "MANTA"],
  },
  {
    value: "defi",
    label: "DeFi",
    coins: ["LINK", "UNI", "AAVE", "MKR", "LDO", "PENDLE"],
  },
  {
    value: "meme",
    label: "Meme",
    coins: ["DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI"],
  },
  {
    value: "ai",
    label: "AI",
    coins: ["TAO", "FET", "RENDER", "WLD", "ARKM"],
  },
  {
    value: "rwa",
    label: "RWA",
    coins: ["ONDO", "ENA", "OM", "POLYX", "CFG"],
  },
];

const historyCache = new Map();
const TOTAL_BARS = CORRELATION_DEFAULTS.estimationBars;

function analysisSymbol(symbol) {
  return `${baseAsset(symbol)}USDT`;
}

function categoryFor(symbol) {
  const base = baseAsset(symbol);
  return (
    CATEGORY_GROUPS.find((group) => group.coins.includes(base)) || {
      value: "other",
      label: "Other",
    }
  );
}

function uniqueByBase(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = baseAsset(item.symbol);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadHistory(item) {
  const cacheKey = `${item.exchange}:${item.symbol}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) return cached.rows;
  const rows = await fetchKlines(item.exchange, item.symbol, "1m", item.coin);
  const sorted = [...rows].sort((left, right) => left.time - right.time);
  historyCache.set(cacheKey, { at: Date.now(), rows: sorted });
  return sorted;
}

function alignedReturns(rows, grid) {
  const returns = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const continuous = current.time - previous.time <= 90;
    returns.set(
      current.time,
      continuous && previous.close > 0 && current.close > 0
        ? Math.log(current.close / previous.close)
        : Number.NaN,
    );
  }
  return grid.map((timestamp) => returns.get(timestamp) ?? Number.NaN);
}

export default function CorrelationView({ marketRows = [], onSelectCoin }) {
  const [category, setCategory] = useState("majors");
  const [anchor, setAnchor] = useState("BTC");
  const [filter, setFilter] = useState("all");
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const marketRowsRef = useRef(marketRows);
  marketRowsRef.current = marketRows;
  const universeReady = marketRows.length > 5;

  const selectedGroup =
    CATEGORY_GROUPS.find((group) => group.value === category) || CATEGORY_GROUPS[0];

  useEffect(() => {
    if (!selectedGroup.coins.includes(anchor)) setAnchor(selectedGroup.coins[0]);
  }, [selectedGroup, anchor]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoading(true);
      setAnalysis(null);
      const rowsSnapshot = marketRowsRef.current;
      const anchorMarket = [...rowsSnapshot]
        .filter((row) => baseAsset(row.symbol) === anchor)
        .sort(
          (left, right) => Number(right.volume_24h_usd || 0) - Number(left.volume_24h_usd || 0),
        )[0] || {
        symbol: `${anchor}USDT`,
        exchange: "binance",
        volume_24h_usd: 1_000_000_000,
      };
      const liquidPeers = [...rowsSnapshot]
        .filter(
          (row) =>
            baseAsset(row.symbol) !== anchor &&
            Number(row.volume_24h_usd) >= CORRELATION_DEFAULTS.min24hUsd,
        )
        .sort(
          (left, right) => Number(right.volume_24h_usd || 0) - Number(left.volume_24h_usd || 0),
        );
      const universe = uniqueByBase([anchorMarket, ...liquidPeers]).slice(0, 32);
      setProgress({ loaded: 0, total: universe.length });

      const histories = await Promise.all(
        universe.map(async (item) => {
          try {
            return { item, rows: await loadHistory(item) };
          } catch {
            return { item, rows: [] };
          } finally {
            if (alive) {
              setProgress((current) => ({
                ...current,
                loaded: current.loaded + 1,
              }));
            }
          }
        }),
      );
      if (!alive) return;

      const anchorHistory = histories.find(({ item }) => baseAsset(item.symbol) === anchor)?.rows;
      if (!anchorHistory || anchorHistory.length < TOTAL_BARS + 1) {
        setAnalysis({
          ok: false,
          reason: `Not enough aligned 1m history for ${anchor}.`,
          universeCount: histories.filter(({ rows }) => rows.length >= TOTAL_BARS + 1).length,
        });
        setLoading(false);
        return;
      }

      const grid = anchorHistory.slice(-TOTAL_BARS).map((bar) => bar.time);
      const symbols = {};
      const metadata = new Map();
      for (const { item, rows } of histories) {
        if (rows.length < TOTAL_BARS + 1) continue;
        const symbol = analysisSymbol(item.symbol);
        symbols[symbol] = {
          returns: alignedReturns(rows, grid),
          usd24h: Number(item.volume_24h_usd || 0),
        };
        metadata.set(symbol, item);
      }
      const anchorSymbol = analysisSymbol(anchor);
      const result = analyzeAnchorRelationships({
        anchorSymbol,
        symbols,
        factor: marketFactor(symbols),
      });
      setAnalysis({
        ...result,
        rows: result.ok
          ? result.rows.map((row) => ({
              ...row,
              market: metadata.get(row.symbol) || {
                symbol: row.symbol,
                exchange: "binance",
              },
              category: categoryFor(row.symbol),
            }))
          : [],
        anchorMarket,
        universeCount: Object.keys(symbols).length,
      });
      setLoading(false);
    };
    run();
    return () => {
      alive = false;
    };
  }, [anchor, universeReady]);

  const visibleRows = useMemo(() => {
    const rows = analysis?.ok ? analysis.rows : [];
    if (filter === "all") return rows;
    if (filter === "followers") return rows.filter((row) => row.lag > 0);
    return rows.filter((row) => row.relation === filter);
  }, [analysis, filter]);

  const summary = analysis?.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Correlation map"
        eyebrowIcon={ShareNetwork}
        title="Major coin relationships"
        description="Explore which liquid perpetuals historically move with, follow, lead, invert, or decouple from each major coin after broad-market movement is removed."
      />

      <section className="cw-panel cw-glow cw-glow-soft p-4 space-y-4">
        <div className="grid gap-4 md:grid-cols-2 md:gap-0">
          <div className="md:pr-5">
            <div className="text-xs text-fog-2">Category</div>
            <div className="mt-2">
              <Segmented
                size="sm"
                value={category}
                onChange={setCategory}
                options={CATEGORY_GROUPS.map((group) => ({
                  value: group.value,
                  label: group.label,
                }))}
              />
            </div>
          </div>
          <div className="border-white/[0.06] md:border-l md:pl-5">
            <div className="text-xs text-fog-2">Major anchor coin</div>
            <div className="mt-2">
              <Segmented
                size="sm"
                value={anchor}
                onChange={setAnchor}
                options={selectedGroup.coins.map((coin) => ({
                  value: coin,
                  label: coin,
                }))}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 @4xl:grid-cols-3 @6xl:grid-cols-6">
        <StatCard
          icon={ShareNetwork}
          label="Anchor"
          value={anchor}
          caption={selectedGroup.label}
          highlight
        />
        <StatCard
          icon={LinkSimple}
          label="Related"
          value={summary?.related ?? "—"}
          caption={`${analysis?.universeCount || 0} liquid markets tested`}
        />
        <StatCard
          icon={ShareNetwork}
          label="Positive"
          value={summary?.positive ?? "—"}
          caption={`Move with ${anchor}`}
          tone="up"
        />
        <StatCard
          icon={WarningCircle}
          label="Inverse"
          value={summary?.inverse ?? "—"}
          caption={`Move against ${anchor}`}
          tone="down"
        />
        <StatCard
          icon={Timer}
          label="Followers"
          value={summary?.followers ?? "—"}
          caption={`${anchor} leads these coins`}
        />
        <StatCard
          icon={Stack}
          label="Avg confidence"
          value={summary ? `${(summary.averageRhoLowerBound * 100).toFixed(0)}%` : "—"}
          caption="Lower-bound relationship"
        />
      </section>

      {loading && (
        <section className="cw-panel p-8 text-center">
          <CircleNotch weight="bold" className="mx-auto h-7 w-7 animate-spin text-mint" />
          <p className="mt-3 text-sm text-snow">Building {anchor} relationship map</p>
          <p className="mt-1 text-xs text-fog-2">
            Loaded {progress.loaded} of {progress.total} liquid markets
          </p>
        </section>
      )}

      {!loading && analysis && !analysis.ok && (
        <section className="cw-panel border-coral/20 p-6">
          <div className="flex items-start gap-3">
            <WarningCircle weight="fill" className="h-5 w-5 shrink-0 text-coral" />
            <div>
              <div className="text-sm text-snow">Relationship map unavailable</div>
              <p className="mt-1 text-xs text-fog">{analysis.reason}</p>
            </div>
          </div>
        </section>
      )}

      {!loading && analysis?.ok && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-snow">Coins related to {anchor}</div>
              <p className="mt-1 text-xs text-fog-2">
                Ranked by confidence-adjusted residual correlation.
              </p>
            </div>
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", badge: analysis.rows.length },
                {
                  value: "positive",
                  label: "Positive",
                  badge: summary.positive,
                },
                {
                  value: "inverse",
                  label: "Inverse",
                  badge: summary.inverse,
                },
                {
                  value: "followers",
                  label: "Followers",
                  badge: summary.followers,
                },
              ]}
            />
          </div>

          {visibleRows.length > 0 ? (
            <RelationshipTable rows={visibleRows} anchor={anchor} onSelectCoin={onSelectCoin} />
          ) : (
            <div className="cw-panel p-8 text-center text-sm text-fog">
              No relationships match this filter.
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function RelationshipTable({ rows, anchor, onSelectCoin }) {
  return (
    <div className="cw-panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] border-collapse text-xs">
          <thead className="bg-[#111215]/95 text-[10px] uppercase tracking-[0.08em] text-fog-2 backdrop-blur">
            <tr className="border-b border-white/[0.06]">
              <th className="px-4 py-3 text-left font-medium">Coin</th>
              <th className="px-3 py-3 text-left font-medium">Category</th>
              <th className="px-3 py-3 text-left font-medium">Relationship</th>
              <th className="px-3 py-3 text-left font-medium">State</th>
              <th className="px-3 py-3 text-right font-medium">Score</th>
              <th className="px-3 py-3 text-right font-medium">ρ residual</th>
              <th className="px-3 py-3 text-right font-medium">Confidence</th>
              <th className="px-3 py-3 text-right font-medium">Lead / lag</th>
              <th className="px-3 py-3 text-right font-medium">β relation</th>
              <th className="px-3 py-3 text-right font-medium">Recent</th>
              <th className="px-3 py-3 text-right font-medium">Expected</th>
              <th className="px-3 py-3 text-right font-medium">24h volume</th>
              <th className="w-10 px-3 py-3">
                <span className="sr-only">Open market</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {rows.map((row) => (
              <RelationshipRow
                key={row.symbol}
                row={row}
                anchor={anchor}
                onSelectCoin={onSelectCoin}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RelationshipRow({ row, anchor, onSelectCoin }) {
  const market = row.market;
  const base = baseAsset(row.symbol);
  const recentMove = Math.expm1(row.actualMove) * 100;
  const expectedMove = Math.expm1(row.expectedMove) * 100;
  const lagLabel =
    row.lag > 0
      ? `${base} follows ${anchor} by ${row.lag}m`
      : row.lag < 0
        ? `${base} leads ${anchor} by ${Math.abs(row.lag)}m`
        : "Moves synchronously";
  const payload = {
    ...market,
    symbol: market.symbol || row.symbol,
    exchange: market.exchange || "binance",
    price: market.price,
  };

  const openMarket = () => onSelectCoin?.(payload);
  const onKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMarket();
    }
  };

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={openMarket}
      onKeyDown={onKeyDown}
      className="group cursor-pointer transition-colors hover:bg-white/[0.025] focus-visible:bg-white/[0.035] focus-visible:outline-none"
    >
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-2.5">
          <CoinIcon
            symbol={market.symbol || row.symbol}
            coin={market.coin}
            exchange={market.exchange}
            isPump={recentMove >= 0}
            className="h-7 w-7 shrink-0"
          />
          <div className="leading-tight">
            <div className="font-semibold text-snow">{base}</div>
            <div className="mt-1 text-[10px] text-fog-2">{exchangeName(market.exchange)}</div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <span className="cw-chip">{row.category.label}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <div className={`font-medium ${row.relation === "positive" ? "text-mint" : "text-coral"}`}>
          {row.relation === "positive" ? "Moves with" : "Inverse"}
        </div>
        <div className="mt-1 text-[10px] text-fog-2">{lagLabel}</div>
      </td>
      <td className="whitespace-nowrap px-3 py-3 capitalize text-fog">
        {row.state.replace("-", " ")}
      </td>
      <td className="cw-num whitespace-nowrap px-3 py-3 text-right font-semibold text-snow">
        {row.score}
      </td>
      <td
        className={`cw-num whitespace-nowrap px-3 py-3 text-right ${
          row.rho >= 0 ? "text-mint" : "text-coral"
        }`}
      >
        {row.rho.toFixed(2)}
      </td>
      <td className="cw-num whitespace-nowrap px-3 py-3 text-right text-terminal-cyan">
        {row.rhoLowerBound.toFixed(2)}
      </td>
      <td className="cw-num whitespace-nowrap px-3 py-3 text-right text-snow">
        {row.lag > 0 ? "+" : ""}
        {row.lag}m
      </td>
      <td className="cw-num whitespace-nowrap px-3 py-3 text-right text-snow">
        {row.beta.toFixed(2)}
      </td>
      <td
        className={`cw-num whitespace-nowrap px-3 py-3 text-right ${
          recentMove >= 0 ? "text-mint" : "text-coral"
        }`}
      >
        {recentMove >= 0 ? "+" : ""}
        {recentMove.toFixed(2)}%
      </td>
      <td
        className={`cw-num whitespace-nowrap px-3 py-3 text-right ${
          expectedMove >= 0 ? "text-mint" : "text-coral"
        }`}
      >
        {expectedMove >= 0 ? "+" : ""}
        {expectedMove.toFixed(2)}%
      </td>
      <td className="cw-num whitespace-nowrap px-3 py-3 text-right text-snow">
        {fmtUsd(market.volume_24h_usd || 0)}
      </td>
      <td className="px-3 py-3 text-right">
        <ArrowUpRight
          weight="bold"
          className="h-4 w-4 text-fog transition-colors group-hover:text-mint"
        />
      </td>
    </tr>
  );
}
