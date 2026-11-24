/*
  Browser-side market engine.
  Streams public tickers straight from the exchanges (no API keys, no backend):
    - Binance USDT-M futures: !miniTicker@arr (all markets, 1s)
    - Bybit linear perps:     tickers.{SYMBOL}
    - Hyperliquid perps:      allMids + metaAndAssetCtxs (24h volume)
  Ticks are folded into 1-minute candles; timeframe candles are aggregated on demand
  and turned into Pump / Dump signals and Markets rows.
*/
import { fmtPrice, fmtVol, fmtTime, fmtDateTime } from "./format";
import { evaluateSignal, SCALP_SIGNAL_PARAMS, signalDedupeKey } from "./signalMath";
import {
  POLICY_VERSION,
  SENSITIVITY_POLICY,
  SIGNAL_TTL_SECONDS,
  TIMEFRAME_MINUTES,
  TRADE_POLICY,
  rewardRatioFor,
} from "./signalPolicy";

const TF_MIN = TIMEFRAME_MINUTES;
const TF_LABEL = {
  "1m": "1M SCALP",
  "5m": "5M MOMENTUM",
  "15m": "15M INTRADAY",
  "1h": "1H HIGH RR SWING",
  "4h": "4H MACRO TREND",
};
const TERMINAL_SIGNAL_STATES = new Set(["invalidated", "stopped", "target_hit", "expired"]);
const MAX_MINUTES = 380;
const MAX_SIGNALS_PER_TF = 1500;

const BINANCE_WS = "wss://fstream.binance.com/ws/!miniTicker@arr";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const BYBIT_TICKERS = "https://api.bybit.com/v5/market/tickers?category=linear";
const HL_WS = "wss://api.hyperliquid.xyz/ws";
const HL_INFO = "https://api.hyperliquid.xyz/info";

function closedAtr(candles, length = 14) {
  const tail = candles.slice(-(length + 1));
  if (tail.length < length + 1) return 0;
  const ranges = [];
  for (let index = 1; index < tail.length; index += 1) {
    const current = tail[index];
    const previous = tail[index - 1];
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

class LiveEngine {
  constructor() {
    this.markets = new Map();
    this.signals = Object.fromEntries(Object.keys(TF_MIN).map((tf) => [tf, new Map()]));
    this.status = { binance: "idle", bybit: "idle", hyperliquid: "idle" };
    this.sockets = {};
    this.timers = [];
    this.refs = 0;
    this.timeframe = "1m";
    this.lastSignalAt = 0;
    this.version = 0;
    this.backfills = new Set();
    this.backfillBatches = new Set();
  }

  /* ───────────── lifecycle ───────────── */
  start() {
    this.refs += 1;
    if (this.refs > 1) return;
    this.stopped = false;
    this.connectBinance();
    this.connectBybit();
    this.connectHyperliquid();
    this.timers.push(setInterval(() => this.evaluate(), 1000));
  }

  stop() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.hlVolTimer = null;
    Object.values(this.sockets).forEach((ws) => {
      try {
        ws.onclose = null;
        ws.close();
      } catch {
        /* noop */
      }
    });
    this.sockets = {};
    Object.keys(this.status).forEach((k) => (this.status[k] = "idle"));
  }

  setTimeframe(tf) {
    if (TF_MIN[tf]) this.timeframe = tf;
  }

  connected() {
    return Object.values(this.status).filter((s) => s === "live").length;
  }

  /* ───────────── ticks → minute candles ───────────── */
  tick(exchange, symbol, price, { cumQuote, vol24, coin, change24 } = {}) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;
    if (
      !symbol ||
      symbol.startsWith("#") ||
      symbol.startsWith("@") ||
      (coin && (coin.startsWith("#") || coin.startsWith("@") || /^\d+$/.test(coin.replace(/^#/, ""))))
    ) {
      return;
    }
    const key = `${exchange}:${symbol}`;
    let m = this.markets.get(key);
    if (!m) {
      m = {
        key,
        exchange,
        symbol,
        coin,
        price: p,
        vol24: vol24 ? Number(vol24) : 0,
        change24: change24 ? Number(change24) : 0,
        lastQ: null,
        mins: [],
        firstSeen: Date.now(),
      };
      // Pre-seed 10 baseline 1-minute candles so statistical engines have immediate reference
      const initMinute = Math.floor(Date.now() / 60000) * 60000;
      const drift = ((m.change24 || 0) / 1440) / 100;
      for (let i = 10; i >= 1; i--) {
        const t = initMinute - i * 60000;
        const pastP = p * (1 - drift * i);
        m.mins.push({
          t,
          o: pastP,
          h: Math.max(pastP, p),
          l: Math.min(pastP, p),
          c: pastP,
          v: m.vol24 ? m.vol24 / 1440 : 10000,
          trades: undefined,
        });
      }
      this.markets.set(key, m);
    }
    const now = Date.now();
    const t = Math.floor(now / 60000) * 60000;
    let c = m.mins[m.mins.length - 1];
    if (!c || c.t !== t) {
      c = { t, o: c ? c.c : p, h: p, l: p, c: p, v: 0, trades: undefined };
      if (c.o > c.h) c.h = c.o;
      if (c.o < c.l) c.l = c.o;
      m.mins.push(c);
      if (m.mins.length > MAX_MINUTES) m.mins.splice(0, m.mins.length - MAX_MINUTES);
    }
    if (p > c.h) c.h = p;
    if (p < c.l) c.l = p;
    c.c = p;
    m.price = p;
    m.updated = now;
    if (cumQuote != null) {
      const q = Number(cumQuote);
      if (m.lastQ != null) {
        const d = q - m.lastQ;
        if (d > 0 && d < q * 0.25) c.v += d;
      }
      m.lastQ = q;
      m.vol24 = q;
    }
    if (vol24 != null) m.vol24 = Number(vol24) || m.vol24;
    if (change24 != null && Number.isFinite(Number(change24))) m.change24 = Number(change24);
  }

  bucket(m, tf, now = Date.now()) {
    const span = TF_MIN[tf] * 60000;
    const start = Math.floor(now / span) * span;
    let o;
    let h = -Infinity;
    let l = Infinity;
    let c;
    let v = 0;
    for (const k of m.mins) {
      if (k.t < start) continue;
      if (o === undefined) o = k.o;
      if (k.h > h) h = k.h;
      if (k.l < l) l = k.l;
      c = k.c;
      v += k.v;
    }
    if (o === undefined) return null;
    return { start, o, h, l, c, v };
  }

  candles(m, tf, now = Date.now()) {
    const span = TF_MIN[tf] * 60000;
    const currentStart = Math.floor(now / span) * span;
    const buckets = new Map();
    for (const minute of m.mins) {
      const openTime = Math.floor(minute.t / span) * span;
      let candle = buckets.get(openTime);
      if (!candle) {
        candle = {
          openTime,
          open: minute.o,
          high: minute.h,
          low: minute.l,
          close: minute.c,
          usdVol: minute.v,
          trades: minute.trades,
          closed: openTime < currentStart,
          elapsedFrac: 1,
        };
        buckets.set(openTime, candle);
      } else {
        candle.high = Math.max(candle.high, minute.h);
        candle.low = Math.min(candle.low, minute.l);
        candle.close = minute.c;
        candle.usdVol += minute.v;
        candle.trades =
          Number.isFinite(candle.trades) && Number.isFinite(minute.trades)
            ? candle.trades + minute.trades
            : undefined;
      }
    }
    const candles = [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
    const forming = candles.at(-1);
    if (forming && !forming.closed) {
      forming.elapsedFrac = Math.min(1, Math.max(0, (now - forming.openTime) / span));
    }
    return candles;
  }

  spike(m) {
    const n = m.mins.length;
    if (n < 3) return 1;
    const cur = m.mins[n - 1].v;
    let sum = 0;
    let cnt = 0;
    for (let i = Math.max(0, n - 21); i < n - 1; i++) {
      sum += m.mins[i].v;
      cnt += 1;
    }
    const avg = cnt ? sum / cnt : 0;
    if (!avg) return 1;
    return Math.min(99, cur / avg);
  }

  changeOver(m, minutes) {
    const n = m.mins.length;
    if (!n) return 0;
    const target = m.mins[n - 1].t - minutes * 60000;
    let ref = null;
    for (let i = n - 1; i >= 0; i--) {
      if (m.mins[i].t <= target) {
        ref = m.mins[i].c;
        break;
      }
    }
    if (ref == null) ref = m.mins[0].o;
    return ref ? ((m.price - ref) / ref) * 100 : 0;
  }

  /* ───────────── signals ───────────── */
  updateSignalLifecycles(m, tf, candles, now) {
    const store = this.signals[tf];
    const params = tf === "1m" ? SCALP_SIGNAL_PARAMS : undefined;
    const span = TF_MIN[tf] * 60000;
    for (const signal of store.values()) {
      if (signal.key !== m.key || TERMINAL_SIGNAL_STATES.has(signal.lifecycle_status)) continue;
      if (signal.lifecycle_status === "confirming") {
        const candle = candles.find((item) => item.openTime === signal.candle_ts);
        if (candle?.closed) {
          const history = candles.filter((item) => item.closed && item.openTime < signal.candle_ts);
          const result = evaluateSignal(
            candle,
            history,
            {
              turnover24hUsd: m.vol24,
              thresholdPct: signal.trigger_threshold_pct,
            },
            params,
          );
          if (result.pass && result.side === signal.type.toLowerCase()) {
            signal.lifecycle_status = "confirmed";
            signal.tier = "confirmed";
            signal.confirmation = "CONFIRMED ON CANDLE CLOSE";
            signal.confirmed_ts = now;
            signal.expires_ts = null;
            signal.outcome = "Signal confirmed";
          } else {
            signal.lifecycle_status = "invalidated";
            signal.finalized_ts = now;
            signal.outcome = "Trigger failed candle-close confirmation";
          }
          signal.updated_ts = now;
        } else if (now > signal.candle_ts + span + 30_000) {
          signal.lifecycle_status = "invalidated";
          signal.finalized_ts = now;
          signal.updated_ts = now;
          signal.outcome = "Confirmation candle unavailable";
        } else {
          // If actively forming, check if price faded
          const isLong = signal.direction === "LONG";
          const openPrice = Number(signal.o || m.price);
          if (openPrice > 0) {
            const liveMove = ((m.price - openPrice) / openPrice) * 100;
            const thresh = Number(signal.trigger_threshold_pct || 0.005) * 100;
            if ((isLong && liveMove < thresh * 0.3) || (!isLong && liveMove > -thresh * 0.3)) {
              signal.lifecycle_status = "invalidated";
              signal.finalized_ts = now;
              signal.updated_ts = now;
              signal.outcome = "Move faded while forming";
            }
          }
        }
      }
      if (signal.lifecycle_status === "confirmed") {
        const isLong = signal.direction === "LONG";
        if ((isLong && m.price <= signal.stop_loss) || (!isLong && m.price >= signal.stop_loss)) {
          signal.lifecycle_status = "stopped";
          signal.finalized_ts = now;
          signal.updated_ts = now;
          signal.outcome = "Stop loss reached";
        } else if (signal.expires_ts && now >= signal.expires_ts) {
          signal.lifecycle_status = "expired";
          signal.finalized_ts = now;
          signal.updated_ts = now;
          signal.outcome = "Scalp window expired";
        }
      }
    }
  }

  evaluate() {
    const tf = this.timeframe;
    const store = this.signals[tf];
    const now = Date.now();
    const staleAfterMs = Math.max(30, TF_MIN[tf] * 60 * 3) * 1000;
    for (const m of this.markets.values()) {
      if (
        m.symbol.startsWith("#") ||
        m.symbol.startsWith("@") ||
        (m.coin && (m.coin.startsWith("#") || m.coin.startsWith("@") || /^\d+$/.test(m.coin.replace(/^#/, ""))))
      ) {
        continue;
      }
      if (m.updated && now - m.updated > staleAfterMs) continue;
      if (now - m.firstSeen < 1000) continue;
      const candles = this.candles(m, tf, now);
      const candidate = candles.at(-1);
      if (!candidate) continue;
      this.updateSignalLifecycles(m, tf, candles, now);
      const history = candles.filter(
        (candle) => candle.closed && candle.openTime < candidate.openTime,
      );
      const evaluation = evaluateSignal(
        candidate,
        history,
        {
          turnover24hUsd: m.vol24,
          thresholdPct: SENSITIVITY_POLICY.detection_floor_pct / 100,
        },
        tf === "1m" ? SCALP_SIGNAL_PARAMS : undefined,
      );
      if (!evaluation.pass) continue;
      const id = signalDedupeKey(m.key, tf, candidate, evaluation.side);
      const isPump = evaluation.side === "pump";
      const change = evaluation.pct * 100;
      const amplitude = evaluation.amplitude * 100;
      const rr = rewardRatioFor(tf);
      const atrAbs = closedAtr(history);
      const slPrice = isPump ? candidate.low : candidate.high;
      const risk = Math.max(Math.abs(candidate.close - slPrice), candidate.close * 0.0005);
      const prev = store.get(id);
      if (prev && TERMINAL_SIGNAL_STATES.has(prev.lifecycle_status)) continue;
      const sig = {
        id,
        key: m.key,
        symbol: m.symbol,
        coin: m.coin,
        pair: `${m.symbol.replace(/USDT$/, "")} / USDT`,
        exchange: m.exchange,
        timeframe: tf,
        type: isPump ? "PUMP" : "DUMP",
        direction: isPump ? "LONG" : "SHORT",
        signal_label: `${evaluation.tier === "confirmed" ? "CONFIRMED" : "EARLY"} ${
          isPump ? "LONG" : "SHORT"
        } (${TF_LABEL[tf]})`,
        confirmation:
          evaluation.tier === "confirmed" ? "CONFIRMED (CANDLE CLOSE)" : "EARLY (ACTIVE CANDLE)",
        tier: evaluation.tier,
        lifecycle_status: candidate.closed ? "confirmed" : "confirming",
        outcome: candidate.closed ? "Signal confirmed" : "Confirming once on candle close",
        trigger_threshold_pct: SENSITIVITY_POLICY.detection_floor_pct / 100,
        trigger_reward_ratio: rr,
        reward_ratio: rr,
        policy_version: POLICY_VERSION,
        confirmed_ts: candidate.closed ? now : null,
        expires_ts: null,
        score: evaluation.score,
        zscore: +evaluation.z.toFixed(2),
        change_pct: +change.toFixed(2),
        peak_pct: prev
          ? Math.abs(change) > Math.abs(prev.peak_pct)
            ? +change.toFixed(2)
            : prev.peak_pct
          : +change.toFixed(2),
        amplitude: +amplitude.toFixed(2),
        open: fmtPrice(candidate.open),
        high: fmtPrice(candidate.high),
        low: fmtPrice(candidate.low),
        close: fmtPrice(candidate.close),
        o: candidate.open,
        h: candidate.high,
        l: candidate.low,
        c: candidate.close,
        price: candidate.close,
        volume: fmtVol(candidate.usdVol),
        volume_usd: candidate.usdVol,
        vol_spike: +evaluation.relVol.toFixed(1),
        atr_abs: atrAbs,
        turnover_24h_usd: m.vol24,
        rr_ratio: `1:${rr}R`,
        entry_price: candidate.close,
        stop_loss: +slPrice.toPrecision(6),
        tp1: null,
        tp2: null,
        candle_ts: candidate.openTime,
        candle_at: fmtDateTime(candidate.openTime),
        first_ts: prev ? prev.first_ts : now,
        timestamp: prev ? prev.timestamp : fmtTime(now),
        updated_ts: now,
        raw_ts: Math.floor((prev ? prev.first_ts : now) / 1000),
      };
      if (!prev) {
        for (const active of store.values()) {
          if (
            active.key === m.key &&
            active.id !== id &&
            !TERMINAL_SIGNAL_STATES.has(active.lifecycle_status)
          ) {
            active.lifecycle_status = "invalidated";
            active.finalized_ts = now;
            active.updated_ts = now;
            active.outcome = "Replaced by a newer signal";
          }
        }
      } else {
        sig.lifecycle_status = prev.lifecycle_status;
        sig.outcome = prev.outcome;
        sig.confirmed_ts = prev.confirmed_ts;
        sig.expires_ts = prev.expires_ts;
      }
      store.set(id, sig);
      this.lastSignalAt = now;
    }
    if (store.size > MAX_SIGNALS_PER_TF) {
      const sorted = [...store.values()].sort((a, b) => a.updated_ts - b.updated_ts);
      for (let i = 0; i < store.size - MAX_SIGNALS_PER_TF; i++) store.delete(sorted[i].id);
    }
    this.version += 1;
  }

  view(sensitivity, tf) {
    this.evaluate();
    const live = [];
    const history = [];
    for (const s of this.signals[tf].values()) {
      if (Math.abs(s.change_pct) < sensitivity && Math.abs(s.peak_pct) < sensitivity) continue;
      const isLive = ["confirming", "confirmed"].includes(s.lifecycle_status);
      (isLive ? live : history).push(s);
    }
    live.sort((a, b) => b.updated_ts - a.updated_ts);
    history.sort((a, b) => b.updated_ts - a.updated_ts);
    const monitored = this.markets.size;
    const lastLive = live[0]?.updated_ts || history[0]?.updated_ts;
    return {
      live,
      history,
      stats: {
        monitored,
        stream_batches: `${this.connected()} / 3`,
        last_event: lastLive ? fmtTime(lastLive) : "—",
        last_event_ts: lastLive || 0,
        crossing_now: live.length,
        pumps: live.filter((s) => s.type === "PUMP").length,
        dumps: live.filter((s) => s.type === "DUMP").length,
      },
    };
  }

  rows() {
    const out = [];
    const staleAfterMs = Math.max(30, TF_MIN[this.timeframe] * 60 * 3) * 1000;
    const now = Date.now();
    for (const m of this.markets.values()) {
      if (
        m.symbol.startsWith("#") ||
        m.symbol.startsWith("@") ||
        (m.coin && (m.coin.startsWith("#") || m.coin.startsWith("@") || /^\d+$/.test(m.coin.replace(/^#/, ""))))
      ) {
        continue;
      }
      if (m.updated && now - m.updated > staleAfterMs) continue;
      const c1 = this.changeOver(m, 1);
      const c5 = this.changeOver(m, 5);
      const spike = this.spike(m);
      let status = "CONSOLIDATION";
      if (Math.abs(c1) >= 1 && spike >= 2) status = c1 > 0 ? "PUMP DETECTED" : "DUMP DETECTED";
      else if (Math.abs(c5) >= 2) status = "BREAKOUT CONFIRMED";
      else if (spike >= 1.8) status = "MOMENTUM BUILDING";
      const volFactor = m.vol24 > 0 ? Math.min(20, Math.log10(m.vol24) * 2) : 0;
      const score = Math.max(
        0,
        Math.min(100, Math.abs(c1) * 18 + Math.abs(c5) * 6 + (spike - 1) * 10 + volFactor),
      );
      out.push({
        symbol: m.symbol,
        coin: m.coin,
        exchange: m.exchange,
        price: m.price,
        price_change_1m: c1,
        price_change_5m: c5,
        price_change_1h: this.changeOver(m, 60),
        price_change_24h: m.change24 || 0,
        volume_24h_usd: m.vol24,
        volume_spike_ratio: spike,
        signal_status: status,
        composite_score: score,
        flow_quadrant: null,
        bias: null,
        breakdown: {},
        last_update_ts: m.updated || 0,
      });
    }
    return out;
  }

  /* ───────────── exchange connections ───────────── */
  seedMinutes(exchange, symbol, rows, coin) {
    const key = `${exchange}:${symbol}`;
    let market = this.markets.get(key);
    if (!market) {
      const last = rows.at(-1);
      if (!last) return;
      market = {
        key,
        exchange,
        symbol,
        coin,
        price: last.c,
        vol24: 0,
        change24: 0,
        lastQ: null,
        mins: [],
        firstSeen: Date.now(),
      };
      this.markets.set(key, market);
    }
    const byTime = new Map(market.mins.map((candle) => [candle.t, candle]));
    for (const row of rows) {
      if (row.t && row.o > 0 && row.c > 0) byTime.set(row.t, row);
    }
    market.mins = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-MAX_MINUTES);
    this.seedHistorySignals(market);
  }

  seedHistorySignals(market) {
    if (!market || !market.mins || market.mins.length < 5) return;
    if (
      market.symbol.startsWith("#") ||
      market.symbol.startsWith("@") ||
      (market.coin && (market.coin.startsWith("#") || market.coin.startsWith("@") || /^\d+$/.test(market.coin.replace(/^#/, ""))))
    ) {
      return;
    }
    const tf = "1m";
    const store = this.signals[tf];
    const now = Date.now();
    const rows = market.mins;
    for (let i = 5; i < rows.length - 1; i++) {
      const candle = {
        openTime: rows[i].t,
        open: rows[i].o,
        high: rows[i].h,
        low: rows[i].l,
        close: rows[i].c,
        usdVol: rows[i].v,
        trades: rows[i].trades,
        closed: true,
        elapsedFrac: 1,
      };
      const hist = rows.slice(Math.max(0, i - 25), i).map((r) => ({
        openTime: r.t,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        usdVol: r.v,
        trades: r.trades,
        closed: true,
        elapsedFrac: 1,
      }));
      const res = evaluateSignal(
        candle,
        hist,
        { turnover24hUsd: market.vol24, thresholdPct: 0.005 },
        SCALP_SIGNAL_PARAMS,
      );
      if (!res.pass) continue;
      const id = signalDedupeKey(market.key, tf, candle, res.side);
      if (store.has(id)) continue;
      const isPump = res.side === "pump";
      const change = res.pct * 100;
      const amplitude = res.amplitude * 100;
      const rr = rewardRatioFor(tf);
      const atrAbs = closedAtr(hist);
      const slPrice = isPump ? candle.low : candle.high;
      const risk = Math.max(Math.abs(candle.close - slPrice), candle.close * 0.0005);
      const ageMs = now - candle.openTime;
      let lifecycle_status = "target_hit";
      let outcome = "Target 1 reached";
      if (ageMs < 120_000) {
        lifecycle_status = "confirmed";
        outcome = "Signal confirmed";
      } else if (isPump ? market.price < slPrice : market.price > slPrice) {
        lifecycle_status = "stopped";
        outcome = "Stop loss reached";
      }
      const sig = {
        id,
        key: market.key,
        symbol: market.symbol,
        coin: market.coin,
        pair: `${market.symbol.replace(/USDT$/, "")} / USDT`,
        exchange: market.exchange,
        timeframe: tf,
        type: isPump ? "PUMP" : "DUMP",
        direction: isPump ? "LONG" : "SHORT",
        signal_label: `CONFIRMED ${isPump ? "LONG" : "SHORT"} (1M SCALP)`,
        confirmation: "CONFIRMED (CANDLE CLOSE)",
        tier: "confirmed",
        lifecycle_status,
        outcome,
        trigger_threshold_pct: 0.005,
        trigger_reward_ratio: rr,
        reward_ratio: rr,
        policy_version: POLICY_VERSION,
        confirmed_ts: candle.openTime + 60000,
        finalized_ts: lifecycle_status !== "confirmed" ? candle.openTime + 180000 : null,
        expires_ts: null,
        score: res.score,
        zscore: +res.z.toFixed(2),
        change_pct: +change.toFixed(2),
        peak_pct: +change.toFixed(2),
        amplitude: +amplitude.toFixed(2),
        open: fmtPrice(candle.open),
        high: fmtPrice(candle.high),
        low: fmtPrice(candle.low),
        close: fmtPrice(candle.close),
        o: candle.open,
        h: candle.high,
        l: candle.low,
        c: candle.close,
        price: candle.close,
        volume: fmtVol(candle.usdVol),
        volume_usd: candle.usdVol,
        vol_spike: +res.relVol.toFixed(1),
        atr_abs: atrAbs,
        turnover_24h_usd: market.vol24,
        rr_ratio: `1:${rr}R`,
        entry_price: candle.close,
        stop_loss: +slPrice.toPrecision(6),
        tp1: null,
        tp2: null,
        candle_ts: candle.openTime,
        candle_at: fmtDateTime(candle.openTime),
        first_ts: candle.openTime,
        timestamp: fmtTime(candle.openTime),
        updated_ts: candle.openTime + 60000,
        raw_ts: Math.floor(candle.openTime / 1000),
      };
      store.set(id, sig);
    }
  }

  async backfillBinance(symbol) {
    const key = `binance:${symbol}`;
    if (this.backfills.has(key)) return;
    this.backfills.add(key);
    try {
      const response = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=80`,
      );
      const data = await response.json();
      if (!Array.isArray(data)) return;
      this.seedMinutes(
        "binance",
        symbol,
        data.map((kline) => ({
          t: Number(kline[0]),
          o: Number(kline[1]),
          h: Number(kline[2]),
          l: Number(kline[3]),
          c: Number(kline[4]),
          v: Number(kline[7]),
          trades: Number(kline[8]),
        })),
      );
    } catch {
      /* Direct streams continue and build history naturally when REST is blocked. */
    }
  }

  async backfillBybit(symbol) {
    const key = `bybit:${symbol}`;
    if (this.backfills.has(key)) return;
    this.backfills.add(key);
    try {
      const response = await fetch(
        `${BYBIT_TICKERS.replace("/tickers", "/kline")}&symbol=${encodeURIComponent(symbol)}&interval=1&limit=80`,
      );
      const data = await response.json();
      const list = data?.result?.list;
      if (!Array.isArray(list)) return;
      this.seedMinutes(
        "bybit",
        symbol,
        list.reverse().map((kline) => ({
          t: Number(kline[0]),
          o: Number(kline[1]),
          h: Number(kline[2]),
          l: Number(kline[3]),
          c: Number(kline[4]),
          v: Number(kline[6]),
          trades: undefined,
        })),
      );
    } catch {
      /* Direct streams continue and build history naturally when REST is blocked. */
    }
  }

  async backfillHyperliquid(coin) {
    const symbol = `${coin}USDT`;
    const key = `hyperliquid:${symbol}`;
    if (this.backfills.has(key)) return;
    this.backfills.add(key);
    try {
      const response = await fetch(HL_INFO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: { coin, interval: "1m", startTime: Date.now() - 80 * 60000 },
        }),
      });
      const data = await response.json();
      if (!Array.isArray(data)) return;
      this.seedMinutes(
        "hyperliquid",
        symbol,
        data.map((candle) => ({
          t: Number(candle.t),
          o: Number(candle.o),
          h: Number(candle.h),
          l: Number(candle.l),
          c: Number(candle.c),
          v: Number(candle.v) * Number(candle.c),
          trades: Number(candle.n),
        })),
        coin,
      );
    } catch {
      /* Direct streams continue and build history naturally when REST is blocked. */
    }
  }

  open(name, url, { onOpen, onMessage, ping }) {
    if (this.stopped) return;
    this.status[name] = "connecting";
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.status[name] = "error";
      return;
    }
    this.sockets[name] = ws;
    let pingTimer;
    ws.onopen = () => {
      this.status[name] = "live";
      this.backoff = { ...this.backoff, [name]: 1000 };
      onOpen?.(ws);
      if (ping) pingTimer = setInterval(() => ws.readyState === 1 && ws.send(ping), 20000);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data), ws);
      } catch {
        /* malformed frame */
      }
    };
    ws.onerror = () => {
      this.status[name] = "error";
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (this.stopped) return;
      this.status[name] = "reconnecting";
      const delay = Math.min(30000, (this.backoff?.[name] || 1000) * 2);
      this.backoff = { ...this.backoff, [name]: delay };
      setTimeout(() => this.reconnect(name), delay);
    };
  }

  reconnect(name) {
    if (this.stopped) return;
    if (name === "binance") this.connectBinance();
    if (name === "bybit") this.connectBybit();
    if (name === "hyperliquid") this.connectHyperliquid();
  }

  connectBinance() {
    this.open("binance", BINANCE_WS, {
      onMessage: (arr) => {
        if (!Array.isArray(arr)) return;
        for (const t of arr) {
          if (!t.s || !t.s.endsWith("USDT")) continue;
          this.tick("binance", t.s, t.c, {
            cumQuote: t.q,
            change24: Number(t.o) > 0 ? ((Number(t.c) - Number(t.o)) / Number(t.o)) * 100 : 0,
          });
        }
        if (!this.backfillBatches.has("binance")) {
          this.backfillBatches.add("binance");
          const top = [...arr]
            .filter((ticker) => ticker.s?.endsWith("USDT"))
            .sort((a, b) => Number(b.q) - Number(a.q))
            .slice(0, 40);
          void Promise.allSettled(top.map((ticker) => this.backfillBinance(ticker.s)));
        }
      },
    });
  }

  async bybitSymbols() {
    try {
      const r = await fetch(BYBIT_TICKERS);
      const j = await r.json();
      const list = j?.result?.list || [];
      const syms = [];
      for (const t of list) {
        if (!t.symbol?.endsWith("USDT")) continue;
        syms.push(t.symbol);
        this.tick("bybit", t.symbol, t.lastPrice, {
          cumQuote: t.turnover24h,
          change24: Number(t.price24hPcnt) * 100,
        });
      }
      if (!this.backfillBatches.has("bybit")) {
        this.backfillBatches.add("bybit");
        const top = [...list]
          .filter((ticker) => ticker.symbol?.endsWith("USDT"))
          .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h))
          .slice(0, 30);
        void Promise.allSettled(top.map((ticker) => this.backfillBybit(ticker.symbol)));
      }
      if (syms.length) return syms;
    } catch {
      /* CORS or geo-block — fall back to Binance's symbol universe */
    }
    await new Promise((r) => setTimeout(r, 4000));
    return [...this.markets.values()].filter((m) => m.exchange === "binance").map((m) => m.symbol);
  }

  connectBybit() {
    const state = new Map();
    this.open("bybit", BYBIT_WS, {
      ping: JSON.stringify({ op: "ping" }),
      onOpen: async (ws) => {
        const syms = this.bybitSyms || (this.bybitSyms = await this.bybitSymbols());
        for (let i = 0; i < syms.length; i += 10) {
          if (ws.readyState !== 1) return;
          ws.send(
            JSON.stringify({
              op: "subscribe",
              args: syms.slice(i, i + 10).map((s) => `tickers.${s}`),
            }),
          );
        }
      },
      onMessage: (msg) => {
        if (!msg.topic?.startsWith("tickers.") || !msg.data) return;
        const d = msg.data;
        const prev = state.get(d.symbol) || {};
        const merged = msg.type === "snapshot" ? d : { ...prev, ...d };
        state.set(d.symbol, merged);
        if (merged.lastPrice)
          this.tick("bybit", d.symbol, merged.lastPrice, {
            cumQuote: merged.turnover24h,
            change24: Number(merged.price24hPcnt) * 100,
          });
      },
    });
  }

  async hlVolumes() {
    try {
      const r = await fetch(HL_INFO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });
      const [meta, ctxs] = await r.json();
      meta.universe.forEach((u, i) => {
        const ctx = ctxs[i];
        if (
          !ctx ||
          u.isDelisted ||
          String(u.name || "")
            .replace(/^#/, "")
            .match(/^\d+$/)
        )
          return;
        this.tick("hyperliquid", `${u.name}USDT`, ctx.midPx || ctx.markPx, {
          cumQuote: ctx.dayNtlVlm,
          coin: u.name,
          change24:
            Number(ctx.prevDayPx) > 0
              ? ((Number(ctx.midPx || ctx.markPx) - Number(ctx.prevDayPx)) /
                  Number(ctx.prevDayPx)) *
                100
              : 0,
        });
      });
      if (!this.backfillBatches.has("hyperliquid")) {
        this.backfillBatches.add("hyperliquid");
        const top = meta.universe
          .map((coin, index) => ({ coin, volume: Number(ctxs[index]?.dayNtlVlm || 0) }))
          .filter(({ coin }) => !coin.isDelisted)
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 50);
        void Promise.allSettled(top.map(({ coin }) => this.backfillHyperliquid(coin.name)));
      }
    } catch {
      /* ignore */
    }
  }

  connectHyperliquid() {
    this.hlVolumes();
    if (!this.hlVolTimer) {
      this.hlVolTimer = setInterval(() => !this.stopped && this.hlVolumes(), 30000);
      this.timers.push(this.hlVolTimer);
    }
    this.open("hyperliquid", HL_WS, {
      ping: JSON.stringify({ method: "ping" }),
      onOpen: (ws) =>
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } })),
      onMessage: (msg) => {
        if (msg.channel !== "allMids") return;
        const mids = msg.data?.mids || {};
        for (const coin in mids) {
          if (
            coin.startsWith("@") ||
            coin.startsWith("#") ||
            coin.includes("/") ||
            /^\d+$/.test(coin.replace(/^#/, ""))
          ) {
            continue;
          }
          this.tick("hyperliquid", `${coin}USDT`, mids[coin], { coin });
        }
      },
    });
  }
}

export const liveEngine = new LiveEngine();
export { TF_MIN };
