/**
 * Coinwach Order Flow Math Engine
 * Pure real-time calculations using free public Binance Futures data:
 * - Delta & Cumulative Volume Delta (CVD) + Divergence detection
 * - Footprint Imbalance Levels (>= 3.0x ratio)
 * - High Volume Node (HVN) Profile + POC + 70% Value Area (VAH / VAL)
 * - Heavy Absorption detection + Risk/Reward calculator
 * - MBO DOM Wall & Spoof (< 5s) detection
 */

export function computeAtr14(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const slice = candles.slice(-15);
  let sum = 0;
  let count = 0;
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    if (Number.isFinite(tr) && tr > 0) {
      sum += tr;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Computes per-candle Delta and Cumulative Volume Delta (CVD), plus Bullish/Bearish Divergence.
 * Note: Binance klines include takerBuyBaseAssetVolume (index 9) for historical candles,
 * and live aggTrades update the active candle via isBuyerMaker (true = Sell, false = Buy).
 */
export function computeDeltaAndCVD(candles) {
  if (!Array.isArray(candles) || !candles.length) {
    return { series: [], cvdSeries: [], divergence: null };
  }
  let cvd = 0;
  const series = [];
  const cvdSeries = [];

  for (const c of candles) {
    const buyVol = Number(c.buyVol ?? c.takerBuyVol ?? (c.volume || 0) * 0.5);
    const sellVol = Number(c.sellVol ?? Math.max(0, (c.volume || 0) - buyVol));
    const delta = buyVol - sellVol;
    cvd += delta;
    series.push({
      time: c.time,
      value: delta,
      buyVol,
      sellVol,
      color: delta >= 0 ? "rgba(126, 230, 163, 0.85)" : "rgba(242, 112, 124, 0.85)",
    });
    cvdSeries.push({
      time: c.time,
      value: cvd,
    });
  }

  // Divergence check over last 24 candles (split into prior 12 vs recent 12)
  let divergence = null;
  if (candles.length >= 24) {
    const priorC = candles.slice(-24, -12);
    const recentC = candles.slice(-12);
    const priorCvd = cvdSeries.slice(-24, -12);
    const recentCvd = cvdSeries.slice(-12);

    const priorMinLow = Math.min(...priorC.map((x) => x.low));
    const recentMinLow = Math.min(...recentC.map((x) => x.low));
    const priorMinCvd = Math.min(...priorCvd.map((x) => x.value));
    const recentMinCvd = Math.min(...recentCvd.map((x) => x.value));

    const priorMaxHigh = Math.max(...priorC.map((x) => x.high));
    const recentMaxHigh = Math.max(...recentC.map((x) => x.high));
    const priorMaxCvd = Math.max(...priorCvd.map((x) => x.value));
    const recentMaxCvd = Math.max(...recentCvd.map((x) => x.value));

    if (recentMinLow < priorMinLow && recentMinCvd > priorMinCvd) {
      divergence = {
        type: "BULLISH",
        side: "LONG",
        label: "Bullish CVD Divergence",
        detail: "Price made a lower low while CVD made a higher low",
        price: candles[candles.length - 1].close,
        time: candles[candles.length - 1].time,
      };
    } else if (recentMaxHigh > priorMaxHigh && recentMaxCvd < priorMaxCvd) {
      divergence = {
        type: "BEARISH",
        side: "SHORT",
        label: "Bearish CVD Divergence",
        detail: "Price made a higher high while CVD made a lower high",
        price: candles[candles.length - 1].close,
        time: candles[candles.length - 1].time,
      };
    }
  }

  return { series, cvdSeries, divergence };
}

/**
 * HVN Profile + POC + 70% Value Area (VAH / VAL) from last 100 candles across 50 price bins.
 */
export function computeHvnProfile(candles, rows = 50) {
  const window = (candles || []).slice(-100);
  if (window.length < 5) {
    return { bins: [], poc: null, vah: null, val: null, hvns: [], avgVol: 0 };
  }

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const c of window) {
    if (c.low < minLow) minLow = c.low;
    if (c.high > maxHigh) maxHigh = c.high;
  }
  const range = maxHigh - minLow;
  if (!(range > 0)) {
    return { bins: [], poc: null, vah: null, val: null, hvns: [], avgVol: 0 };
  }

  const step = range / rows;
  const bins = Array.from({ length: rows }, (_, i) => ({
    index: i,
    low: minLow + i * step,
    high: minLow + (i + 1) * step,
    price: minLow + (i + 0.5) * step,
    volume: 0,
    buyVol: 0,
    sellVol: 0,
  }));

  for (const c of window) {
    const vol = Number(c.volume || 0);
    if (!(vol > 0)) continue;
    const buyVol = Number(c.buyVol ?? c.takerBuyVol ?? vol * 0.5);
    const sellVol = Math.max(0, vol - buyVol);
    const startIdx = Math.max(0, Math.min(rows - 1, Math.floor((c.low - minLow) / step)));
    const endIdx = Math.max(0, Math.min(rows - 1, Math.floor((c.high - minLow) / step)));
    const span = endIdx - startIdx + 1;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      bins[idx].volume += vol / span;
      bins[idx].buyVol += buyVol / span;
      bins[idx].sellVol += sellVol / span;
    }
  }

  const totalVol = bins.reduce((acc, b) => acc + b.volume, 0);
  const avgVol = totalVol / rows;
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
  }

  const lastPrice = window[window.length - 1].close;
  const hvns = bins
    .filter((b) => b.volume > 1.5 * avgVol)
    .map((b) => ({
      ...b,
      isPoc: b.index === pocIdx,
      role: b.price <= lastPrice ? "SUPPORT" : "RESISTANCE",
      strength: avgVol > 0 ? +(b.volume / avgVol).toFixed(2) : 1,
    }))
    .sort((a, b) => b.volume - a.volume);

  // 70% Value Area around POC
  let vaVol = bins[pocIdx].volume;
  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  const targetVa = totalVol * 0.7;

  while (vaVol < targetVa && (lowIdx > 0 || highIdx < rows - 1)) {
    const nextLow = lowIdx > 0 ? bins[lowIdx - 1].volume : -1;
    const nextHigh = highIdx < rows - 1 ? bins[highIdx + 1].volume : -1;
    if (nextHigh >= nextLow && highIdx < rows - 1) {
      highIdx++;
      vaVol += bins[highIdx].volume;
    } else if (lowIdx > 0) {
      lowIdx--;
      vaVol += bins[lowIdx].volume;
    } else {
      break;
    }
  }

  return {
    bins,
    poc: bins[pocIdx],
    vah: bins[highIdx].high,
    val: bins[lowIdx].low,
    hvns,
    avgVol,
  };
}

/**
 * Computes Footprint price-level rows and Imbalance Levels (Ratio >= 3.0x) inside a candle's trades.
 */
export function buildFootprintLevels(trades, tickSize, minImbalanceVol = 5) {
  if (!Array.isArray(trades) || !trades.length || !(tickSize > 0)) return [];
  const map = new Map();

  for (const t of trades) {
    const price = Math.round(t.price / tickSize) * tickSize;
    const key = price.toFixed(8);
    let row = map.get(key);
    if (!row) {
      row = { price, buy: 0, sell: 0 };
      map.set(key, row);
    }
    if (t.isSell) row.sell += t.qty;
    else row.buy += t.qty;
  }

  const levels = [...map.values()].sort((a, b) => b.price - a.price);
  return levels.map((lvl) => {
    const maxV = Math.max(lvl.buy, lvl.sell);
    const minV = Math.min(lvl.buy, lvl.sell);
    const ratio = minV > 0 ? maxV / minV : maxV >= minImbalanceVol ? 99 : 1;
    const imbalanceSide =
      ratio >= 3.0 && maxV >= minImbalanceVol
        ? lvl.buy >= lvl.sell
          ? "BUY"
          : "SELL"
        : null;
    return {
      ...lvl,
      ratio: +ratio.toFixed(1),
      imbalanceSide,
    };
  });
}

/**
 * Heavy Absorption detector (strictly at recent swing Highs / swing Lows):
 * - At a recent Low: High Sell volume absorbed with price holding => Buyer Absorption (LONG)
 * - At a recent High: High Buy volume absorbed with price stalling => Seller Absorption (SHORT)
 * Confluence with HVN and Delta flip boosts signal score in the background.
 */
export function detectAbsorptionSignals(candles, symbol = "BTCUSDT", hvnProfile = null, { includeStopped = false } = {}) {
  if (!Array.isArray(candles) || candles.length < 15) return [];
  const avgVol =
    candles.slice(-40).reduce((s, c) => s + Number(c.volume || 0), 0) /
    Math.min(40, candles.length);

  const signals = [];
  const lookback = 12;
  const latestClose = candles[candles.length - 1]?.close || 0;
  let lastLongIdx = -99;
  let lastShortIdx = -99;

  for (let i = lookback; i < candles.length - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const next = candles[Math.min(candles.length - 1, i + 2)];
    const windowSlice = candles.slice(i - lookback, i + 1);
    const recentLow = Math.min(...windowSlice.map((c) => c.low));
    const recentHigh = Math.max(...windowSlice.map((c) => c.high));

    const buyVol = Number(cur.buyVol ?? cur.takerBuyVol ?? (cur.volume || 0) * 0.5);
    const sellVol = Math.max(0, Number(cur.volume || 0) - buyVol);
    const curDelta = buyVol - sellVol;
    const prevBuy = Number(prev.buyVol ?? prev.takerBuyVol ?? (prev.volume || 0) * 0.5);
    const prevDelta = prevBuy - Math.max(0, Number(prev.volume || 0) - prevBuy);

    const candleVol = Number(cur.volume || 0);

    if (!(candleVol > avgVol * 1.45)) continue;

    const atRecentLow = cur.low <= recentLow * 1.0005;
    const atRecentHigh = cur.high >= recentHigh * 0.9995;
    if (!atRecentLow && !atRecentHigh) continue;

    const nearHvn = hvnProfile?.hvns?.some(
      (h) => Math.abs(h.price - cur.close) / cur.close <= 0.004,
    );
    const deltaFlippedUp = prevDelta < 0 && curDelta > 0;
    const deltaFlippedDown = prevDelta > 0 && curDelta < 0;

    let baseScore = 62 + Math.min(20, Math.round((candleVol / Math.max(1e-9, avgVol)) * 6));
    if (nearHvn) baseScore += 8;

    // Buyer Absorption at Recent Swing Low (LONG)
    if (atRecentLow && sellVol > buyVol * 1.1 && next.close >= cur.close * 0.9992 && i - lastLongIdx >= 5) {
      lastLongIdx = i;
      let stoppedOut = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].low <= cur.low) {
          stoppedOut = true;
          break;
        }
      }

      const movePct = cur.close > 0 ? ((latestClose - cur.close) / cur.close) * 100 : 0;
      const score = Math.min(99, baseScore + (deltaFlippedUp ? 8 : 0));
      signals.push({
        id: `abs-long-${symbol}-${cur.time}`,
        type: "ABSORPTION",
        side: "LONG",
        symbol,
        time: cur.time,
        price: cur.low,
        triggerClose: cur.close,
        open: cur.open,
        high: cur.high,
        low: cur.low,
        absorbedVol: +sellVol.toFixed(1),
        absorbedUsd: Math.round(sellVol * cur.close),
        movePct: +movePct.toFixed(2),
        stoppedOut,
        reversed: false,
        score,
        nearHvn: Boolean(nearHvn),
        deltaFlip: deltaFlippedUp,
        label: `${Math.round(sellVol)}`,
        reason: `Sell flow absorbed at recent swing low (${cur.low.toFixed(2)})`,
      });
    } else if (atRecentHigh && buyVol > sellVol * 1.1 && next.close <= cur.close * 1.0008 && i - lastShortIdx >= 5) {
      lastShortIdx = i;
      let stoppedOut = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].high >= cur.high) {
          stoppedOut = true;
          break;
        }
      }

      const movePct = cur.close > 0 ? ((latestClose - cur.close) / cur.close) * 100 : 0;
      const score = Math.min(99, baseScore + (deltaFlippedDown ? 8 : 0));
      signals.push({
        id: `abs-short-${symbol}-${cur.time}`,
        type: "ABSORPTION",
        side: "SHORT",
        symbol,
        time: cur.time,
        price: cur.high,
        triggerClose: cur.close,
        open: cur.open,
        high: cur.high,
        low: cur.low,
        absorbedVol: +buyVol.toFixed(1),
        absorbedUsd: Math.round(buyVol * cur.close),
        movePct: +movePct.toFixed(2),
        stoppedOut,
        reversed: false,
        score,
        nearHvn: Boolean(nearHvn),
        deltaFlip: deltaFlippedDown,
        label: `${Math.round(buyVol)}`,
        reason: `Buy flow absorbed at recent swing high (${cur.high.toFixed(2)})`,
      });
    }
  }

  for (let k = 0; k < signals.length; k++) {
    for (let m = k + 1; m < signals.length; m++) {
      if (signals[m].side !== signals[k].side) {
        signals[k].reversed = true;
        break;
      }
    }
  }

  const filtered = includeStopped
    ? signals
    : signals.filter((s) => !s.stoppedOut && !s.reversed);

  return filtered.slice(-10).reverse();
}

/**
 * MBO DOM Heatmap + Wall (>3x average) + Spoofing (<5s vanish) analyzer.
 */
export function analyzeDomHeatmap(bids, asks, wallTrackerMap, now = Date.now(), lastPrice = 0) {
  const normBids = (bids || []).slice(0, 25).map(([p, q]) => ({
    price: Number(p),
    qty: Number(q),
    usd: Number(p) * Number(q),
  }));
  const normAsks = (asks || []).slice(0, 25).map(([p, q]) => ({
    price: Number(p),
    qty: Number(q),
    usd: Number(p) * Number(q),
  }));

  const avgBid =
    normBids.length > 0 ? normBids.reduce((s, r) => s + r.qty, 0) / normBids.length : 0;
  const avgAsk =
    normAsks.length > 0 ? normAsks.reduce((s, r) => s + r.qty, 0) / normAsks.length : 0;
  const maxQty = Math.max(
    1e-9,
    ...normBids.map((b) => b.qty),
    ...normAsks.map((a) => a.qty),
  );

  const activeKeys = new Set();
  const spoofs = [];

  const tagLevel = (row, side, avg) => {
    const ratio = avg > 0 ? row.qty / avg : 1;
    const isWall = ratio >= 3.0;
    const key = `${side}:${row.price}`;
    if (isWall) {
      activeKeys.add(key);
      if (!wallTrackerMap.has(key)) {
        wallTrackerMap.set(key, { price: row.price, side, qty: row.qty, usd: row.usd, firstSeen: now });
      }
    }
    return {
      ...row,
      side,
      ratio: +ratio.toFixed(1),
      isWall,
      intensity: Math.min(1, row.qty / maxQty),
    };
  };

  const taggedBids = normBids.map((r) => tagLevel(r, "BID", avgBid));
  const taggedAsks = normAsks.map((r) => tagLevel(r, "ASK", avgAsk)).reverse();

  // Check walls that vanished in < 5 seconds without price crossing them
  for (const [key, info] of wallTrackerMap.entries()) {
    if (!activeKeys.has(key)) {
      const ageMs = now - info.firstSeen;
      const untouched =
        info.side === "BID" ? lastPrice > info.price * 1.0002 : lastPrice < info.price * 0.9998;
      if (ageMs > 150 && ageMs < 5000 && untouched) {
        spoofs.push({
          ...info,
          ageMs,
          detectedAt: now,
        });
      }
      wallTrackerMap.delete(key);
    }
  }

  return {
    bids: taggedBids,
    asks: taggedAsks,
    buyWalls: taggedBids.filter((b) => b.isWall),
    sellWalls: taggedAsks.filter((a) => a.isWall),
    spoofs,
  };
}

/**
 * Risk / Reward calculator for Order Flow signals (1.5x ATR14 SL, TP1 2R, TP2 3.76R).
 */
export function calculateOrderFlowPlan(signal, atrAbs, riskSettings) {
  if (!signal || !(signal.price > 0)) return null;
  const entry = Number(signal.price);
  const atr = Number(atrAbs) > 0 ? Number(atrAbs) : entry * 0.0025;
  const isLong = signal.side === "LONG";
  const riskDist = 1.5 * atr;
  const sl = isLong ? entry - riskDist : entry + riskDist;
  const tp1 = isLong ? entry + 2.0 * riskDist : entry - 2.0 * riskDist;
  const tp2 = isLong ? entry + 3.76 * riskDist : entry - 3.76 * riskDist;

  const balance = Number(riskSettings?.balance) || 10000;
  const riskPct = Number(riskSettings?.riskPerTrade) || 1;
  const riskUsd = balance * (riskPct / 100);
  const stopPct = riskDist / entry;
  const positionUsd = stopPct > 0 ? riskUsd / stopPct : 0;
  const profitTp2Usd = riskUsd * 3.76;

  return {
    entry,
    sl,
    tp1,
    tp2,
    riskDist,
    rr1: 2.0,
    rr2: 3.76,
    riskUsd,
    positionUsd,
    profitTp2Usd,
  };
}

/**
 * Runs a 7-day / multi-candle backtest of Absorption + HVN Support/Resistance + Delta Flip.
 */
export function runOrderFlowBacktest(candles, atrAbs) {
  if (!Array.isArray(candles) || candles.length < 50) {
    return { trades: 0, winRate: 0, totalPnlPct: 0, maxDrawdownPct: 0, avgRR: 0 };
  }
  const profile = computeHvnProfile(candles, 50);
  const signals = detectAbsorptionSignals(candles);
  let wins = 0;
  let losses = 0;
  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  let totalR = 0;

  for (const sig of signals) {
    const idx = candles.findIndex((c) => c.time === sig.time);
    if (idx < 0 || idx >= candles.length - 2) continue;

    // Require HVN confluence within 0.35%
    const nearHvn = profile.hvns.some(
      (h) => Math.abs(h.price - sig.price) / sig.price <= 0.0035,
    );
    if (!nearHvn && !sig.deltaFlip) continue;

    const atr = atrAbs > 0 ? atrAbs : sig.price * 0.0025;
    const risk = 1.5 * atr;
    const isLong = sig.side === "LONG";
    const sl = isLong ? sig.price - risk : sig.price + risk;
    const tp = isLong ? sig.price + 2.0 * risk : sig.price - 2.0 * risk;

    let outcomeR = 0;
    for (let j = idx + 1; j < Math.min(candles.length, idx + 20); j++) {
      const bar = candles[j];
      if (isLong) {
        if (bar.low <= sl) {
          outcomeR = -1;
          break;
        }
        if (bar.high >= tp) {
          outcomeR = 2.0;
          break;
        }
      } else {
        if (bar.high >= sl) {
          outcomeR = -1;
          break;
        }
        if (bar.low <= tp) {
          outcomeR = 2.0;
          break;
        }
      }
    }
    if (outcomeR === 0) continue;
    if (outcomeR > 0) wins++;
    else losses++;

    totalR += outcomeR;
    equity *= 1 + outcomeR * 0.01;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  const total = wins + losses;
  return {
    trades: total,
    wins,
    losses,
    winRate: total > 0 ? +((wins / total) * 100).toFixed(1) : 0,
    totalPnlPct: +(equity - 100).toFixed(2),
    maxDrawdownPct: +maxDd.toFixed(2),
    avgRR: total > 0 ? +(totalR / total).toFixed(2) : 0,
  };
}
