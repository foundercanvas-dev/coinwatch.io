"""Pure, robust pump/dump signal evaluation shared by backend scanners."""

import math
from statistics import median
from typing import Any, Dict, List, Optional

from app.engine.policy import SIGNAL_GATES

DEFAULTS: Dict[str, float] = dict(SIGNAL_GATES)

SCALP_PARAMS: Dict[str, float] = {
    "min_z": 3,
    "min_rel_vol": 2,
    "min_candle_usd": 0,
    "min_trades": 5,
    "min_elapsed": 0.2,
    "max_fade_clv": 0,
}


def _clip(value: float, low: float = 0, high: float = 1) -> float:
    return min(high, max(low, value))


def _robust_stats(returns: List[float]) -> tuple[float, float]:
    center = median(returns) if returns else 0.0
    mad = median(abs(value - center) for value in returns) if returns else 0.0
    return center, 1.4826 * mad


def evaluate_signal(
    candle: Dict[str, Any],
    history: List[Dict[str, Any]],
    context: Dict[str, float],
    params: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    p = {**DEFAULTS, **(params or {})}
    reasons: List[str] = []
    if len(history) < 20:
        return {"pass": False, "reasons": ["not enough history"]}

    baseline = history[-(int(p["lookback"]) + 1) :]
    previous_close = float(baseline[-1]["close"])
    close = float(candle["close"])
    if previous_close <= 0 or close <= 0:
        return {"pass": False, "reasons": ["invalid price"]}

    log_return = math.log(close / previous_close)
    pct = math.expm1(log_return)
    returns = [
        math.log(float(baseline[index]["close"]) / float(baseline[index - 1]["close"]))
        for index in range(1, len(baseline))
        if float(baseline[index - 1]["close"]) > 0 and float(baseline[index]["close"]) > 0
    ]
    mu, raw_sigma = _robust_stats(returns)
    sigma = max(raw_sigma, p["sigma_floor"])
    elapsed = 1.0 if candle["closed"] else _clip(float(candle.get("elapsed_frac", 1)), p["min_elapsed"], 1)
    zscore = (log_return - mu) / (sigma * math.sqrt(elapsed))

    volumes = [
        float(item["usd_vol"])
        for item in baseline[-int(p["volume_lookback"]) :]
        if float(item["usd_vol"]) >= 0
    ]
    median_volume = median(volumes) if volumes else 0.0
    candle_volume = float(candle["usd_vol"])
    relative_volume = candle_volume / (median_volume * elapsed) if median_volume > 0 else 0.0

    high = float(candle["high"])
    low = float(candle["low"])
    candle_range = high - low
    clv = (close - low - (high - close)) / candle_range if candle_range > 0 else 0.0
    amplitude = (max(high, previous_close) - min(low, previous_close)) / previous_close
    side = "pump" if pct >= 0 else "dump"

    if abs(pct) < context["threshold_pct"]:
        reasons.append("below sensitivity %")
    if abs(zscore) < p["min_z"]:
        reasons.append(f"not significant (z={zscore:.1f})")
    if p.get("min_24h_usd", 0) > 0 and context["turnover_24h_usd"] < p["min_24h_usd"]:
        reasons.append("24h turnover too low")
    if p.get("min_candle_usd", 0) > 0 and candle_volume < p["min_candle_usd"]:
        reasons.append("candle volume too low")
    trades = candle.get("trades")
    if p.get("min_trades", 0) > 0 and (trades is None or int(trades) < p["min_trades"]):
        reasons.append("too few trades")
    if relative_volume < p["min_rel_vol"]:
        reasons.append(f"volume not unusual (x{relative_volume:.1f})")
    if (
        (side == "pump" and clv < -p["max_fade_clv"])
        or (side == "dump" and clv > p["max_fade_clv"])
    ):
        reasons.append("close fades against move")

    score = 100 * (
        0.45 * _clip(abs(zscore) / 8)
        + 0.25 * _clip(math.log10(max(relative_volume, 1)) / 1.5)
        + 0.15 * _clip(abs(clv))
        + 0.15 * _clip(math.log10(max(context["turnover_24h_usd"], 1) / 1e6) / 2)
    )
    return {
        "pass": not reasons,
        "side": side,
        "pct": pct,
        "z": zscore,
        "rel_vol": relative_volume,
        "clv": clv,
        "amplitude": amplitude,
        "score": round(score),
        "tier": "confirmed" if candle["closed"] else "early",
        "reasons": reasons,
    }


def dedupe_key(symbol: str, timeframe: str, candle: Dict[str, Any], side: str) -> str:
    return f"{symbol}:{timeframe}:{candle['open_time']}:{side}"


def scale_threshold(one_minute_pct: float, timeframe_minutes: int) -> float:
    return one_minute_pct * math.sqrt(timeframe_minutes)
