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

export function calculateTradePlan({
  entry,
  side,
  atrAbs,
  stopLoss,
  rewardRatio = 1,
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
