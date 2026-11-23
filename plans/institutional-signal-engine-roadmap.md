# Coinwatch Institutional Signal Engine Roadmap

## Objective

Upgrade the existing React/Vite + FastAPI perpetual scanner from a robust anomaly detector into a self-contained, reproducible research and shadow-trading platform that can estimate:

> The calibrated probability that a cost-adjusted target is reached before a cost-adjusted stop, conditioned on market regime, liquidity, order flow, and cross-venue evidence.

The implementation must improve statistical validity without claiming guaranteed accuracy. It must remain usable before a trained model exists by keeping a deterministic statistical baseline and an explicit `NO_TRADE`/abstain outcome.

## Fixed decisions

- Use a self-contained SQLite database in WAL mode at `backend/data/coinwatch.db`.
- Add `backend/data/` to `.gitignore`; never commit runtime market data or trained artifacts.
- Use Python's standard `sqlite3` and existing NumPy dependency; do not add a heavy ML framework initially.
- Keep FastAPI as the backend and the existing React/Vite frontend.
- The backend is authoritative for signal policy, event identity, feature snapshots, lifecycle, outcomes, and model versions.
- Use one canonical shared policy file at `config/signal_policy.json`, imported by Python and JavaScript.
- Raw market events use exchange/event timestamps plus local receive timestamps.
- Signals and transitions are append-only. Core signal configuration and feature snapshots are immutable.
- Use ordered tick/trade events for TP/SL outcomes. If ordering cannot be established, label the result `ambiguous`; never assume a win.
- The first model is transparent L2-regularized logistic regression with deterministic training, probability calibration, and abstention.
- Roll out in shadow mode. A trained model may annotate/rank signals but cannot gate production signals until validation gates pass.
- No auto-trading or order placement is added in this roadmap.
- Existing upstream HTTP 520 restrictions are treated as an environment limitation; replay fixtures provide deterministic verification.

## Success criteria

1. A signal has one immutable configuration snapshot, feature snapshot, policy version, and model version.
2. Background scanning, REST queries, browser fallback, Market Detail, and history use the same timeframe RR and lifecycle contract.
3. Server restarts do not erase signals, transitions, outcomes, or research samples.
4. Every exchange event is normalized to consistent USD notional, timestamps, symbols, and quality flags.
5. Feed gaps, stale streams, duplicates, out-of-order events, and clock skew are observable and do not silently create signals.
6. Backtests are deterministic, cost-aware, walk-forward, purged, and free from random train/test leakage.
7. Model outputs are calibrated probabilities, not scores presented as probabilities.
8. Live trade selection uses net expected value and uncertainty, with a valid `NO_TRADE` result.
9. Accuracy is shown only with sample size and confidence intervals; no percentage is shown when evidence is insufficient.

---

## Phase 1 — Correctness and reproducibility foundation

### 1.1 Canonical policy contract

Create `config/signal_policy.json` containing:

- `policy_version`
- timeframe minutes
- timeframe RR map: `1m=1.5`, `5m=2`, `15m=3`, `1h=4`, `4h=6`
- lifecycle TTL per timeframe
- robust signal gates
- ATR multiplier `1.2`
- default taker fee per side
- sensitivity bounds and timeframe scaling rule
- liquidity tiers
- outcome ambiguity policy

Add:

- `backend/app/engine/policy.py` to validate and expose the policy.
- `src/lib/signalPolicy.js` to import the same JSON.
- `GET /api/scanner/policy` for runtime diagnostics.

Remove independent RR defaults from background scanning. Deprecate REST `reward_ratio` as an event-mutating input; it may remain temporarily accepted for compatibility but must not alter an existing signal.

### 1.2 Immutable signal domain

Split the current mutable tracker dictionary into:

- `SignalEvent`: immutable detection event.
- `SignalTransition`: append-only lifecycle transition.
- `SignalOutcome`: terminal triple-barrier result.
- `SignalView`: projection used by REST/WebSocket/UI.

Every `SignalEvent` stores:

- stable UUID
- dedupe key
- exchange, canonical asset, exchange symbol
- timeframe and candle open timestamp
- direction
- detected/confirmed timestamps
- sensitivity and liquidity policy
- entry, ATR, stop, target, gross RR
- spread, fee, and estimated cost snapshot
- net reward, net risk, net RR, break-even probability
- feature schema version and complete feature JSON
- policy version and model version
- source event IDs and data-quality flags

Lifecycle transitions:

- `confirming`
- `confirmed`
- `invalidated`
- `target_hit`
- `stopped`
- `expired`
- `ambiguous`
- `replaced`

An existing event may receive transitions but its configuration, levels, and feature snapshot never change.

### 1.3 RR and Market Detail consistency

- Background scanner obtains RR from the canonical timeframe policy.
- REST queries cannot overwrite a signal's RR.
- Browser fallback obtains RR from the same JSON policy.
- `MarketDetail` reads `signal.trigger_reward_ratio`/canonical `signal.reward_ratio`, not a default `2`.
- Confirmed plans freeze entry, ATR, spread, fee, stop, and target.
- History and POA consume the same frozen plan.

### 1.4 SQLite/WAL research store

Add `backend/app/storage/`:

- `database.py`: connection lifecycle, WAL, migrations, busy timeout.
- `migrations.py`: numbered idempotent migrations.
- `repository.py`: typed persistence boundary.
- `writer.py`: bounded asynchronous queue and batched writes.

Initial tables:

- `schema_migrations`
- `market_events`
- `feed_health`
- `candles`
- `signal_events`
- `signal_transitions`
- `signal_outcomes`
- `feature_snapshots`
- `model_registry`
- `research_runs`

Write policy:

- Batch up to 500 rows or flush every 250 ms.
- Queue is bounded.
- High-priority signal/transitions are never intentionally dropped.
- If raw-event pressure exceeds capacity, drop only explicitly low-priority book snapshots, increment a persisted drop counter, and mark affected periods degraded.
- Store timestamps as UTC epoch milliseconds.
- Store JSON with canonical sorted keys where deterministic hashes are required.

Retention:

- Raw trade/book/ticker events: default 7 days.
- Candles, signals, transitions, outcomes, features, models, and reports: retained.
- Add a maintenance command for retention and `VACUUM` outside live scanning.

### 1.5 Ordered cost-aware outcome engine

Create `backend/app/engine/outcomes.py`:

- Consume normalized ordered trades/ticks.
- Apply triple barriers: target, stop, expiry.
- Use exchange timestamp, then sequence/trade ID, then receive timestamp as ordering hierarchy.
- When stop and target order cannot be established, emit `ambiguous`.
- Calculate gross and net realized R.
- Include entry/exit spread, taker fees, configurable slippage, and funding when the holding interval crosses funding.
- Persist the first terminal transition exactly once.
- Make replay idempotent.

### 1.6 Phase 1 acceptance tests

- Policy contract loads identically in backend and frontend fixtures.
- Background and REST requests cannot mutate RR.
- Market Detail uses the event RR.
- Restart recovery reproduces the same signal projection.
- Duplicate/out-of-order events do not duplicate transitions.
- Target-first, stop-first, expiry, and ambiguous fixtures pass.
- Fee/spread/slippage fixtures match hand-calculated values.
- Existing signal/trade math tests continue to pass.

---

## Phase 2 — Institutional data-quality and normalization layer

### 2.1 Normalized event envelope

Add models for:

- `TradeEvent`
- `TickerEvent`
- `BookEvent`
- `CandleEvent`
- `FundingEvent`
- `OpenInterestEvent`
- `LiquidationEvent`

Shared fields:

- exchange
- canonical asset and contract
- exchange symbol/instrument ID
- exchange timestamp
- receive timestamp
- source sequence/trade ID where available
- normalized price, base quantity, and USD notional
- source-specific payload hash
- quality flags

### 2.2 Exchange adapters

Refactor Binance, Bybit, Hyperliquid, and OKX ingestors to emit normalized events instead of mutating buffers directly.

Each adapter must:

- Convert contract/base/quote units to USD notional using documented venue semantics.
- Preserve exchange timestamps.
- Deduplicate reconnect replays.
- Detect stale data and sequence gaps.
- Reconcile candle/ticker state through REST after a gap.
- Record reconnect count, message lag, parse failures, dropped messages, and last good event.
- Never fabricate missing trade counts.

Where a venue does not expose a required metric, set it unavailable and use a venue-specific model path rather than silently substituting zero.

### 2.3 Canonical asset event

Create a canonical asset-level aggregator:

- Merge same-asset evidence across venues.
- Do not count four venues as four independent signals.
- Track venue participation, dispersion, and lead-lag.
- Require configurable independent-venue confirmation for high-confidence events.
- Mark isolated venue moves and stale-venue periods.

### 2.4 Data health API/UI

Expose:

- per-feed state
- last exchange event age
- receive lag p50/p95
- gaps and reconciliations
- dropped event count
- clock skew
- degraded intervals

The frontend Data Health card opens a compact detail panel. Signal cards show a degraded-data warning when applicable.

### 2.5 Phase 2 acceptance tests

- Venue fixture payloads normalize to exact expected USD notionals.
- Duplicate/reordered/reconnect fixtures remain idempotent.
- Gap fixtures trigger reconciliation and degraded flags.
- Cross-venue canonicalization merges aliases correctly.
- A single-venue anomaly is not represented as multi-venue confirmation.

---

## Phase 3 — Robust statistical feature engine

Create versioned pure feature modules in `backend/app/features/`, mirrored only where browser fallback needs them.

### 3.1 Market-neutral returns

Estimate rolling robust betas to BTC, ETH, and sector factors:

`r_idio = r_asset - beta_btc*r_btc - beta_eth*r_eth - beta_sector*r_sector`

- Use closed candles only.
- Use ridge-regularized rolling regression.
- Fall back in order: BTC+ETH+sector → BTC → raw return.
- Record fallback and sample size in feature metadata.

### 3.2 Conditional volatility

Combine:

- rolling median/MAD baseline
- robust EWMA volatility
- HAR-style short/medium/long realized volatility
- minute-of-week seasonality
- regime multiplier

Use Student-t/robust residual assumptions rather than claiming Gaussian tail probabilities.

Forming-candle normalization remains event-time aware:

`z = residual_return / (conditional_sigma * sqrt(elapsed_fraction))`

### 3.3 Jump evidence

Add:

- bipower variation
- realized variance
- Lee–Mykland-style jump statistic
- empirical tail percentile
- EVT peaks-over-threshold component after enough samples exist

If EVT sample requirements are not met, report unavailable; do not extrapolate.

### 3.4 Conditional volume surprise

Estimate log-volume surprise against:

- asset median
- minute-of-week baseline
- current market-wide volume
- volatility regime

Keep the existing 2× relative-volume gate as a conservative fallback.

### 3.5 Executable liquidity

Build a liquidity feature set from:

- spread
- depth at 5/10/25 bps
- book slope
- quote staleness
- trade frequency
- average trade notional
- expected impact for configured position sizes
- 24h turnover
- cross-venue depth

Gate trades when estimated round-trip implementation cost is too large relative to ATR.

### 3.6 Microstructure

Add:

- aggressive order-flow imbalance
- cumulative volume delta
- weighted multi-level book imbalance
- microprice displacement
- spread expansion/compression
- book refill and cancellation intensity
- sweep detection
- liquidation clustering
- OI acceleration
- funding and mark/index dislocation

Book-only signals receive less confidence unless confirmed by executed flow.

### 3.7 Regime classification

Start with a deterministic transparent classifier:

- low-volatility range
- high-volatility trend
- liquidation cascade
- market-wide risk-on
- market-wide risk-off
- BTC-led
- idiosyncratic
- thin/degraded liquidity

Persist regime probabilities/evidence. A later model can replace the classifier without changing the feature contract.

### 3.8 Multiple-testing control

At every scan epoch:

- Convert valid anomaly statistics to empirical p-values.
- Apply Benjamini–Hochberg false discovery rate across the active universe.
- Store raw p-value, adjusted q-value, universe size, and selected FDR.
- Keep a configurable emergency absolute threshold.

### 3.9 Phase 3 acceptance tests

- Synthetic beta-driven moves have low idiosyncratic significance.
- Coin-specific jumps remain significant.
- Time-of-day volume fixtures are deseasonalized.
- Jump and no-jump simulations classify correctly within expected tolerance.
- Liquidity worsens monotonically with wider spread/lower depth.
- FDR fixtures select the expected hypotheses.
- Every feature is deterministic and versioned.

---

## Phase 4 — Labels, replay, and statistically valid backtesting

### 4.1 Deterministic replay engine

Add `backend/app/research/replay.py`:

- Read events in canonical order.
- Rebuild candles, features, signals, and outcomes from an empty state.
- Support symbol, exchange, timeframe, and date filters.
- Produce a content hash for inputs, policy, features, and results.
- Two runs with identical inputs produce identical hashes.

### 4.2 Triple-barrier labels

Labels:

- `target_hit`
- `stopped`
- `expired`
- `ambiguous`
- `invalidated_before_entry`

Store:

- MFE and MAE
- time to target/stop
- gross and net R
- spread/slippage/fee/funding costs
- data-quality status

Ambiguous and degraded samples are reported separately and excluded from primary model fitting by default.

### 4.3 Walk-forward validation

Implement:

- chronological rolling train/calibration/test windows
- purging of overlapping label horizons
- embargo after train/calibration windows
- grouping by canonical event to avoid venue duplication
- regime, exchange, symbol, and timeframe slices
- no random split

### 4.4 Metrics and confidence

Report:

- sample count and coverage
- precision/recall for target-before-stop
- win/stop/expiry/ambiguous rates
- average and median net R
- net expectancy
- profit factor
- drawdown
- turnover
- Brier score
- calibration error
- precision-recall AUC
- block-bootstrap 95% confidence intervals

Do not show an accuracy percentage when the decided sample is below the configured minimum.

### 4.5 Research CLI/API

Add commands:

- `python -m app.research.cli migrate`
- `... replay`
- `... backtest`
- `... train`
- `... evaluate`
- `... promote`
- `... report`
- `... maintain`

Add read-only APIs for latest research report and model status. Long-running research remains CLI-driven and never blocks the live server.

### 4.6 Phase 4 acceptance tests

- Replay hashes are deterministic.
- Purge/embargo tests prove no overlapping labels leak.
- Cost changes affect net R and break-even monotonically.
- Ambiguous ordering never becomes a win.
- Block-bootstrap results are stable under a seeded fixture.

---

## Phase 5 — Calibrated probability and uncertainty model

### 5.1 Baseline model

Implement deterministic NumPy L2-regularized logistic regression:

`p_raw = sigmoid(beta_0 + beta^T X)`

- Standardize using training-window statistics only.
- Handle missingness with explicit indicators.
- Use class/sample weights determined from training data only.
- Persist coefficients, means, scales, feature list, schema version, policy version, and training hash.

### 5.2 Hierarchical shrinkage

Use a global model plus regularized group adjustments for:

- timeframe
- regime
- sector
- exchange

Low-sample groups shrink toward the global estimate. Do not fit coin-specific adjustments until minimum samples are met.

### 5.3 Calibration

- Reserve a chronological calibration window.
- Implement deterministic PAV isotonic calibration.
- Fall back to Platt scaling if the calibration sample is too small.
- Persist calibration map and diagnostics.

### 5.4 Uncertainty and abstention

Estimate uncertainty using:

- block-bootstrap model ensemble
- ensemble probability spread
- empirical conformal score on the calibration period

Output:

- calibrated probability
- lower/upper probability bound
- confidence/coverage status
- abstain reason

### 5.5 Challenger models

Only after the baseline is stable:

- transparent GAM-style spline features
- small gradient-boosted challenger if a dependency is later approved

No challenger is promoted unless it improves out-of-sample net expectancy and calibration across multiple walk-forward windows, not merely in-sample accuracy.

### 5.6 Model registry and promotion

Model states:

- `candidate`
- `shadow`
- `approved`
- `retired`

Promotion requires:

- minimum sample by timeframe
- positive lower confidence bound on net expectancy
- calibration within threshold
- no unacceptable regime/exchange degradation
- reproducible training hash

Rollback is a metadata operation to the last approved version.

### 5.7 Phase 5 acceptance tests

- Training is deterministic.
- Standardization/calibration never sees test data.
- Probabilities are monotonic through calibration.
- Low-sample groups shrink toward global behavior.
- Unknown/out-of-distribution samples abstain.
- Model serialization round-trips exactly.

---

## Phase 6 — Cost-aware decision policy and product integration

### 6.1 Expected-value gate

For each candidate:

`EV_net = p_target*net_reward - (1-p_target)*net_risk`

Use uncertainty:

`EV_lower = p_lower*net_reward - (1-p_lower)*net_risk`

Decision states:

- `LONG`
- `SHORT`
- `WATCH`
- `NO_TRADE`

Live gating requires:

- confirmed statistical anomaly
- acceptable data quality
- acceptable executable liquidity
- cross-venue evidence or explicit isolated-move policy
- `EV_lower > safety_margin`
- probability above net break-even plus configured buffer

### 6.2 Adaptive RR

Timeframe RR remains the default policy. Add research-only adaptive recommendations from conditional MFE/MAE quantiles.

- Do not change an active event's RR.
- Recommend adaptive RR only when sample and confidence requirements pass.
- The UI clearly distinguishes policy RR from research recommendation.

### 6.3 UI

Signal cards and Market Detail display:

- anomaly strength
- calibrated target-before-stop probability
- confidence interval
- net break-even probability
- net expected R
- regime
- liquidity quality
- cross-venue confirmation
- top positive/negative evidence
- model/policy version
- data-quality warning
- `NO_TRADE`/abstain reason

The existing score remains labeled `Strength`, never `% accuracy`.

History/research adds:

- sample size
- decided/expired/ambiguous counts
- net win rate
- expectancy
- confidence interval
- calibration chart
- regime/timeframe filters

### 6.4 Browser fallback

The browser engine remains a continuity fallback:

- It uses the canonical policy and statistical baseline.
- It never presents model probabilities without a backend model.
- It labels reduced evidence and unavailable features.
- Its stream-count denominator includes all configured feeds.

### 6.5 Phase 6 acceptance tests

- EV decisions match hand-calculated fixtures.
- Probability below break-even always rejects.
- Uncertain lower bound rejects even if point estimate is positive.
- UI never labels strength as accuracy.
- Browser fallback visibly identifies reduced evidence.

---

## Phase 7 — Shadow rollout, monitoring, and promotion

### 7.1 Shadow operation

- Statistical baseline continues producing live signals.
- Candidate model records predictions but does not gate alerts.
- Outcomes attach to both baseline and model decision snapshots.
- Collect at least 200–500 decided, non-ambiguous events per promoted timeframe, with multiple regimes represented.

### 7.2 Monitoring

Track:

- feature distribution drift
- missing-feature drift
- probability calibration drift
- net expectancy drift
- venue/regime concentration
- event rate changes
- latency and data-quality degradation

Use PSI/KS-style diagnostics as monitoring signals, not automatic proof of failure.

### 7.3 Promotion

Promote one timeframe at a time:

1. 1m shadow
2. 5m shadow
3. 15m shadow
4. 1h shadow
5. 4h shadow

Promotion requires the gates in Phase 5. Roll back automatically to baseline presentation if the approved model is unavailable or schema-incompatible.

---

## Cross-cutting failure handling

- Database unavailable: continue bounded in-memory scanning, mark persistence degraded, and do not claim research completeness.
- Writer queue overloaded: preserve signals/transitions, drop eligible low-priority snapshots, persist counters.
- Feed stale/gapped: block high-confidence decisions and mark interval degraded.
- Missing feature: use explicit missing indicator or abstain; never silently use zero unless zero is semantically valid.
- Policy/model schema mismatch: reject model loading and use baseline.
- Insufficient samples: show `insufficient evidence`, not an accuracy estimate.
- Clock skew: prefer exchange sequence; otherwise mark ordering uncertain.
- Server restart: recover active signals from immutable events plus transitions.

## File-level implementation map

Expected new areas:

- `config/signal_policy.json`
- `backend/app/storage/**`
- `backend/app/events/**`
- `backend/app/features/**`
- `backend/app/research/**`
- `backend/app/models/**`
- `backend/app/engine/outcomes.py`
- `backend/app/engine/policy.py`
- `src/lib/signalPolicy.js`
- research/model UI components under `src/components/**`
- fixture datasets under `backend/tests/fixtures/**`

Expected refactors:

- `backend/app/main.py`
- all exchange ingestors
- `backend/app/core/models.py`
- `backend/app/core/ring_buffer.py`
- `backend/app/engine/pump_dump_tracker.py`
- `backend/app/engine/signal_math.py`
- `backend/app/engine/trade_math.py`
- `backend/app/api/routes.py`
- `backend/app/api/ws.py`
- `src/App.jsx`
- `src/lib/liveEngine.js`
- `src/lib/tradeMath.js`
- `src/components/PumpDumpView.jsx`
- `src/components/SignalCard.jsx`
- `src/components/MarketDetail.jsx`

## Delivery sequence

Implement one verified slice at a time:

1. Phase 1.1–1.3: canonical policy and RR consistency.
2. Phase 1.4–1.6: SQLite, immutable events, ordered outcomes.
3. Phase 2: normalized feeds and health.
4. Phase 3.1–3.4: residual returns, conditional volatility, jumps, volume.
5. Phase 3.5–3.8: liquidity, microstructure, regimes, FDR.
6. Phase 4: replay, labels, walk-forward reports.
7. Phase 5: calibrated model, uncertainty, registry.
8. Phase 6: EV decision policy and UI.
9. Phase 7: shadow collection and eventual promotion.

Each slice must keep the scanner usable, include migrations where required, and end with focused verification before the next slice begins.

## Verification commands

Use repository-prescribed commands:

- Backend tests: `PYTHONPATH=backend python -m unittest discover -s backend/tests -p 'test_*.py'`
- Python compile: `python -m compileall -q backend/app`
- Frontend formatting: `pnpm run format -- <changed frontend files>`
- Frontend build for broad UI/contracts: `pnpm run build`
- Whitespace: `git diff --check`
- Bootstrap/runtime after backend wiring changes: `figma make verify-bootstrap` or `--force` only for a proven stale preview
- Runtime smoke: `/api/health`, policy, stats, signals, feed health, research report, and WebSocket connection

Because external exchange endpoints can return HTTP 520 in this sandbox, connector correctness must also be proven with captured fixture/replay tests. Live end-to-end exchange verification must be reported as incomplete when upstream access remains blocked.

## Completion definition

“All improvements complete” means:

- Phases 1–6 are implemented and verified.
- Phase 7 shadow infrastructure is active.
- No accuracy claim is made until the required real decided sample is collected.
- A model is not considered institutionally validated merely because code exists or fixture tests pass.
- Promotion after shadow collection is a separate evidence-based milestone, not a coding-only milestone.
