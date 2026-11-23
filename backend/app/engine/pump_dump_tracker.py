import time
import threading
import uuid
from typing import Dict, List, Optional, Set
from datetime import datetime
from app.engine.signal_math import SCALP_PARAMS, dedupe_key, evaluate_signal
from app.engine.trade_math import calculate_rr_plan
from app.engine.policy import (
    TRADE_POLICY,
    reward_ratio_for,
    signal_policy_snapshot,
    timeframe_minutes,
    ttl_seconds_for,
)
from app.engine.outcomes import MarketObservation, evaluate_observation

TERMINAL_STATES = {"invalidated", "stopped", "target_hit", "expired", "ambiguous"}


def _positive_int(value) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _float_or_zero(value) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if parsed == parsed else 0.0


class PumpDumpTracker:
    def __init__(self, max_history: int = 500, store=None):
        self.max_history = max_history
        self._store = store
        self._signals: List[Dict] = []
        self._cooldowns: Dict[str, float] = {}
        self._seen_candle_keys: Set[str] = set()
        self._signal_ids: Dict[str, int] = {}
        self._lock = threading.Lock()
        self._next_id = 1
        self._last_event_time = datetime.now().strftime("%I:%M:%S %p")
        self._last_event_ts = 0
        self.pumps_count = 0
        self.dumps_count = 0
        self._restore()

    def _restore(self):
        if self._store is None:
            return
        for signal in self._store.load_signals(self.max_history):
            signal_id = int(signal.get("id") or 0)
            dedupe = signal.get("dedupe_key")
            if signal_id <= 0 or not dedupe:
                continue
            self._signals.append(signal)
            self._signal_ids[dedupe] = signal_id
            self._next_id = max(self._next_id, signal_id + 1)
            created_ts = int(float(signal.get("created_ts") or signal.get("raw_ts") or 0) * 1000)
            self._last_event_ts = max(self._last_event_ts, created_ts)
        if self._last_event_ts:
            self._last_event_time = datetime.fromtimestamp(
                self._last_event_ts / 1000
            ).strftime("%I:%M:%S %p")

    def _persist_created_signal(self, signal: Dict, dedupe: str, now: float):
        signal.setdefault("event_id", str(uuid.uuid4()))
        signal.setdefault("dedupe_key", dedupe)
        signal.setdefault("created_ts", now)
        signal.setdefault(
            "trigger_sensitivity",
            signal.get("policy_snapshot", {}).get("trigger_sensitivity_pct", 0),
        )
        signal.setdefault(
            "trigger_reward_ratio",
            reward_ratio_for(signal.get("timeframe", "1m")),
        )
        if self._store is None:
            return
        self._store.create_signal(signal, dedupe)
        self._store.append_transition(
            signal["event_id"],
            signal["lifecycle_status"],
            int(now * 1000),
            signal.get("outcome", "Signal created"),
            {
                "lifecycle_status": signal["lifecycle_status"],
                "outcome": signal.get("outcome", "Signal created"),
                "confirmed_ts": signal.get("confirmed_ts"),
                "expires_ts": signal.get("expires_ts"),
            },
        )
        if signal["lifecycle_status"] in TERMINAL_STATES:
            self._store.record_outcome(
                signal["event_id"],
                {
                    "status": signal["lifecycle_status"],
                    "event_ts_ms": int(
                        float(signal.get("finalized_ts") or now) * 1000
                    ),
                    "trigger_price": signal.get("price"),
                    "gross_r": None,
                    "net_r": None,
                    "cost_fraction": float(signal.get("cost_fraction") or 0),
                    "reason": signal.get("outcome", "Historical signal"),
                },
            )

    def _transition(
        self,
        signal: Dict,
        status: str,
        reason: str,
        event_ts: float,
        patch: Optional[Dict] = None,
        outcome: Optional[Dict] = None,
    ):
        if signal.get("lifecycle_status") in TERMINAL_STATES:
            return
        transition_patch = dict(patch or {})
        transition_patch.update(
            {
                "lifecycle_status": status,
                "outcome": reason,
            }
        )
        if status in TERMINAL_STATES:
            transition_patch.setdefault("finalized_ts", event_ts)
        signal.update(transition_patch)
        if self._store is None or not signal.get("event_id"):
            return
        self._store.append_transition(
            signal["event_id"],
            status,
            int(event_ts * 1000),
            reason,
            transition_patch,
        )
        if status in TERMINAL_STATES:
            terminal = dict(outcome or {})
            terminal.setdefault("status", status)
            terminal.setdefault("event_ts_ms", int(event_ts * 1000))
            terminal.setdefault("reason", reason)
            terminal.setdefault("cost_fraction", float(signal.get("cost_fraction") or 0))
            self._store.record_outcome(signal["event_id"], terminal)

    def _evaluate_candle(
        self,
        buf,
        candle,
        sensitivity: float,
        timeframe: str = "1m",
    ) -> Optional[Dict]:
        """Evaluates a candle for confirmation, directional indication, and High RR trade levels."""
        # Handle dict or Candle object
        if isinstance(candle, dict):
            open_px = _float_or_zero(candle.get("open"))
            close_px = _float_or_zero(candle.get("close"))
            high_px = _float_or_zero(candle.get("high"))
            low_px = _float_or_zero(candle.get("low"))
            vol = _float_or_zero(candle.get("volume"))
            quote_vol = _float_or_zero(candle.get("quote_volume"))
            candle_ts = int(_float_or_zero(candle.get("time"))) * 1000
            is_closed = bool(candle.get("closed", True))
            trades = _positive_int(candle.get("trades_count"))
        else:
            open_px = candle.open
            close_px = candle.close
            high_px = candle.high
            low_px = candle.low
            vol = candle.volume
            quote_vol = candle.quote_volume or 0.0
            candle_ts = candle.ts
            is_closed = candle.closed
            trades = _positive_int(candle.trades_count)

        if open_px <= 0 or close_px <= 0:
            return None

        candle_vol = quote_vol if quote_vol > 0 else (vol * close_px if vol > 0 else 0.0)
        candidate = {
            "open_time": candle_ts,
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "usd_vol": candle_vol,
            "trades": trades,
            "closed": is_closed,
            "elapsed_frac": min(
                1.0,
                max(
                    0.0,
                    (time.time() * 1000 - candle_ts)
                    / (timeframe_minutes(timeframe) * 60_000),
                ),
            ),
        }
        history = self._history_before(buf, timeframe, candle_ts)
        atr_rows = history[-15:]
        true_ranges = []
        for index in range(1, len(atr_rows)):
            current = atr_rows[index]
            previous = atr_rows[index - 1]
            true_ranges.append(max(
                current["high"] - current["low"],
                abs(current["high"] - previous["close"]),
                abs(current["low"] - previous["close"]),
            ))
        atr_abs = sum(true_ranges) / len(true_ranges) if true_ranges else 0.0
        evaluation = evaluate_signal(
            candidate,
            history,
            {"turnover_24h_usd": buf.volume_24h_usd, "threshold_pct": sensitivity / 100.0},
            SCALP_PARAMS if timeframe == "1m" else None,
        )
        if not evaluation["pass"]:
            return None

        change_pct = evaluation["pct"] * 100
        amplitude = evaluation["amplitude"] * 100
        vol_spike = evaluation["rel_vol"]

        tf_label = timeframe.upper()
        if change_pct > 0:
            direction = "LONG"
            signal_type = "PUMP"
            
            # Risk:Reward math for Long
            if timeframe == "1m":
                risk = min(close_px * 0.008, max(close_px * 0.0025, close_px - low_px))
                stop_loss = round(close_px - risk, 6)
                rr = 2.0
                signal_label = "CONFIRMED LONG (1M SCALP)"
                tp1 = round(close_px + (risk * 1.2), 6)
                tp2 = round(close_px + (risk * 2.0), 6)
                tp3 = round(close_px + (risk * 2.8), 6)
            elif timeframe == "5m":
                stop_loss = round(low_px * 0.995, 6)
                risk = max(1e-6, close_px - stop_loss)
                rr = 2.8
                signal_label = "CONFIRMED LONG (5M MOMENTUM)"
                tp1 = round(close_px + (risk * 2.0), 6)
                tp2 = round(close_px + (risk * 3.5), 6)
                tp3 = round(close_px + (risk * 5.0), 6)
            elif timeframe == "15m":
                stop_loss = round(low_px * 0.995, 6)
                risk = max(1e-6, close_px - stop_loss)
                rr = 3.8
                signal_label = "CONFIRMED LONG (15M INTRADAY)"
                tp1 = round(close_px + (risk * 2.5), 6)
                tp2 = round(close_px + (risk * 4.5), 6)
                tp3 = round(close_px + (risk * 6.5), 6)
            elif timeframe == "1h":
                stop_loss = round(low_px * 0.995, 6)
                risk = max(1e-6, close_px - stop_loss)
                rr = 5.5
                signal_label = "CONFIRMED LONG (1H HIGH RR SWING)"
                tp1 = round(close_px + (risk * 3.5), 6)
                tp2 = round(close_px + (risk * 6.0), 6)
                tp3 = round(close_px + (risk * 9.0), 6)
            else: # 4h
                stop_loss = round(low_px * 0.995, 6)
                risk = max(1e-6, close_px - stop_loss)
                rr = 8.0
                signal_label = "CONFIRMED LONG (4H MACRO TREND)"
                tp1 = round(close_px + (risk * 5.0), 6)
                tp2 = round(close_px + (risk * 8.5), 6)
                tp3 = round(close_px + (risk * 12.0), 6)
        else:
            direction = "SHORT"
            signal_type = "DUMP"
            
            # Risk:Reward math for Short
            if timeframe == "1m":
                risk = min(close_px * 0.008, max(close_px * 0.0025, high_px - close_px))
                stop_loss = round(close_px + risk, 6)
                rr = 2.0
                signal_label = "CONFIRMED SHORT (1M SCALP)"
                tp1 = round(close_px - (risk * 1.2), 6)
                tp2 = round(close_px - (risk * 2.0), 6)
                tp3 = round(close_px - (risk * 2.8), 6)
            elif timeframe == "5m":
                stop_loss = round(high_px * 1.005, 6)
                risk = max(1e-6, stop_loss - close_px)
                rr = 2.8
                signal_label = "CONFIRMED SHORT (5M MOMENTUM)"
                tp1 = round(close_px - (risk * 2.0), 6)
                tp2 = round(close_px - (risk * 3.5), 6)
                tp3 = round(close_px - (risk * 5.0), 6)
            elif timeframe == "15m":
                stop_loss = round(high_px * 1.005, 6)
                risk = max(1e-6, stop_loss - close_px)
                rr = 3.8
                signal_label = "CONFIRMED SHORT (15M INTRADAY)"
                tp1 = round(close_px - (risk * 2.5), 6)
                tp2 = round(close_px - (risk * 4.5), 6)
                tp3 = round(close_px - (risk * 6.5), 6)
            elif timeframe == "1h":
                stop_loss = round(high_px * 1.005, 6)
                risk = max(1e-6, stop_loss - close_px)
                rr = 5.5
                signal_label = "CONFIRMED SHORT (1H HIGH RR SWING)"
                tp1 = round(close_px - (risk * 3.5), 6)
                tp2 = round(close_px - (risk * 6.0), 6)
                tp3 = round(close_px - (risk * 9.0), 6)
            else: # 4h
                stop_loss = round(high_px * 1.005, 6)
                risk = max(1e-6, stop_loss - close_px)
                rr = 8.0
                signal_label = "CONFIRMED SHORT (4H MACRO TREND)"
                tp1 = round(close_px - (risk * 5.0), 6)
                tp2 = round(close_px - (risk * 8.5), 6)
                tp3 = round(close_px - (risk * 12.0), 6)

        rr = reward_ratio_for(timeframe)
        if atr_abs > 0:
            rr_plan = calculate_rr_plan(close_px, atr_abs, direction, reward_ratio=rr)
            stop_loss = round(rr_plan["stop"], 6)
            tp1 = round(rr_plan["target"], 6)
        else:
            stop_distance = abs(close_px - stop_loss)
            tp1 = round(
                close_px + stop_distance * rr
                if direction == "LONG"
                else close_px - stop_distance * rr,
                6,
            )
        tp2 = tp1
        tp3 = tp1
        stop_distance = abs(close_px - stop_loss)
        cost = 2 * float(TRADE_POLICY["taker_fee_per_side"])
        stop_pct = stop_distance / close_px
        target_pct = abs(tp1 - close_px) / close_px
        net_reward = target_pct - cost
        net_risk = stop_pct + cost
        net_rr = net_reward / net_risk if net_risk > 0 else 0.0
        breakeven = (
            net_risk / (net_reward + net_risk)
            if net_reward + net_risk > 0
            else 1.0
        )

        # Format strings
        raw_ts = candle_ts / 1000.0 if candle_ts > 0 else time.time()
        candle_dt = datetime.fromtimestamp(raw_ts)
        timestamp_str = candle_dt.strftime("%I:%M:%S %p")
        candle_at_str = candle_dt.strftime("%b %d, %I:%M:%S %p")

        if candle_vol >= 1_000_000:
            vol_str = f"{candle_vol / 1_000_000:.2f}M USDT"
        elif candle_vol >= 1_000:
            vol_str = f"{candle_vol / 1_000:.2f}K USDT"
        else:
            vol_str = f"{candle_vol:.2f} USDT"

        clean_symbol = buf.symbol.replace("USDT", "")
        formatted_pair = f"{clean_symbol} / USDT"
        tier = evaluation["tier"]
        confirmation_str = f"CONFIRMED ({tf_label} CLOSE)" if is_closed else f"EARLY ({tf_label} ACTIVE)"
        signal_label = signal_label.replace("CONFIRMED", "CONFIRMED" if is_closed else "EARLY")

        policy_snapshot = signal_policy_snapshot(timeframe, sensitivity)
        return {
            "symbol": buf.symbol,
            "pair": formatted_pair,
            "exchange": buf.exchange,
            "timeframe": timeframe,
            "raw_ts": raw_ts,
            "timestamp": timestamp_str,
            "candle_at": candle_at_str,
            "type": signal_type,
            "direction": direction,
            "signal_label": signal_label,
            "confirmation": confirmation_str,
            "tier": tier,
            "score": evaluation["score"],
            "zscore": round(evaluation["z"], 2),
            "change_pct": round(change_pct, 2),
            "amplitude": round(amplitude, 2),
            "open": round(open_px, 6),
            "high": round(high_px, 6),
            "low": round(low_px, 6),
            "close": round(close_px, 6),
            "volume": vol_str,
            "price": round(close_px, 6),
            "vol_spike": round(vol_spike, 1),
            "atr_abs": atr_abs,
            "turnover_24h_usd": buf.volume_24h_usd,
            "rr_ratio": f"1:{rr:.1f}R",
            "entry_price": round(close_px, 6),
            "stop_loss": stop_loss,
            "tp1": tp1,
            "tp2": tp2,
            "tp3": tp3,
            "oi_change_5m": buf.get_oi_change_pct(300),
            "funding_rate": buf.funding_rate,
            "policy_version": policy_snapshot["policy_version"],
            "policy_snapshot": policy_snapshot,
            "reward_ratio": rr,
            "cost_fraction": cost,
            "net_reward": net_reward,
            "net_risk": net_risk,
            "net_rr": net_rr,
            "breakeven_win_rate": breakeven,
        }

    def _update_lifecycles_for_buffer(self, buf, timeframe: str, now: float):
        candles = buf.get_aggregated_candles(timeframe)
        candles_by_time = {int(item.get("time", 0)): item for item in candles}
        market_price = buf.latest_tick_price or (float(candles[-1]["close"]) if candles else 0.0)

        with self._lock:
            for signal in self._signals:
                if (
                    signal.get("exchange") != buf.exchange
                    or signal.get("symbol") != buf.symbol
                    or signal.get("timeframe", "1m") != timeframe
                    or signal.get("lifecycle_status") in TERMINAL_STATES
                ):
                    continue

                status = signal.get("lifecycle_status")
                if not status:
                    status = "confirmed" if signal.get("tier") == "confirmed" else "confirming"
                    signal["lifecycle_status"] = status

                if status == "confirming":
                    candle = candles_by_time.get(int(signal.get("raw_ts", 0)))
                    buf_candles = getattr(buf, "candles", None)
                    curr_c = buf_candles[-1] if buf_candles else None
                    if curr_c:
                        is_c_closed = getattr(curr_c, "closed", curr_c.get("closed", False) if isinstance(curr_c, dict) else False)
                        c_ts = getattr(curr_c, "ts", curr_c.get("time", 0) * 1000 if isinstance(curr_c, dict) else 0)
                        if not is_c_closed and int(c_ts) == int(signal.get("raw_ts", 0)):
                            curr_open = float(getattr(curr_c, "open", curr_c.get("open", 0) if isinstance(curr_c, dict) else 0) or 0)
                            curr_px = market_price or float(getattr(curr_c, "close", curr_c.get("close", 0) if isinstance(curr_c, dict) else 0) or 0)
                            if curr_open > 0:
                                live_move = ((curr_px - curr_open) / curr_open) * 100
                                thresh = float(signal.get("trigger_sensitivity", 0.5))
                                if (signal.get("type") == "PUMP" and live_move < thresh * 0.3) or (
                                    signal.get("type") == "DUMP" and live_move > -thresh * 0.3
                                ):
                                    self._transition(
                                        signal,
                                        "invalidated",
                                        "Move faded while forming",
                                        now,
                                    )
                                    continue

                    if candle and candle.get("closed", False):
                        result = self._evaluate_candle(
                            buf,
                            candle,
                            float(signal.get("trigger_sensitivity", 0.5)),
                            timeframe=timeframe,
                        )
                        if result and result.get("type") == signal.get("type"):
                            self._transition(
                                signal,
                                "confirmed",
                                "Signal confirmed",
                                now,
                                {
                                    **result,
                                    "id": signal["id"],
                                    "event_id": signal.get("event_id"),
                                    "dedupe_key": signal.get("dedupe_key"),
                                    "trigger_sensitivity": signal.get("trigger_sensitivity"),
                                    "trigger_reward_ratio": signal.get("trigger_reward_ratio"),
                                    "confirmed_ts": now,
                                    "expires_ts": None,
                                },
                            )
                        else:
                            self._transition(
                                signal,
                                "invalidated",
                                "Trigger failed candle-close confirmation",
                                now,
                            )
                    elif now - float(signal.get("raw_ts", now)) > (
                        timeframe_minutes(timeframe) * 60 + 30
                    ):
                        self._transition(
                            signal,
                            "invalidated",
                            "Confirmation candle unavailable",
                            now,
                        )

                if signal.get("lifecycle_status") == "confirmed":
                    observation = (
                        MarketObservation(
                            price=market_price,
                            event_ts_ms=int(getattr(buf, "last_tick_ts_ms", 0) or now * 1000),
                        )
                        if market_price > 0
                        else None
                    )
                    decision = evaluate_observation(signal, observation, int(now * 1000))
                    if decision:
                        reason = (
                            "TP1 reached"
                            if decision["status"] == "target_hit"
                            else decision["reason"]
                        )
                        self._transition(
                            signal,
                            decision["status"],
                            reason,
                            decision["event_ts_ms"] / 1000,
                            outcome=decision,
                        )

    def _history_before(self, buf, timeframe: str, candidate_ts: int) -> List[Dict]:
        candles = buf.get_aggregated_candles(timeframe)
        history = []
        for item in candles:
            open_time = int(_float_or_zero(item.get("time"))) * 1000
            if open_time >= candidate_ts or not item.get("closed", True):
                continue
            close = _float_or_zero(item.get("close"))
            volume = _float_or_zero(item.get("volume"))
            quote_volume = _float_or_zero(item.get("quote_volume"))
            history.append({
                "open_time": open_time,
                "open": _float_or_zero(item.get("open")),
                "high": _float_or_zero(item.get("high")),
                "low": _float_or_zero(item.get("low")),
                "close": close,
                "usd_vol": quote_volume if quote_volume > 0 else (volume * close if volume > 0 else 0.0),
                "trades": _positive_int(item.get("trades_count")),
                "closed": True,
                "elapsed_frac": 1.0,
            })
        return history

    def add_signal_from_buffer(
        self,
        buf,
        sensitivity: float = 1.0,
        timeframe: str = "1m",
    ) -> Optional[Dict]:
        """Evaluates buffer for a specific timeframe with strict multi-factor confirmation."""
        now = time.time()
        buf_key = f"{buf.exchange}:{buf.symbol}:{timeframe}"
        self._update_lifecycles_for_buffer(buf, timeframe, now)

        if not buf.candles:
            return None

        candidate = None
        if timeframe == "1m":
            # Prefer an active candle once it has enough elapsed data for an early signal.
            curr_c = buf.candles[-1]
            elapsed_sec = (int(now * 1000) - curr_c.ts) / 1000.0
            if curr_c.closed or elapsed_sec >= 12.0:
                candidate = curr_c

            # During the first seconds of a new candle, confirm the one that just closed.
            if not candidate and len(buf.candles) >= 2 and buf.candles[-2].closed:
                prev_c = buf.candles[-2]
                if (now - (prev_c.ts / 1000.0)) <= 120.0:
                    candidate = prev_c
        else:
            # Multi-timeframe aggregated candles
            agg = buf.get_aggregated_candles(timeframe)
            if agg:
                candidate = agg[-1]

        if not candidate:
            return None

        eval_result = self._evaluate_candle(
            buf,
            candidate,
            sensitivity,
            timeframe=timeframe,
        )
        if not eval_result:
            return None

        cand_ts = candidate.get("time", 0) * 1000 if isinstance(candidate, dict) else candidate.ts
        normalized_candle = {"open_time": cand_ts}
        c_key = dedupe_key(buf_key, timeframe, normalized_candle, eval_result["type"].lower())

        with self._lock:
            existing_id = self._signal_ids.get(c_key)
            if existing_id is not None:
                for index, existing in enumerate(self._signals):
                    if existing["id"] == existing_id:
                        if existing.get("lifecycle_status") in TERMINAL_STATES:
                            return None
                        return None
                return None

            eval_result["id"] = self._next_id
            eval_result["lifecycle_status"] = "confirmed" if eval_result["tier"] == "confirmed" else "confirming"
            eval_result["outcome"] = "Signal confirmed" if eval_result["tier"] == "confirmed" else "Confirming once on candle close"
            eval_result["trigger_sensitivity"] = sensitivity
            eval_result["trigger_reward_ratio"] = reward_ratio_for(timeframe)
            eval_result["confirmed_ts"] = now if eval_result["tier"] == "confirmed" else None
            eval_result["expires_ts"] = None
            for active in self._signals:
                if (
                    active.get("exchange") == buf.exchange
                    and active.get("symbol") == buf.symbol
                    and active.get("timeframe", "1m") == timeframe
                    and active.get("lifecycle_status") not in TERMINAL_STATES
                ):
                    self._transition(
                        active,
                        "invalidated",
                        "Replaced by a newer signal",
                        now,
                    )
            eval_result["event_id"] = str(uuid.uuid4())
            eval_result["dedupe_key"] = c_key
            eval_result["created_ts"] = now
            self._signal_ids[c_key] = self._next_id
            self._next_id += 1
            self._signals.append(eval_result)
            self._persist_created_signal(eval_result, c_key, now)
            if len(self._signals) > self.max_history:
                self._signals.pop(0)

            self._last_event_time = eval_result["timestamp"]
            self._last_event_ts = int(now * 1000)
            if eval_result["type"] == "PUMP":
                self.pumps_count += 1
            else:
                self.dumps_count += 1

            return eval_result

    def seed_history_from_buffer(self, buf, sensitivity: float = 0.8):
        """Backfills verified past signals across timeframes (1m, 5m, 15m, 1h) into History."""
        if not buf.candles or len(buf.candles) < 2:
            return

        now = time.time()

        # Seed 1m historical signals
        for candle in list(buf.candles)[:-1]:
            if not candle.closed:
                continue
            candle_age_sec = now - (candle.ts / 1000.0)
            if candle_age_sec > 3600:  # Within last 1 hour
                continue

            c_key = f"{buf.exchange}:{buf.symbol}:1m:{candle.ts}"
            with self._lock:
                if c_key in self._seen_candle_keys:
                    continue

            eval_res = self._evaluate_candle(buf, candle, sensitivity, timeframe="1m")
            if eval_res:
                signal_key = dedupe_key(
                    f"{buf.exchange}:{buf.symbol}:1m",
                    "1m",
                    {"open_time": candle.ts},
                    eval_res["type"].lower(),
                )
                with self._lock:
                    if c_key in self._seen_candle_keys or signal_key in self._signal_ids:
                        continue
                    self._seen_candle_keys.add(c_key)
                    eval_res["id"] = self._next_id
                    eval_res["lifecycle_status"] = "expired"
                    eval_res["outcome"] = "Historical signal"
                    eval_res["finalized_ts"] = now
                    self._signal_ids[signal_key] = self._next_id
                    self._next_id += 1
                    self._signals.append(eval_res)
                    self._persist_created_signal(eval_res, signal_key, now)

        # Seed 5m and 15m historical signals
        for tf in ["5m", "15m", "1h"]:
            agg = buf.get_aggregated_candles(tf)
            if len(agg) >= 2:
                for cand in agg[:-1]: # Closed multi-tf candles
                    c_time = cand.get("time", 0) * 1000
                    c_key = f"{buf.exchange}:{buf.symbol}:{tf}:{c_time}"
                    with self._lock:
                        if c_key in self._seen_candle_keys:
                            continue
                    eval_res = self._evaluate_candle(buf, cand, sensitivity, timeframe=tf)
                    if eval_res:
                        signal_key = dedupe_key(
                            f"{buf.exchange}:{buf.symbol}:{tf}",
                            tf,
                            {"open_time": c_time},
                            eval_res["type"].lower(),
                        )
                        with self._lock:
                            if c_key in self._seen_candle_keys or signal_key in self._signal_ids:
                                continue
                            self._seen_candle_keys.add(c_key)
                            eval_res["id"] = self._next_id
                            eval_res["lifecycle_status"] = "expired"
                            eval_res["outcome"] = "Historical signal"
                            eval_res["finalized_ts"] = now
                            self._signal_ids[signal_key] = self._next_id
                            self._next_id += 1
                            self._signals.append(eval_res)
                            self._persist_created_signal(eval_res, signal_key, now)

    def get_stats(self, sensitivity: float, total_monitored: int, timeframe: str = "1m") -> Dict:
        now = time.time()
        with self._lock:
            active_signals = [
                s for s in self._signals
                if s.get("lifecycle_status") in {"confirming", "confirmed"}
                and abs(s["change_pct"]) >= sensitivity
                and s.get("timeframe", "1m") == timeframe
            ]
            pumps_crossing = sum(1 for s in active_signals if s["type"] == "PUMP")
            dumps_crossing = sum(1 for s in active_signals if s["type"] == "DUMP")

            return {
                "monitored": total_monitored,
                "stream_batches": "5 / 5",
                "timeframe": timeframe,
                "last_event": self._last_event_time,
                "last_event_ts": self._last_event_ts,
                "crossing_now": len(active_signals),
                "pumps": pumps_crossing,
                "dumps": dumps_crossing
            }

    def get_signals(self, sensitivity: float = 1.0, view: str = "live", timeframe: str = "1m") -> List[Dict]:
        now = time.time()
        with self._lock:
            matched = [
                s for s in self._signals
                if abs(s["change_pct"]) >= sensitivity
                and s.get("timeframe", "1m") == timeframe
            ]

            if view == "live":
                return [
                    s for s in reversed(matched)
                    if s.get("lifecycle_status") in {"confirming", "confirmed"}
                ]
            else:
                return [
                    s for s in reversed(matched)
                    if s.get("lifecycle_status") in TERMINAL_STATES
                ]

from app.storage import get_signal_repository


pump_dump_tracker = PumpDumpTracker(store=get_signal_repository())
