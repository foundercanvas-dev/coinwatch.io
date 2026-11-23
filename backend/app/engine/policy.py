import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict


_POLICY_PATH = Path(__file__).resolve().parents[3] / "config" / "signal_policy.json"


def _load_policy() -> Dict[str, Any]:
    with _POLICY_PATH.open("r", encoding="utf-8") as policy_file:
        policy = json.load(policy_file)

    required_timeframes = {"1m", "5m", "15m", "1h", "4h"}
    if set(policy.get("timeframes", {})) != required_timeframes:
        raise ValueError("signal policy must define exactly 1m, 5m, 15m, 1h and 4h")
    if not policy.get("policy_version"):
        raise ValueError("signal policy requires policy_version")

    for timeframe, values in policy["timeframes"].items():
        if values.get("minutes", 0) <= 0:
            raise ValueError(f"{timeframe} minutes must be positive")
        if values.get("reward_ratio", 0) <= 0:
            raise ValueError(f"{timeframe} reward_ratio must be positive")
        if values.get("ttl_seconds", 0) <= 0:
            raise ValueError(f"{timeframe} ttl_seconds must be positive")

    sensitivity = policy.get("sensitivity", {})
    if not (
        0 < sensitivity.get("detection_floor_pct", 0)
        <= sensitivity.get("min_pct", 0)
        <= sensitivity.get("default_pct", 0)
        <= sensitivity.get("max_pct", 0)
    ):
        raise ValueError("signal policy sensitivity bounds are invalid")

    tiers = policy.get("liquidity_tiers_usd", [])
    if not tiers or tiers != sorted(set(tiers)):
        raise ValueError("signal policy liquidity tiers must be sorted and unique")
    return policy


SIGNAL_POLICY = _load_policy()
POLICY_VERSION = str(SIGNAL_POLICY["policy_version"])
TIMEFRAME_IDS = tuple(SIGNAL_POLICY["timeframes"].keys())
SIGNAL_GATES = dict(SIGNAL_POLICY["signal_gates"])
TRADE_POLICY = dict(SIGNAL_POLICY["trade"])
SENSITIVITY_POLICY = dict(SIGNAL_POLICY["sensitivity"])


def policy_payload() -> Dict[str, Any]:
    return deepcopy(SIGNAL_POLICY)


def timeframe_policy(timeframe: str) -> Dict[str, Any]:
    try:
        return SIGNAL_POLICY["timeframes"][timeframe]
    except KeyError as error:
        raise ValueError(f"unsupported timeframe: {timeframe}") from error


def timeframe_minutes(timeframe: str) -> int:
    return int(timeframe_policy(timeframe)["minutes"])


def reward_ratio_for(timeframe: str) -> float:
    return float(timeframe_policy(timeframe)["reward_ratio"])


def ttl_seconds_for(timeframe: str) -> int:
    return int(timeframe_policy(timeframe)["ttl_seconds"])


def signal_policy_snapshot(timeframe: str, sensitivity: float) -> Dict[str, Any]:
    frame = timeframe_policy(timeframe)
    return {
        "policy_version": POLICY_VERSION,
        "timeframe": timeframe,
        "timeframe_minutes": int(frame["minutes"]),
        "reward_ratio": float(frame["reward_ratio"]),
        "ttl_seconds": int(frame["ttl_seconds"]),
        "trigger_sensitivity_pct": float(sensitivity),
        "signal_gates": deepcopy(SIGNAL_GATES),
        "trade": deepcopy(TRADE_POLICY),
    }
