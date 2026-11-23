from typing import Dict

from app.engine.policy import TRADE_POLICY


def calculate_rr_plan(
    entry: float,
    atr_abs: float,
    side: str,
    reward_ratio: float = 2.0,
    spread: float = 0.0,
    taker_fee: float = float(TRADE_POLICY["taker_fee_per_side"]),
) -> Dict[str, float | bool]:
    if entry <= 0 or atr_abs <= 0 or reward_ratio <= 0:
        raise ValueError("entry, ATR and reward ratio must be positive")

    direction = -1 if side.upper() == "SHORT" else 1
    stop_distance = float(TRADE_POLICY["atr_multiplier"]) * atr_abs
    target_distance = reward_ratio * stop_distance
    stop_pct = stop_distance / entry
    cost = max(0.0, spread) + 2 * max(0.0, taker_fee)
    net_reward = target_distance / entry - cost
    net_risk = stop_pct + cost
    net_rr = net_reward / net_risk if net_risk > 0 else 0.0
    breakeven = net_risk / (net_reward + net_risk) if net_reward + net_risk > 0 else 1.0

    return {
        "stop": entry - direction * stop_distance,
        "target": entry + direction * target_distance,
        "stop_distance": stop_distance,
        "cost": cost,
        "net_reward": net_reward,
        "net_risk": net_risk,
        "net_rr": net_rr,
        "breakeven_win_rate": breakeven,
        "flagged": (
            atr_abs / entry < float(TRADE_POLICY["min_atr_cost_multiple"]) * cost
            or net_rr < float(TRADE_POLICY["min_net_rr"])
        ),
    }
