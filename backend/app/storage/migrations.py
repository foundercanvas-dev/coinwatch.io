MIGRATIONS = [
    (
        1,
        [
            """
            CREATE TABLE signal_events (
                event_id TEXT PRIMARY KEY,
                local_id INTEGER NOT NULL UNIQUE,
                dedupe_key TEXT NOT NULL UNIQUE,
                exchange TEXT NOT NULL,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                candle_ts_ms INTEGER NOT NULL,
                direction TEXT NOT NULL,
                created_ts_ms INTEGER NOT NULL,
                policy_version TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """,
            """
            CREATE INDEX signal_events_market_time
            ON signal_events(exchange, symbol, timeframe, candle_ts_ms)
            """,
            """
            CREATE TABLE signal_transitions (
                transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL REFERENCES signal_events(event_id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                event_ts_ms INTEGER NOT NULL,
                reason TEXT NOT NULL,
                patch_json TEXT NOT NULL,
                UNIQUE(event_id, status, event_ts_ms, reason)
            )
            """,
            """
            CREATE INDEX signal_transitions_event_time
            ON signal_transitions(event_id, event_ts_ms, transition_id)
            """,
            """
            CREATE TABLE signal_outcomes (
                event_id TEXT PRIMARY KEY REFERENCES signal_events(event_id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                event_ts_ms INTEGER NOT NULL,
                trigger_price REAL,
                gross_r REAL,
                net_r REAL,
                cost_fraction REAL NOT NULL DEFAULT 0,
                reason TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE market_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                exchange TEXT NOT NULL,
                symbol TEXT NOT NULL,
                event_type TEXT NOT NULL,
                exchange_ts_ms INTEGER NOT NULL,
                received_ts_ms INTEGER NOT NULL,
                sequence TEXT,
                payload_json TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE feed_health (
                exchange TEXT PRIMARY KEY,
                updated_ts_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE candles (
                exchange TEXT NOT NULL,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                open_ts_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY(exchange, symbol, timeframe, open_ts_ms)
            )
            """,
            """
            CREATE TABLE feature_snapshots (
                event_id TEXT PRIMARY KEY REFERENCES signal_events(event_id) ON DELETE CASCADE,
                schema_version TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE model_registry (
                model_version TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                created_ts_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE research_runs (
                run_id TEXT PRIMARY KEY,
                created_ts_ms INTEGER NOT NULL,
                input_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """,
        ],
    )
]
