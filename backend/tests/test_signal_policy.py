import unittest
from types import SimpleNamespace

from app.engine.policy import (
    POLICY_VERSION,
    SIGNAL_POLICY,
    reward_ratio_for,
    timeframe_minutes,
    ttl_seconds_for,
)
from app.engine.pump_dump_tracker import PumpDumpTracker


class MinimalBuffer:
    exchange = "binance"
    symbol = "TESTUSDT"
    latest_tick_price = 100.0
    volume_24h_usd = 10_000_000
    funding_rate = 0.0

    def __init__(self):
        self.candles = [SimpleNamespace(ts=60_000, closed=True)]

    def get_aggregated_candles(self, timeframe):
        return []


class SignalPolicyTests(unittest.TestCase):
    def test_timeframe_contract_is_complete(self):
        self.assertEqual(POLICY_VERSION, "1.0.0")
        self.assertEqual(set(SIGNAL_POLICY["timeframes"]), {"1m", "5m", "15m", "1h", "4h"})
        self.assertEqual(timeframe_minutes("4h"), 240)
        self.assertEqual(reward_ratio_for("1m"), 1.5)
        self.assertEqual(reward_ratio_for("4h"), 6.0)
        self.assertEqual(ttl_seconds_for("1m"), 60)

    def test_existing_signal_policy_snapshot_is_not_overwritten(self):
        tracker = PumpDumpTracker()
        buffer = MinimalBuffer()
        evaluation = {
            "type": "PUMP",
            "tier": "confirmed",
            "score": 72,
            "timestamp": "12:00:00 PM",
            "exchange": buffer.exchange,
            "symbol": buffer.symbol,
            "timeframe": "1m",
        }
        tracker._evaluate_candle = lambda *args, **kwargs: dict(evaluation)

        created = tracker.add_signal_from_buffer(buffer, sensitivity=0.4, timeframe="1m")
        self.assertIsNotNone(created)
        self.assertEqual(created["trigger_reward_ratio"], 1.5)

        evaluation["score"] = 99
        duplicate = tracker.add_signal_from_buffer(buffer, sensitivity=2.0, timeframe="1m")
        self.assertIsNone(duplicate)
        self.assertEqual(tracker._signals[0]["score"], 72)
        self.assertEqual(tracker._signals[0]["trigger_sensitivity"], 0.4)
        self.assertEqual(tracker._signals[0]["trigger_reward_ratio"], 1.5)


if __name__ == "__main__":
    unittest.main()
