import policy from "../../config/signal_policy.json";

export const SIGNAL_POLICY = Object.freeze(policy);
export const POLICY_VERSION = policy.policy_version;
export const TIMEFRAME_IDS = Object.freeze(Object.keys(policy.timeframes));
export const TIMEFRAME_MINUTES = Object.freeze(
  Object.fromEntries(TIMEFRAME_IDS.map((id) => [id, policy.timeframes[id].minutes])),
);
export const SIGNAL_TTL_SECONDS = Object.freeze(
  Object.fromEntries(TIMEFRAME_IDS.map((id) => [id, policy.timeframes[id].ttl_seconds])),
);
export const SENSITIVITY_POLICY = Object.freeze(policy.sensitivity);
export const SIGNAL_GATES = Object.freeze(policy.signal_gates);
export const TRADE_POLICY = Object.freeze(policy.trade);
export const LIQUIDITY_TIERS = Object.freeze(policy.liquidity_tiers_usd);

export function timeframePolicy(timeframe) {
  return policy.timeframes[timeframe] || policy.timeframes["1m"];
}

export function rewardRatioFor(timeframe) {
  return Number(timeframePolicy(timeframe).reward_ratio);
}
