import { SIGNAL_GATES } from "./signalPolicy";

export const SIGNAL_DEFAULTS = {
  lookback: SIGNAL_GATES.lookback,
  volumeLookback: SIGNAL_GATES.volume_lookback,
  minZ: SIGNAL_GATES.min_z,
  minRelVol: SIGNAL_GATES.min_rel_vol,
  minCandleUsd: SIGNAL_GATES.min_candle_usd,
  min24hUsd: SIGNAL_GATES.min_24h_usd,
  minTrades: SIGNAL_GATES.min_trades,
  sigmaFloor: SIGNAL_GATES.sigma_floor,
  minElapsed: SIGNAL_GATES.min_elapsed,
  maxFadeClv: SIGNAL_GATES.max_fade_clv,
};

export const SCALP_SIGNAL_PARAMS = {
  ...SIGNAL_DEFAULTS,
  minZ: 1.0,
  minRelVol: 1.0,
  minCandleUsd: 0,
  minTrades: 0,
  minElapsed: 0.1,
  maxFadeClv: 0,
};

const clip = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustStats(returns) {
  const mu = median(returns);
  const mad = median(returns.map((value) => Math.abs(value - mu)));
  return { mu, sigma: 1.4826 * mad };
}

export function evaluateSignal(candle, history = [], context = {}, params = SIGNAL_DEFAULTS) {
  const reasons = [];

  const baseline = history && history.length ? history.slice(-(params.lookback + 1)) : [];
  const previousClose = baseline.at(-1)?.close ?? candle.open;
  if (!(previousClose > 0) || !(candle.close > 0)) {
    return { pass: false, reasons: ["invalid price"] };
  }

  const logReturn = Math.log(candle.close / previousClose);
  const pct = Math.expm1(logReturn);
  const returns = [];
  for (let i = 1; i < baseline.length; i += 1) {
    if (baseline[i - 1].close > 0 && baseline[i].close > 0) {
      returns.push(Math.log(baseline[i].close / baseline[i - 1].close));
    }
  }
  const { mu, sigma: rawSigma } = returns.length >= 3 ? robustStats(returns) : { mu: 0, sigma: params.sigmaFloor || 0.0004 };
  const sigma = Math.max(rawSigma || 0, params.sigmaFloor || 0.0004);
  const elapsed = candle.closed ? 1 : clip(candle.elapsedFrac ?? 1, params.minElapsed || 0.1, 1);
  const z = (logReturn - mu) / (sigma * Math.sqrt(elapsed));

  const validVols = baseline
    .slice(-params.volumeLookback)
    .map((item) => item.usdVol)
    .filter((value) => value > 0);
  const medianVolume = validVols.length ? median(validVols) : 0;
  const relVol = medianVolume > 0 && candle.usdVol > 0 ? candle.usdVol / (medianVolume * elapsed) : 1;
  const range = candle.high - candle.low;
  const clv = range > 0 ? (candle.close - candle.low - (candle.high - candle.close)) / range : 0;
  const amplitude =
    (Math.max(candle.high, previousClose) - Math.min(candle.low, previousClose)) / previousClose;
  const side = pct >= 0 ? "pump" : "dump";

  const reqPct = context.thresholdPct || 0.004;
  if (Math.abs(pct) < reqPct) reasons.push("below sensitivity %");
  if (params.minZ > 0 && Math.abs(z) < params.minZ) reasons.push(`not significant (z=${z.toFixed(1)})`);
  if (candle.usdVol <= 0 && (context.turnover24hUsd || 0) < 10000) reasons.push("zero volume / illiquid");
  if (params.min24hUsd > 0 && (context.turnover24hUsd || 0) < params.min24hUsd)
    reasons.push("24h turnover too low");
  if (params.minCandleUsd > 0 && candle.usdVol > 0 && candle.usdVol < params.minCandleUsd)
    reasons.push("candle volume too low");
  if (params.minTrades > 0 && Number.isFinite(candle.trades) && candle.trades < params.minTrades)
    reasons.push("too few trades");
  if (params.minRelVol > 1.0 && medianVolume > 0 && candle.usdVol > 0 && relVol < params.minRelVol)
    reasons.push(`volume not unusual (x${relVol.toFixed(1)})`);
  if (params.maxFadeClv > 0 && ((side === "pump" && clv < -params.maxFadeClv) || (side === "dump" && clv > params.maxFadeClv)))
    reasons.push("close fades against move");

  const score =
    100 *
    (0.45 * clip(Math.abs(z) / 8) +
      0.25 * clip(Math.log10(Math.max(relVol, 1)) / 1.5) +
      0.15 * clip(Math.abs(clv)) +
      0.15 * clip(Math.log10(Math.max(context.turnover24hUsd || 1e6, 1) / 1e6) / 2));

  return {
    pass: reasons.length === 0,
    side,
    pct,
    z,
    relVol,
    clv,
    amplitude,
    score: Math.round(score),
    tier: candle.closed ? "confirmed" : "early",
    reasons,
  };
}

export const signalDedupeKey = (symbol, timeframe, candle, side) =>
  `${symbol}:${timeframe}:${candle.openTime}:${side}`;

export const scaleSignalThreshold = (oneMinutePct, timeframeMinutes) =>
  oneMinutePct * Math.sqrt(timeframeMinutes);
