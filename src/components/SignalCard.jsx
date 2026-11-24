import React from "react";
import { CaretRight, TrendUp, TrendDown, Fire, PushPin, SpeakerSlash } from "@phosphor-icons/react";
import CoinIcon, { baseAsset } from "./CoinIcon";
import MoverFX from "./MoverFX";
import { Metric, FlashValue } from "./ui";
import { exchangeName } from "./ExchangeLogo";

function parseVolumeUsd(signal) {
  if (Number.isFinite(Number(signal.volume_usd)) && Number(signal.volume_usd) > 0) {
    return Number(signal.volume_usd);
  }
  const raw = String(signal.volume || "").toUpperCase();
  const num = parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num)) return 0;
  if (raw.includes("B")) return num * 1e9;
  if (raw.includes("M")) return num * 1e6;
  if (raw.includes("K")) return num * 1e3;
  return num;
}

function getVolumeTier(signal) {
  const volUsd = parseVolumeUsd(signal);
  const spike = Number(signal.vol_spike || 0);
  if (volUsd >= 250_000 || spike >= 5) return 3; // Extreme whale volume
  if (volUsd >= 50_000 || spike >= 2.5) return 2; // High volume flash
  if (volUsd >= 10_000 || spike >= 1.5) return 1; // Moderate volume pulse
  return 0; // Slow / low volume -> no extra animation
}

export default function SignalCard({
  signal,
  view = "live",
  hot = false,
  selected = false,
  onSelect,
  onOpenPOA,
  pinned = false,
  onPin,
  onMute,
  index = 0,
}) {
  const isPump = signal.type === "PUMP" || (signal.type == null && signal.change_pct >= 0);
  const base = baseAsset(signal.symbol || signal.pair);
  const change = Number(signal.change_pct || 0);
  const DirIcon = isPump ? TrendUp : TrendDown;
  const volTier = view === "live" ? getVolumeTier(signal) : 0;
  const volAnimClass =
    volTier === 3
      ? isPump
        ? "cw-vol-extreme-up"
        : "cw-vol-extreme-down"
      : volTier === 2
        ? isPump
          ? "cw-vol-high-up"
          : "cw-vol-high-down"
        : volTier === 1
          ? isPump
            ? "cw-vol-mid-up"
            : "cw-vol-mid-down"
          : "";
  const lifecycleLabel = {
    confirming: "Confirming",
    confirmed: "Confirmed",
    invalidated: "Invalidated",
    stopped: "Stopped",
    target_hit: "TP1 hit",
    expired: "Expired",
    ambiguous: "Ambiguous",
  }[signal.lifecycle_status];
  const lifecycleTone = ["invalidated", "stopped"].includes(signal.lifecycle_status)
    ? "!text-coral"
    : signal.lifecycle_status === "confirmed" || signal.lifecycle_status === "target_hit"
      ? "!text-mint"
      : signal.lifecycle_status === "confirming"
        ? "!text-terminal-yellow"
        : "!text-fog";

  return (
    <article
      onClick={() => onSelect?.(signal)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(signal);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${base} ${isPump ? "pump" : "dump"} ${change}% on ${exchangeName(signal.exchange)}`}
      style={{ animationDelay: `${Math.min(index, 10) * 25}ms` }}
      className={`cw-card cw-card-sm cw-card-in cw-press relative overflow-hidden group p-4 cursor-pointer ${volAnimClass} ${
        hot ? "cw-glow !border-white/[0.18]" : selected ? "!border-mint/35" : "cw-hover"
      }`}
    >
      {(hot || volTier >= 3) && (
        <MoverFX direction={isPump ? "up" : "down"} intensity={volTier >= 3 ? 1.35 : 0.9} />
      )}
      {volTier >= 2 && (
        <span
          aria-hidden="true"
          className={`cw-sweep pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent ${
            volTier >= 3
              ? "via-yellow-300/[0.14]"
              : isPump
                ? "via-mint/[0.12]"
                : "via-coral/[0.12]"
          } to-transparent`}
        />
      )}

      <div className="relative">
        <div className="flex items-start gap-3">
          <span className="relative shrink-0">
            {hot && (
              <span
                className={`cw-ring absolute inset-0 rounded-full ${isPump ? "bg-mint/25" : "bg-coral/25"}`}
              />
            )}
            <CoinIcon
              symbol={signal.symbol}
              coin={signal.coin}
              exchange={signal.exchange}
              isPump={isPump}
              className="relative w-9 h-9"
            />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[16px] font-semibold text-snow truncate">{base}</span>
              <span className="text-[11px] text-fog-2">/USDT</span>
              {signal.timestamp && <span className="cw-chip ml-1">{signal.timestamp}</span>}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] min-w-0">
              {view === "live" ? (
                <span
                  className={`inline-flex items-center gap-1 font-medium ${isPump ? "text-mint" : "text-coral"}`}
                >
                  <DirIcon weight="bold" className="w-3 h-3" />
                  Live signal
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-fog-2 min-w-0 truncate">
                  Saved · {signal.candle_at}
                </span>
              )}
              {(lifecycleLabel || signal.tier) && (
                <span className={`cw-chip ${lifecycleTone}`}>
                  {lifecycleLabel || (signal.tier === "confirmed" ? "Confirmed" : "Early")}
                </span>
              )}
              {Number.isFinite(signal.score) && (
                <span
                  className="cw-chip"
                  title={
                    Number.isFinite(signal.zscore) ? `Robust z-score: ${signal.zscore}` : undefined
                  }
                >
                  Score {signal.score}
                </span>
              )}
              {hot && (
                <span className="cw-top-mover-pulse shrink-0 inline-flex items-center gap-1 px-1.5 rounded-full bg-white/[0.08] border border-white/[0.12] text-snow whitespace-nowrap">
                  <Fire
                    weight="fill"
                    className={`w-3 h-3 ${isPump ? "text-mint" : "text-coral"}`}
                  />
                  Top mover
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPin?.(signal);
                }}
                className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                  pinned
                    ? "bg-mint/10 text-mint"
                    : "text-fog-2 hover:bg-white/[0.05] hover:text-snow"
                }`}
                aria-label={pinned ? `Unpin ${base}` : `Pin ${base}`}
                title={pinned ? "Unpin signal" : "Pin signal"}
              >
                <PushPin weight={pinned ? "fill" : "duotone"} className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onMute?.(signal);
                }}
                className="flex h-6 w-6 items-center justify-center rounded-full text-fog-2 transition-colors hover:bg-white/[0.05] hover:text-coral"
                aria-label={`Mute ${base}`}
                title="Mute coin"
              >
                <SpeakerSlash weight="duotone" className="h-3.5 w-3.5" />
              </button>
            </div>
            <span
              className={`px-2 py-px rounded-full text-[10px] font-semibold ${
                isPump ? "text-mint bg-mint/10" : "text-coral bg-coral/10"
              }`}
            >
              {isPump ? "Pump" : "Dump"}
            </span>
            <FlashValue
              value={`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
              direction={isPump ? "up" : "down"}
              className={`cw-num text-[18px] font-semibold leading-none ${isPump ? "text-mint" : "text-coral"}`}
            />
          </div>
        </div>

        <div className="my-3 h-px bg-white/[0.06]" />

        <div className="grid grid-cols-4 gap-2">
          <Metric label="Open" value={signal.open} />
          <Metric label="High" value={signal.high} tone="up" />
          <Metric label="Low" value={signal.low} tone="down" />
          <Metric label="Close" value={signal.close} tone={isPump ? "up" : "down"} />
        </div>

        <div className="mt-3 flex items-end gap-2">
          <div className="grid grid-cols-[0.8fr_1fr_1.6fr] gap-2 flex-1 min-w-0">
            <Metric label="Amplitude" value={`${signal.amplitude}%`} tone="accent" />
            <Metric label="Volume" value={signal.volume} />
            <Metric label="Came at" value={signal.candle_at} tone="muted" />
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenPOA?.(signal);
            }}
            title="Create Plan of Attack"
            aria-label={`Create Plan of Attack for ${base}`}
            className="w-8 h-8 -mr-1 rounded-full flex items-center justify-center text-fog hover:text-snow hover:bg-white/[0.06] transition-colors"
          >
            <CaretRight
              weight="bold"
              className="w-4 h-4 group-hover:translate-x-0.5 transition-transform duration-150"
            />
          </button>
        </div>
      </div>
    </article>
  );
}
