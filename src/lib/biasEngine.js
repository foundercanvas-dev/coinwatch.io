const clip = (value, low = -1, high = 1) => Math.min(high, Math.max(low, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const DEFAULT_BIAS_MODEL = {
  w: { mom: 0.3, flow: 0.3, obi: 0.2, oi: 0.12, funding: 0.08 },
  bias: 0,
  k: 2.5,
  calibrated: false,
};

export function bookImbalance(book, band = 0.0025) {
  const bid = book.bids[0]?.[0];
  const ask = book.asks[0]?.[0];
  if (!bid || !ask) return { obi: 0, spread: Number.NaN, mid: Number.NaN, depthUsd: 0 };
  const mid = (bid + ask) / 2;
  let bidDepth = 0;
  let askDepth = 0;
  for (const [price, quantity] of book.bids) {
    const distance = (mid - price) / mid;
    if (distance > band) break;
    bidDepth += price * quantity * (1 - distance / band);
  }
  for (const [price, quantity] of book.asks) {
    const distance = (price - mid) / mid;
    if (distance > band) break;
    askDepth += price * quantity * (1 - distance / band);
  }
  const total = bidDepth + askDepth;
  return {
    obi: total > 0 ? (bidDepth - askDepth) / total : 0,
    spread: (ask - bid) / mid,
    mid,
    depthUsd: total,
  };
}

export function computeBiasFeatures(input, options = {}) {
  const params = {
    flowWindowSec: 60,
    minFlowUsd: 20_000,
    oiScale: 0.003,
    sigmaFloor: 0.0004,
    atrLen: 14,
    ...options,
  };
  const candles = input.candles;
  if (candles.length < 61 || !(input.price > 0)) return null;
  const closes = candles.map((candle) => candle.close);
  const returns = [];
  for (let index = 1; index < closes.length; index += 1) {
    if (closes[index - 1] > 0 && closes[index] > 0) {
      returns.push(Math.log(closes[index] / closes[index - 1]));
    }
  }
  const recentReturns = returns.slice(-120);
  const center = median(recentReturns);
  const sigma = Math.max(
    1.4826 * median(recentReturns.map((value) => Math.abs(value - center))),
    params.sigmaFloor,
  );

  const returnOver = (count) => Math.log(input.price / closes[closes.length - 1 - count]);
  const zscore = (count) => returnOver(count) / (sigma * Math.sqrt(count));
  const z5 = zscore(5);
  const z15 = zscore(15);
  const z60 = zscore(60);
  const momentum = Math.tanh((0.5 * z5 + 0.3 * z15 + 0.2 * z60) / 2.5);

  const since = input.now - params.flowWindowSec;
  let buy = 0;
  let sell = 0;
  for (const trade of input.trades) {
    if (trade.ts < since) continue;
    if (trade.side === "buy") buy += trade.price * trade.size;
    else sell += trade.price * trade.size;
  }
  const flowTotal = buy + sell;
  const flow =
    flowTotal > 0 ? ((buy - sell) / flowTotal) * (flowTotal / (flowTotal + params.minFlowUsd)) : 0;
  const obi = clip(1.5 * mean(input.obiHist.slice(-6)));
  const oiChange = input.oi.prev > 0 ? (input.oi.now - input.oi.prev) / input.oi.prev : 0;
  const oi = Math.sign(returnOver(5)) * Math.tanh(oiChange / params.oiScale);

  const fundingHistory = input.fundingHist || [];
  let funding = 0;
  if (fundingHistory.length >= 20) {
    const fundingMean = mean(fundingHistory);
    const variance = mean(fundingHistory.map((value) => (value - fundingMean) ** 2));
    const fundingZ = (fundingHistory.at(-1) - fundingMean) / Math.max(Math.sqrt(variance), 1e-9);
    funding = -Math.tanh(fundingZ / 2) * (Math.abs(fundingZ) > 1.5 ? 1 : 0.3);
  }

  const tail = candles.slice(-params.atrLen - 1);
  const trueRanges = [];
  for (let index = 1; index < tail.length; index += 1) {
    trueRanges.push(
      Math.max(
        tail[index].high - tail[index].low,
        Math.abs(tail[index].high - tail[index - 1].close),
        Math.abs(tail[index].low - tail[index - 1].close),
      ),
    );
  }
  const atrAbs = mean(trueRanges);
  return {
    features: { mom: momentum, flow, obi, oi, funding },
    sigma,
    atrAbs,
    atrPct: atrAbs / input.price,
    z: { z5, z15, z60 },
    flowUsd: flowTotal,
  };
}

export function scoreBias(features, model = DEFAULT_BIAS_MODEL) {
  const raw =
    Object.entries(model.w).reduce(
      (sum, [feature, weight]) => sum + weight * (features[feature] || 0),
      0,
    ) + (model.bias || 0);
  const longBias = sigmoid(model.k * raw);
  return {
    raw,
    longBias,
    shortBias: 1 - longBias,
    side: raw >= 0 ? "long" : "short",
    calibrated: model.calibrated,
  };
}

export function checkTradable({ spread, atrPct }, feeRate = TRADE_POLICY.taker_fee_per_side) {
  const cost = (Number.isFinite(spread) ? spread : 0) + 2 * feeRate;
  const reasons = [];
  if (!(atrPct >= 4 * cost)) {
    reasons.push(
      `Costs high vs ATR (${(cost * 100).toFixed(3)}% cost / ${(atrPct * 100).toFixed(3)}% ATR)`,
    );
  }
  return { ok: reasons.length === 0, reasons, cost };
}

export class BiasSignalTracker {
  constructor(options = {}) {
    this.options = {
      enter: 0.3,
      confirm: 0.25,
      agree: 0.7,
      flipAbort: -0.1,
      windowSec: 60,
      minSamples: 8,
      ttlSec: 300,
      cooldownSec: 120,
      oneShot: false,
      maxAdverseAtr: 1,
      stopAtr: 1.2,
      targetsR: [1.5, 2.5],
      ...options,
    };
    this.cooldownUntil = 0;
    this.reset();
  }

  reset() {
    this.state = "idle";
    this.side = 0;
    this.samples = [];
    this.startedAt = 0;
    this.entryPrice = 0;
    this.confirmedAt = 0;
    this.plan = null;
    this.reason = "";
  }

  end(state, reason, timestamp) {
    this.state = state;
    this.reason = reason;
    this.cooldownUntil = timestamp + this.options.cooldownSec;
  }

  update(timestamp, score, price, atrAbs, tradable = true) {
    const options = this.options;
    if (["invalidated", "expired", "stopped", "reversed"].includes(this.state)) {
      if (options.oneShot) return this.snapshot(timestamp);
      const nextSide = Math.sign(score);
      const oppositeSetup =
        Math.abs(score) >= options.enter && nextSide !== 0 && nextSide !== this.side;
      if (oppositeSetup || timestamp >= this.cooldownUntil) {
        this.reset();
        if (oppositeSetup) this.cooldownUntil = timestamp;
      }
    }
    if (this.state === "idle") {
      if (Math.abs(score) >= options.enter && timestamp >= this.cooldownUntil) {
        this.state = "watching";
        this.side = Math.sign(score);
        this.startedAt = timestamp;
        this.entryPrice = price;
        this.samples = [tradable ? score : 0];
      }
    } else if (this.state === "watching") {
      this.samples.push(tradable ? score : 0);
      const against = score * this.side <= options.flipAbort;
      const adverse = atrAbs > 0 ? ((this.entryPrice - price) * this.side) / atrAbs : 0;
      if (against) this.end("invalidated", "Bias flipped", timestamp);
      else if (adverse >= options.maxAdverseAtr)
        this.end("invalidated", "Price moved against bias", timestamp);
      else if (timestamp - this.startedAt >= options.windowSec) {
        const count = this.samples.length;
        const meanScore = mean(this.samples) * this.side;
        const agreement = this.samples.filter((value) => value * this.side > 0).length / count;
        if (
          count >= options.minSamples &&
          meanScore >= options.confirm &&
          agreement >= options.agree
        ) {
          const risk = options.stopAtr * atrAbs;
          this.state = "confirmed";
          this.confirmedAt = timestamp;
          this.plan = {
            side: this.side > 0 ? "long" : "short",
            entryRef: price,
            stop: price - this.side * risk,
            targets: options.targetsR.map((ratio) => price + this.side * risk * ratio),
            riskPct: risk / price,
          };
        } else {
          this.end(
            "invalidated",
            count < options.minSamples ? "Too few samples" : "Weak or inconsistent bias",
            timestamp,
          );
        }
      }
    } else if (this.state === "confirmed") {
      if (score * this.side <= options.flipAbort) this.end("reversed", "Bias reversed", timestamp);
      else if ((price - this.plan.stop) * this.side <= 0)
        this.end("stopped", "Stop level hit", timestamp);
      else if (timestamp - this.confirmedAt >= options.ttlSec)
        this.end("expired", "Signal expired", timestamp);
    }
    return this.snapshot(timestamp);
  }

  snapshot(timestamp) {
    const watching = this.state === "watching";
    return {
      state: this.state,
      side: this.side > 0 ? "long" : this.side < 0 ? "short" : null,
      progress: watching
        ? Math.min(1, (timestamp - this.startedAt) / this.options.windowSec)
        : this.state === "confirmed"
          ? 1
          : 0,
      meanScore: this.samples.length ? mean(this.samples) : 0,
      plan: this.state === "confirmed" ? this.plan : null,
      reason: this.reason,
      windowEndsAt: watching ? this.startedAt + this.options.windowSec : null,
      expiresAt: this.state === "confirmed" ? this.confirmedAt + this.options.ttlSec : null,
    };
  }
}
import { TRADE_POLICY } from "./signalPolicy";
