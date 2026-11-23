import unittest

from app.engine.trade_math import calculate_rr_plan


class TradeMathTests(unittest.TestCase):
    def test_cost_adjusted_rr_fixture(self):
        plan = calculate_rr_plan(
            entry=100,
            atr_abs=0.30,
            side="LONG",
            reward_ratio=2,
            spread=0.0004,
            taker_fee=0.00055,
        )

        self.assertAlmostEqual(plan["stop"], 99.64, places=6)
        self.assertAlmostEqual(plan["target"], 100.72, places=6)
        self.assertAlmostEqual(plan["net_reward"], 0.0057, places=6)
        self.assertAlmostEqual(plan["net_risk"], 0.0051, places=6)
        self.assertAlmostEqual(plan["net_rr"], 1.117647, places=6)
        self.assertAlmostEqual(plan["breakeven_win_rate"], 0.472222, places=6)
        self.assertTrue(plan["flagged"])


if __name__ == "__main__":
    unittest.main()
