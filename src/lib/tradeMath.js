import { TRADE_POLICY } from "./signalPolicy";

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function atrFromCandles(candles, length = 14) {
  const valid = candles.filter(
    (candle) =>
      Number(candle.high) > 0 &&
      Number(candle.low) > 0 &&
      Number(candle.close) > 0 &&
      Number(candle.high) >= Number(candle.low),
  );
  const closed = valid.length > length ? valid.slice(0, -1) : valid;
  if (closed.length < length + 1) return 0;
  const tail = closed.slice(-(length + 1));
  const ranges = [];
  for (let index = 1; index < tail.length; index += 1) {
    const current = tail[index];
    const previous = tail[index - 1];
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  return mean(ranges);
}

/**
 * Computes a structured pullback/retest entry price instead of chasing the raw trigger candle close.
 */
export function calculateSmartEntry({
  triggerClose,
  open,
  high,
  low,
  side,
  atrAbs = 0,
  currentPrice = 0,
  entryMode = "retest",
}) {
  const close = Number(triggerClose) || Number(currentPrice);
  if (!(close > 0)) return 0;

  const isShort = side === "SHORT";
  const cHigh = Number(high) > 0 ? Number(high) : close;
  const cLow = Number(low) > 0 ? Number(low) : close;
  const cOpen = Number(open) > 0 ? Number(open) : close;
  const candleRange = Math.max(0, cHigh - cLow);
  const bodySize = Math.abs(close - cOpen);
  const effectiveRange = Math.max(candleRange, bodySize, Number(atrAbs) || 0);

  if (!(effectiveRange > 0)) return close;

  const retracePct =
    entryMode === "deep" ? 0.5 : entryMode === "shallow" ? 0.236 : 0.382;

  let retestPrice;
  if (isShort) {
    // Bounce back up into the dump candle structure before continuation
    retestPrice = close + effectiveRange * retracePct;
    const ceiling = cHigh - candleRange * 0.12;
    if (cHigh > close && retestPrice > ceiling) retestPrice = ceiling;
    if (currentPrice > close && currentPrice < cHigh) {
      retestPrice = Math.max(retestPrice, currentPrice);
    }
  } else {
    // Pullback into the pump candle structure instead of buying the top wick
    retestPrice = close - effectiveRange * retracePct;
    const floor = cLow + candleRange * 0.12;
    if (cLow < close && retestPrice < floor) retestPrice = floor;
    if (currentPrice > cLow && currentPrice < close) {
      retestPrice = Math.min(retestPrice, currentPrice);
    }
  }

  return Number(retestPrice.toPrecision(6));
}

export function calculateTradePlan({
  entry,
  side,
  atrAbs,
  stopLoss,
  rewardRatio = 1.5,
  spread = 0,
  takerFee = TRADE_POLICY.taker_fee_per_side,
  balance = 10_000,
  riskPct = 1,
}) {
  const price = Number(entry);
  const atr = Number(atrAbs) || 0;
  const ratio = Number(rewardRatio) || 1;
  const explicitStop = Number(stopLoss);
  const direction = side === "SHORT" ? -1 : 1;

  const hasValidExplicitStop =
    explicitStop > 0 &&
    ((direction > 0 && explicitStop < price) || (direction < 0 && explicitStop > price));

  const stopDistance = hasValidExplicitStop
    ? Math.abs(price - explicitStop)
    : atr > 0
      ? TRADE_POLICY.atr_multiplier * atr
      : price * 0.002;

  if (!(price > 0) || !(stopDistance > 0) || !(ratio > 0)) return null;

  const stop = hasValidExplicitStop ? explicitStop : price - direction * stopDistance;
  const targetDistance = ratio * stopDistance;
  const stopPct = stopDistance / price;
  const cost = Math.max(0, Number(spread) || 0) + 2 * Math.max(0, Number(takerFee) || 0);
  const netReward = targetDistance / price - cost;
  const netRisk = stopPct + cost;
  const netRR = netRisk > 0 ? netReward / netRisk : 0;
  const breakevenWinRate =
    netReward + netRisk > 0 ? netRisk / (netReward + netRisk) : Number.POSITIVE_INFINITY;
  const riskUsd = Number(balance || 0) * (Number(riskPct || 0) / 100);
  const positionUsd = stopPct > 0 ? riskUsd / stopPct : 0;

  return {
    side: direction > 0 ? "LONG" : "SHORT",
    entry: price,
    stop,
    target: price + direction * targetDistance,
    tp1: price + direction * targetDistance,
    atrAbs: atr,
    stopDistance,
    stopPct,
    rewardRatio: ratio,
    cost,
    netReward,
    netRisk,
    netRR,
    breakevenWinRate,
    flagged:
      (atr > 0 && atr / price < TRADE_POLICY.min_atr_cost_multiple * cost) ||
      netRR < TRADE_POLICY.min_net_rr,
    riskPct: Number(riskPct),
    riskUsd,
    positionUsd,
  };
}
