from dataclasses import dataclass
from typing import Dict, Optional


TERMINAL_OUTCOMES = {"target_hit", "stopped", "expired", "ambiguous"}


@dataclass(frozen=True)
class MarketObservation:
    price: float
    event_ts_ms: int
    sequence: Optional[int] = None


def _is_newer(signal: Dict, observation: MarketObservation) -> bool:
    previous_ts = int(signal.get("_last_market_event_ts_ms") or 0)
    previous_sequence = signal.get("_last_market_sequence")
    if observation.event_ts_ms < previous_ts:
        return False
    if observation.event_ts_ms == previous_ts:
        if observation.sequence is None or previous_sequence is None:
            return False
        return observation.sequence > int(previous_sequence)
    return True


def evaluate_observation(
    signal: Dict,
    observation: Optional[MarketObservation],
    clock_ts_ms: int,
) -> Optional[Dict]:
    if signal.get("lifecycle_status") != "confirmed":
        return None

    expires_ts_ms = int(float(signal.get("expires_ts") or 0) * 1000)
    if observation and _is_newer(signal, observation):
        signal["_last_market_event_ts_ms"] = observation.event_ts_ms
        signal["_last_market_sequence"] = observation.sequence
        if not expires_ts_ms or observation.event_ts_ms <= expires_ts_ms:
            is_long = signal.get("direction") == "LONG"
            stop = float(signal.get("stop_loss") or 0)
            target = float(signal.get("tp1") or 0)
            stop_hit = stop > 0 and (
                (is_long and observation.price <= stop)
                or (not is_long and observation.price >= stop)
            )
            target_hit = target > 0 and (
                (is_long and observation.price >= target)
                or (not is_long and observation.price <= target)
            )
            if stop_hit and target_hit:
                return {
                    "status": "ambiguous",
                    "event_ts_ms": observation.event_ts_ms,
                    "trigger_price": observation.price,
                    "gross_r": None,
                    "net_r": None,
                    "cost_fraction": float(signal.get("cost_fraction") or 0),
                    "reason": "Stop and target ordering could not be established",
                }
            if stop_hit:
                return {
                    "status": "stopped",
                    "event_ts_ms": observation.event_ts_ms,
                    "trigger_price": observation.price,
                    "gross_r": -1.0,
                    "net_r": -1.0,
                    "cost_fraction": float(signal.get("cost_fraction") or 0),
                    "reason": "Stop loss reached",
                }
            if target_hit:
                return {
                    "status": "target_hit",
                    "event_ts_ms": observation.event_ts_ms,
                    "trigger_price": observation.price,
                    "gross_r": float(signal.get("reward_ratio") or 0),
                    "net_r": float(signal.get("net_rr") or signal.get("reward_ratio") or 0),
                    "cost_fraction": float(signal.get("cost_fraction") or 0),
                    "reason": "Target reached",
                }

    if expires_ts_ms and clock_ts_ms >= expires_ts_ms:
        return {
            "status": "expired",
            "event_ts_ms": expires_ts_ms,
            "trigger_price": observation.price if observation else None,
            "gross_r": None,
            "net_r": None,
            "cost_fraction": float(signal.get("cost_fraction") or 0),
            "reason": "Scalp window expired",
        }
    return None


def evaluate_barrier_range(
    signal: Dict,
    low: float,
    high: float,
    event_ts_ms: int,
) -> Optional[Dict]:
    is_long = signal.get("direction") == "LONG"
    stop = float(signal.get("stop_loss") or 0)
    target = float(signal.get("tp1") or 0)
    stop_hit = stop > 0 and (low <= stop if is_long else high >= stop)
    target_hit = target > 0 and (high >= target if is_long else low <= target)
    if stop_hit and target_hit:
        return {
            "status": "ambiguous",
            "event_ts_ms": event_ts_ms,
            "trigger_price": None,
            "gross_r": None,
            "net_r": None,
            "cost_fraction": float(signal.get("cost_fraction") or 0),
            "reason": "Bar crossed stop and target without ordered ticks",
        }
    return None
