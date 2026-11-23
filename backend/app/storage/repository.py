import json
from copy import deepcopy
from typing import Dict, List, Optional

from app.storage.database import Database


def _json(value: Dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class SignalRepository:
    def __init__(self, database: Database):
        self.database = database

    def create_signal(self, signal: Dict, dedupe_key: str) -> bool:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO signal_events(
                    event_id, local_id, dedupe_key, exchange, symbol, timeframe,
                    candle_ts_ms, direction, created_ts_ms, policy_version, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    signal["event_id"],
                    int(signal["id"]),
                    dedupe_key,
                    signal["exchange"],
                    signal["symbol"],
                    signal["timeframe"],
                    int(float(signal.get("raw_ts", 0)) * 1000),
                    signal["direction"],
                    int(float(signal.get("created_ts", 0)) * 1000),
                    signal.get("policy_version", "unknown"),
                    _json(signal),
                ),
            )
            return cursor.rowcount == 1

    def append_transition(
        self,
        event_id: str,
        status: str,
        event_ts_ms: int,
        reason: str,
        patch: Dict,
    ) -> bool:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO signal_transitions(
                    event_id, status, event_ts_ms, reason, patch_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (event_id, status, int(event_ts_ms), reason, _json(patch)),
            )
            return cursor.rowcount == 1

    def record_outcome(self, event_id: str, outcome: Dict) -> bool:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO signal_outcomes(
                    event_id, status, event_ts_ms, trigger_price, gross_r,
                    net_r, cost_fraction, reason, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    outcome["status"],
                    int(outcome["event_ts_ms"]),
                    outcome.get("trigger_price"),
                    outcome.get("gross_r"),
                    outcome.get("net_r"),
                    float(outcome.get("cost_fraction", 0)),
                    outcome.get("reason", ""),
                    _json(outcome),
                ),
            )
            return cursor.rowcount == 1

    def load_signals(self, limit: int = 500) -> List[Dict]:
        connection = self.database.connect()
        event_rows = connection.execute(
            """
            SELECT event_id, dedupe_key, payload_json
            FROM signal_events
            ORDER BY local_id DESC
            LIMIT ?
            """,
            (int(limit),),
        ).fetchall()
        loaded: List[Dict] = []
        for event_row in reversed(event_rows):
            signal = json.loads(event_row["payload_json"])
            signal["event_id"] = event_row["event_id"]
            signal["dedupe_key"] = event_row["dedupe_key"]
            transition_rows = connection.execute(
                """
                SELECT patch_json
                FROM signal_transitions
                WHERE event_id = ?
                ORDER BY event_ts_ms, transition_id
                """,
                (event_row["event_id"],),
            ).fetchall()
            for transition in transition_rows:
                signal.update(json.loads(transition["patch_json"]))
            loaded.append(deepcopy(signal))
        return loaded

    def get_outcome(self, event_id: str) -> Optional[Dict]:
        row = self.database.connect().execute(
            "SELECT payload_json FROM signal_outcomes WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        return json.loads(row["payload_json"]) if row else None
