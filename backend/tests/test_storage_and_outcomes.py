import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.engine.outcomes import (
    MarketObservation,
    evaluate_barrier_range,
    evaluate_observation,
)
from app.engine.pump_dump_tracker import PumpDumpTracker
from app.storage.database import Database
from app.storage.repository import SignalRepository
from app.storage.writer import BatchWriter, WriteItem


class PersistentBuffer:
    exchange = "binance"
    symbol = "TESTUSDT"
    volume_24h_usd = 10_000_000
    funding_rate = 0.0

    def __init__(self):
        self.candles = [SimpleNamespace(ts=60_000, closed=True)]
        self.latest_tick_price = 100.0
        self.last_tick_ts_ms = int(time.time() * 1000)

    def get_aggregated_candles(self, timeframe):
        return []


class StorageAndOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.database = Database(str(Path(self.tempdir.name) / "research.db"))
        self.database.migrate()
        self.repository = SignalRepository(self.database)

    def tearDown(self):
        self.database.close()
        self.tempdir.cleanup()

    def test_migrations_enable_wal_and_create_research_tables(self):
        connection = self.database.connect()
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertEqual(journal_mode.lower(), "wal")
        self.assertTrue(
            {
                "signal_events",
                "signal_transitions",
                "signal_outcomes",
                "market_events",
                "feature_snapshots",
                "model_registry",
                "research_runs",
            }.issubset(tables)
        )

    def test_tracker_recovers_signal_and_terminal_outcome(self):
        buffer = PersistentBuffer()
        tracker = PumpDumpTracker(store=self.repository)
        evaluation = {
            "type": "PUMP",
            "direction": "LONG",
            "tier": "confirmed",
            "score": 75,
            "timestamp": "12:00:00 PM",
            "exchange": buffer.exchange,
            "symbol": buffer.symbol,
            "timeframe": "1m",
            "raw_ts": 60.0,
            "entry_price": 100.0,
            "stop_loss": 99.0,
            "tp1": 101.5,
            "reward_ratio": 1.5,
            "net_rr": 1.3,
            "cost_fraction": 0.0011,
            "change_pct": 2.0,
            "policy_version": "1.0.0",
        }
        tracker._evaluate_candle = lambda *args, **kwargs: dict(evaluation)

        created = tracker.add_signal_from_buffer(buffer, sensitivity=0.4, timeframe="1m")
        self.assertIsNotNone(created)
        event_id = created["event_id"]

        recovered = PumpDumpTracker(store=self.repository)
        self.assertEqual(len(recovered._signals), 1)
        self.assertEqual(recovered._signals[0]["event_id"], event_id)
        self.assertEqual(recovered._signals[0]["lifecycle_status"], "confirmed")

        buffer.latest_tick_price = 101.6
        buffer.last_tick_ts_ms += 1
        recovered._update_lifecycles_for_buffer(buffer, "1m", time.time())
        restarted = PumpDumpTracker(store=self.repository)
        self.assertEqual(restarted._signals[0]["lifecycle_status"], "target_hit")
        outcome = self.repository.get_outcome(event_id)
        self.assertEqual(outcome["status"], "target_hit")
        self.assertEqual(outcome["gross_r"], 1.5)
        self.assertEqual(outcome["net_r"], 1.3)

    def test_ordered_outcome_rejects_stale_events_and_expires_before_late_tick(self):
        now_ms = int(time.time() * 1000)
        signal = {
            "lifecycle_status": "confirmed",
            "direction": "LONG",
            "stop_loss": 99,
            "tp1": 102,
            "reward_ratio": 2,
            "net_rr": 1.7,
            "cost_fraction": 0.0011,
            "expires_ts": (now_ms + 5_000) / 1000,
            "_last_market_event_ts_ms": now_ms,
            "_last_market_sequence": 10,
        }
        stale = evaluate_observation(
            signal,
            MarketObservation(price=102.5, event_ts_ms=now_ms, sequence=9),
            now_ms,
        )
        self.assertIsNone(stale)

        late = evaluate_observation(
            signal,
            MarketObservation(price=102.5, event_ts_ms=now_ms + 6_000, sequence=11),
            now_ms + 6_000,
        )
        self.assertEqual(late["status"], "expired")

    def test_unordered_bar_crossing_both_levels_is_ambiguous(self):
        decision = evaluate_barrier_range(
            {
                "direction": "LONG",
                "stop_loss": 99,
                "tp1": 102,
                "cost_fraction": 0.0011,
            },
            low=98.5,
            high=102.5,
            event_ts_ms=123,
        )
        self.assertEqual(decision["status"], "ambiguous")
        self.assertIsNone(decision["net_r"])

    def test_batch_writer_flushes_partial_batch_on_shutdown(self):
        received = []
        flushed = threading.Event()

        def handler(items):
            received.extend(items)
            flushed.set()

        writer = BatchWriter(handler, max_batch=10, flush_interval=0.01)
        writer.start()
        self.assertTrue(writer.submit(WriteItem("signal", {"id": 1}, high_priority=True)))
        writer.close()
        self.assertTrue(flushed.wait(1))
        self.assertEqual([item.payload for item in received], [{"id": 1}])


if __name__ == "__main__":
    unittest.main()
