import time
import unittest

from app.engine.pump_dump_tracker import PumpDumpTracker


class FakeBuffer:
    exchange = "binance"
    symbol = "TESTUSDT"
    latest_tick_price = 100.0
    volume_24h_usd = 10_000_000
    funding_rate = 0.0

    def __init__(self, candles):
        self._candles = candles

    def get_aggregated_candles(self, timeframe):
        return self._candles

    def get_oi_change_pct(self, seconds):
        return 0.0


class PumpDumpLifecycleTests(unittest.TestCase):
    def test_one_minute_scalp_caps_wick_risk(self):
        now = int(time.time())
        history = [
            {
                "time": now - (31 - index) * 60,
                "open": 100,
                "high": 100.1,
                "low": 99.9,
                "close": 100,
                "volume": 100,
                "quote_volume": 10_000,
                "trades_count": 20,
                "closed": True,
            }
            for index in range(30)
        ]
        candidate = {
            "time": now,
            "open": 100,
            "high": 105,
            "low": 94,
            "close": 95,
            "volume": 400,
            "quote_volume": 40_000,
            "trades_count": 40,
            "closed": False,
        }
        tracker = PumpDumpTracker()
        signal = tracker._evaluate_candle(
            FakeBuffer([*history, candidate]),
            candidate,
            sensitivity=0.5,
            timeframe="1m",
        )
        self.assertIsNotNone(signal)
        self.assertEqual(signal["direction"], "SHORT")
        self.assertLessEqual(signal["stop_loss"] - signal["entry_price"], 95 * 0.008 + 1e-6)
        risk = signal["stop_loss"] - signal["entry_price"]
        self.assertEqual(signal["reward_ratio"], 1.5)
        self.assertAlmostEqual(signal["entry_price"] - signal["tp2"], risk * 1.5, places=5)

    def test_confirmed_scalp_expires_once(self):
        now = time.time()
        tracker = PumpDumpTracker()
        tracker._signals = [
            {
                "id": 1,
                "exchange": "binance",
                "symbol": "TESTUSDT",
                "timeframe": "1m",
                "lifecycle_status": "confirmed",
                "direction": "LONG",
                "stop_loss": 90,
                "tp1": 110,
                "expires_ts": now - 1,
                "raw_ts": now - 60,
            }
        ]
        tracker._update_lifecycles_for_buffer(FakeBuffer([]), "1m", now)
        self.assertEqual(tracker._signals[0]["lifecycle_status"], "expired")
        self.assertEqual(tracker._signals[0]["outcome"], "Scalp window expired")

    def test_missing_trade_count_is_rejected_without_crashing(self):
        now = int(time.time())
        history = [
            {
                "time": now - (31 - index) * 60,
                "open": 100,
                "high": 100.1,
                "low": 99.9,
                "close": 100,
                "volume": 100,
                "quote_volume": 10_000,
                "trades_count": 20,
                "closed": True,
            }
            for index in range(30)
        ]
        candidate = {
            "time": now,
            "open": 100,
            "high": 102.1,
            "low": 100,
            "close": 102,
            "volume": 400,
            "quote_volume": 40_000,
            "trades_count": None,
            "closed": False,
        }
        tracker = PumpDumpTracker()
        signal = tracker._evaluate_candle(
            FakeBuffer([*history, candidate]),
            candidate,
            sensitivity=0.5,
            timeframe="1m",
        )
        self.assertIsNone(signal)

    def test_missing_history_volume_is_treated_as_missing_evidence(self):
        now = int(time.time())
        history = [
            {
                "time": now - (31 - index) * 60,
                "open": 100,
                "high": 100.1,
                "low": 99.9,
                "close": 100,
                "volume": None,
                "quote_volume": None,
                "trades_count": 20,
                "closed": True,
            }
            for index in range(30)
        ]
        candidate = {
            "time": now,
            "open": 100,
            "high": 102.1,
            "low": 100,
            "close": 102,
            "volume": None,
            "quote_volume": None,
            "trades_count": 20,
            "closed": False,
        }
        tracker = PumpDumpTracker()
        signal = tracker._evaluate_candle(
            FakeBuffer([*history, candidate]),
            candidate,
            sensitivity=0.5,
            timeframe="1m",
        )
        self.assertIsNone(signal)

    def test_failed_close_moves_confirming_event_to_history_state(self):
        now = int(time.time())
        quiet_candles = [
            {
                "time": now - (31 - index) * 60,
                "open": 100,
                "high": 100.01,
                "low": 99.99,
                "close": 100,
                "volume": 1,
                "quote_volume": 100,
                "trades_count": 1,
                "closed": True,
            }
            for index in range(31)
        ]
        signal_time = quiet_candles[-1]["time"]
        tracker = PumpDumpTracker()
        tracker._signals = [
            {
                "id": 1,
                "exchange": "binance",
                "symbol": "TESTUSDT",
                "timeframe": "1m",
                "lifecycle_status": "confirming",
                "direction": "LONG",
                "type": "PUMP",
                "raw_ts": signal_time,
                "trigger_sensitivity": 0.5,
            }
        ]
        tracker._update_lifecycles_for_buffer(FakeBuffer(quiet_candles), "1m", now)
        self.assertEqual(tracker._signals[0]["lifecycle_status"], "invalidated")
        self.assertIn("failed", tracker._signals[0]["outcome"].lower())


if __name__ == "__main__":
    unittest.main()
