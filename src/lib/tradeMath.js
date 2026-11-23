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
  rewardRatio = 2,
  spread = 0,
  takerFee = TRADE_POLICY.taker_fee_per_side,
  balance = 10_000,
  riskPct = 1,
}) {
  const price = Number(entry);
  const atr = Number(atrAbs);
  const ratio = Number(rewardRatio);
  if (!(price > 0) || !(atr > 0) || !(ratio > 0)) return null;

  const direction = side === "SHORT" ? -1 : 1;
  const stopDistance = TRADE_POLICY.atr_multiplier * atr;
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
  const dcaNear = price - direction * stopDistance * 0.35;
  const dcaFar = price - direction * stopDistance * 0.65;

  return {
    side: direction > 0 ? "LONG" : "SHORT",
    entry: price,
    stop: price - direction * stopDistance,
    target: price + direction * targetDistance,
    tp1: price + direction * targetDistance,
    dca: (dcaNear + dcaFar) / 2,
    dcaZoneLow: Math.min(dcaNear, dcaFar),
    dcaZoneHigh: Math.max(dcaNear, dcaFar),
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
      atr / price < TRADE_POLICY.min_atr_cost_multiple * cost || netRR < TRADE_POLICY.min_net_rr,
    riskPct: Number(riskPct),
    riskUsd,
    positionUsd,
  };
}
