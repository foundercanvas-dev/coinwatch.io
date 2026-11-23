import unittest

from app.engine.signal_math import SCALP_PARAMS, dedupe_key, evaluate_signal, scale_threshold


def baseline(count=30):
    return [
        {
            "open_time": index * 60_000,
            "open": 100 + index * 0.001,
            "high": 100.1 + index * 0.001,
            "low": 99.9 + index * 0.001,
            "close": 100 + index * 0.001,
            "usd_vol": 10_000,
            "trades": 20,
            "closed": True,
            "elapsed_frac": 1,
        }
        for index in range(count)
    ]


class SignalMathTests(unittest.TestCase):
    def test_strong_confirmed_pump_passes_all_gates(self):
        history = baseline()
        previous_close = history[-1]["close"]
        candle = {
            "open_time": 31 * 60_000,
            "open": previous_close,
            "high": previous_close * 1.025,
            "low": previous_close * 0.999,
            "close": previous_close * 1.02,
            "usd_vol": 30_000,
            "trades": 30,
            "closed": True,
            "elapsed_frac": 1,
        }
        result = evaluate_signal(
            candle,
            history,
            {"turnover_24h_usd": 10_000_000, "threshold_pct": 0.015},
        )

        self.assertTrue(result["pass"], result["reasons"])
        self.assertEqual(result["side"], "pump")
        self.assertEqual(result["tier"], "confirmed")
        self.assertGreaterEqual(result["rel_vol"], 3)
        self.assertGreater(result["score"], 0)

    def test_low_activity_move_reports_failed_gates(self):
        history = baseline()
        previous_close = history[-1]["close"]
        candle = {
            "open_time": 31 * 60_000,
            "open": previous_close,
            "high": previous_close * 1.021,
            "low": previous_close,
            "close": previous_close * 1.02,
            "usd_vol": 1_000,
            "trades": 2,
            "closed": False,
            "elapsed_frac": 0.5,
        }
        result = evaluate_signal(
            candle,
            history,
            {"turnover_24h_usd": 100_000, "threshold_pct": 0.015},
            {"min_24h_usd": 500_000, "min_candle_usd": 5_000, "min_trades": 5},
        )

        self.assertFalse(result["pass"])
        self.assertIn("24h turnover too low", result["reasons"])
        self.assertIn("candle volume too low", result["reasons"])
        self.assertIn("too few trades", result["reasons"])

    def test_dedupe_and_threshold_helpers(self):
        candle = {"open_time": 1234}
        self.assertEqual(dedupe_key("BTCUSDT", "5m", candle, "pump"), "BTCUSDT:5m:1234:pump")
        self.assertAlmostEqual(scale_threshold(0.01, 4), 0.02)

    def test_zero_volume_move_is_rejected(self):
        history = baseline()
        candle = {
            "open_time": 31 * 60_000,
            "open": 0.24785,
            "high": 0.27199,
            "low": 0.2473,
            "close": 0.27199,
            "usd_vol": 0,
            "trades": 20,
            "closed": True,
            "elapsed_frac": 1,
        }
        result = evaluate_signal(
            candle,
            history,
            {"turnover_24h_usd": 10_000_000, "threshold_pct": 0.005},
            {**SCALP_PARAMS, "min_candle_usd": 5_000},
        )

        self.assertFalse(result["pass"])
        self.assertIn("candle volume too low", result["reasons"])

    def test_liquid_six_x_volume_move_passes(self):
        history = baseline()
        previous_close = history[-1]["close"]
        candle = {
            "open_time": 31 * 60_000,
            "open": previous_close,
            "high": previous_close * 1.019,
            "low": previous_close,
            "close": previous_close * 1.018,
            "usd_vol": 60_000,
            "trades": 40,
            "closed": True,
            "elapsed_frac": 1,
        }
        result = evaluate_signal(
            candle,
            history,
            {"turnover_24h_usd": 10_000_000, "threshold_pct": 0.015},
            SCALP_PARAMS,
        )
        self.assertTrue(result["pass"], result["reasons"])

    def test_volatile_coin_move_is_not_significant(self):
        history = []
        price = 100.0
        for index in range(61):
            price *= 1.01 if index % 2 == 0 else 0.99
            history.append(
                {
                    "open_time": index * 60_000,
                    "open": price,
                    "high": price * 1.002,
                    "low": price * 0.998,
                    "close": price,
                    "usd_vol": 10_000,
                    "trades": 20,
                    "closed": True,
                    "elapsed_frac": 1,
                }
            )
        previous_close = history[-1]["close"]
        candle = {
            "open_time": 62 * 60_000,
            "open": previous_close,
            "high": previous_close * 1.017,
            "low": previous_close,
            "close": previous_close * 1.016,
            "usd_vol": 60_000,
            "trades": 40,
            "closed": True,
            "elapsed_frac": 1,
        }
        result = evaluate_signal(
            candle,
            history,
            {"turnover_24h_usd": 10_000_000, "threshold_pct": 0.015},
            SCALP_PARAMS,
        )
        self.assertFalse(result["pass"])
        self.assertTrue(any("not significant" in reason for reason in result["reasons"]))


if __name__ == "__main__":
    unittest.main()
