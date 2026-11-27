/**
 * High-Accuracy OrderFlow Signal & Zone Engine (8-Step Exact Formula)
 * - Step 1: ATR * 0.25 price bins over timeframe lookback (5m=200, 15m=120, 1h=100)
 * - Step 2: Volume_at_Price(P) = Sum of (Candle_Volume / Candle_Range) for touched bins
 * - Step 3: POC = bin with max Volume_at_Price
 * - Step 4: HVN >= 1.8x Average_Volume; merge within 0.15% using VWAP Sum(P*V)/Sum(V)
 * - Step 5: Label SUPPORT / RESISTANCE / POC
 * - Step 6: X = Volume_at_Zone / Average_Volume
 * - Step 7: Score = (min(X,4)/4*40) + (min(Touches,4)/4*30) + (min(DOM,3)/3*15) + (Reaction_Strength*15)
 * - Step 8: Incremental DOM score refresh without full history recalculation
 */

import { computeAtr14 } from "./orderflowMath.js";

export function getXMultiplier(zoneVolume, avgZoneVolume) {
  if (!(avgZoneVolume > 0) || !(zoneVolume > 0)) return 0;
  return +(zoneVolume / avgZoneVolume).toFixed(1);
}

export function calculateZoneScore({
  xMultiplier = 0,
  touches = 0,
  domDepthRatio = 0,
  reactionStrength = 0,
}) {
  const xPart = (Math.min(xMultiplier, 4.0) / 4.0) * 40;
  const touchPart = (Math.min(touches, 4) / 4) * 30;
  const domPart = (Math.min(domDepthRatio, 3.0) / 3.0) * 15;
  const reactPart = Math.min(1.0, Math.max(0, reactionStrength)) * 15;
  return Math.max(0, Math.min(100, Math.round(xPart + touchPart + domPart + reactPart)));
}

function formatCompact(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

export function getLookbackForTimeframe(timeframe = "5m") {
  const tf = String(timeframe || "5m").toLowerCase();
  if (tf === "1m") return 300;
  if (tf === "3m") return 250;
  if (tf === "5m") return 200;
  if (tf === "15m") return 120;
  return 100; // 1h, 4h, 1d = 100 candles
}

/**
 * Steps 1-7: Generates merged, scored, non-broken high-confidence zones (max 2: 1 Support, 1 Resistance).
 */
export function buildHighConfidenceZones(candles, dom = null, currentPrice = 0, timeframe = "5m") {
  if (!Array.isArray(candles) || candles.length < 25) return [];
  const lookback = getLookbackForTimeframe(timeframe);
  const slice = candles.slice(-lookback);
  const lastPrice = currentPrice || slice[slice.length - 1].close;
  const avgCandleVol = slice.reduce((s, c) => s + (c.volume || 0), 0) / slice.length;
  const atr = computeAtr14(slice);

  // Step 1: Price bins of size = ATR * 0.25
  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const c of slice) {
    if (c.low < minLow) minLow = c.low;
    if (c.high > maxHigh) maxHigh = c.high;
  }
  const totalRange = maxHigh - minLow;
  if (!(totalRange > 0)) return [];

  const rawBinSize = atr > 0 ? atr * 0.25 : totalRange / 50;
  const binSize = totalRange / rawBinSize > 300 ? totalRange / 300 : rawBinSize;
  const numBins = Math.max(10, Math.ceil(totalRange / binSize));

  const bins = Array.from({ length: numBins }, (_, i) => {
    const low = minLow + i * binSize;
    const high = low + binSize;
    return {
      index: i,
      low,
      high,
      price: (low + high) / 2,
      volume: 0,
    };
  });

  // Step 2: Volume_at_Price(P) = Sum of (Candle_Volume / Candle_Range) * binSize for touched bins
  for (const c of slice) {
    const cRange = c.high - c.low;
    const volPerBin = cRange > 0 ? ((c.volume || 0) / cRange) * binSize : c.volume || 0;
    const startIdx = Math.max(0, Math.floor((c.low - minLow) / binSize));
    const endIdx = Math.min(numBins - 1, Math.floor((c.high - minLow) / binSize));
    for (let i = startIdx; i <= endIdx; i++) {
      bins[i].volume += volPerBin;
    }
  }

  // Step 3: POC = bin with MAX Volume_at_Price
  let totalBinVol = 0;
  let pocBin = bins[0];
  for (const b of bins) {
    totalBinVol += b.volume;
    if (b.volume > pocBin.volume) pocBin = b;
  }
  const avgBinVol = totalBinVol / bins.length;
  if (!(avgBinVol > 0)) return [];

  // Step 4: HVN >= 1.8x Average_Volume + Merge within 0.15% using VWAP Sum(P*V)/Sum(V)
  const hvnBins = bins
    .filter((b) => b.volume >= 1.8 * avgBinVol)
    .sort((a, b) => b.volume - a.volume);

  const clusters = [];
  for (const h of hvnBins) {
    const match = clusters.find(
      (cl) => cl.price > 0 && Math.abs(h.price - cl.price) / cl.price <= 0.0015,
    );
    if (!match) {
      clusters.push({
        index: h.index,
        low: h.low,
        high: h.high,
        price: h.price,
        volume: h.volume,
        sumPV: h.price * h.volume,
        sumV: h.volume,
        isPoc: h.index === pocBin.index,
      });
    } else {
      match.low = Math.min(match.low, h.low);
      match.high = Math.max(match.high, h.high);
      match.sumPV += h.price * h.volume;
      match.sumV += h.volume;
      match.price = match.sumPV / match.sumV;
      match.volume = Math.max(match.volume, h.volume);
      if (h.index === pocBin.index) match.isPoc = true;
    }
  }

  // Average DOM size for depth scoring
  const allDomRows = [...(dom?.bids || []), ...(dom?.asks || [])];
  const avgDomSize = allDomRows.length
    ? allDomRows.reduce((s, r) => s + (r.qty || 0), 0) / allDomRows.length
    : 0;

  const scored = [];
  const minReverseMove = atr > 0 ? atr * 0.5 : lastPrice * 0.0015;

  for (const z of clusters) {
    // Touches = times price touched zone and reversed by >= 0.5x ATR within next 5 candles
    let touches = 0;
    let lastTouchBuy = 0;
    let lastTouchSell = 0;
    let lastTouchIdx = -1;
    let lastReversalCandleRange = 0;
    let cooldown = -1;

    for (let i = 0; i < slice.length - 1; i++) {
      const c = slice[i];
      if (i <= cooldown) continue;
      if (c.low <= z.high * 1.001 && c.high >= z.low * 0.999) {
        const fromBelow = c.open < z.price;
        const end = Math.min(slice.length - 1, i + 5);
        for (let j = i + 1; j <= end; j++) {
          const f = slice[j];
          const reversed = fromBelow
            ? z.price - f.low >= minReverseMove
            : f.high - z.price >= minReverseMove;
          if (reversed) {
            touches++;
            lastTouchIdx = i;
            lastTouchBuy = c.buyVol || c.volume * 0.5;
            lastTouchSell = c.sellVol || c.volume * 0.5;
            lastReversalCandleRange = Math.abs(f.close - f.open);
            break;
          }
        }
        cooldown = i + 5;
      }
    }

    const ageCandles = lastTouchIdx >= 0 ? slice.length - 1 - lastTouchIdx : slice.length;
    const pxStr = z.price >= 100 ? z.price.toFixed(2) : z.price.toFixed(5);

    // Zone expiry: > 200 candles without touch => EXPIRED
    if (ageCandles > 200) {
      console.log(
        `Zone ${pxStr} | Lookback ${lookback} | Touches ${touches} | Age ${ageCandles} candles | Status EXPIRED`,
      );
      continue;
    }

    // Broken check: strong high-volume close through zone => BROKEN
    let broken = false;
    const checkFrom = Math.max(0, slice.length - 12);
    for (let i = Math.max(checkFrom, lastTouchIdx); i < slice.length; i++) {
      const c = slice[i];
      const highVol = avgCandleVol > 0 && c.volume >= avgCandleVol * 1.3;
      if (!highVol) continue;
      if (z.price <= lastPrice && c.close < z.low * 0.9985 && c.open >= z.low * 0.9985) {
        broken = true;
        break;
      }
      if (z.price > lastPrice && c.close > z.high * 1.0015 && c.open <= z.high * 1.0015) {
        broken = true;
        break;
      }
    }
    if (broken) {
      console.log(
        `Zone ${pxStr} | Lookback ${lookback} | Touches ${touches} | Age ${ageCandles} candles | Status BROKEN`,
      );
      continue;
    }

    // Reaction_Strength (0.3 to 1.0) from last reversal speed/candle size vs ATR
    const reactionStrength =
      touches > 0
        ? Math.min(1.0, Math.max(0.3, atr > 0 ? lastReversalCandleRange / atr : 0.6))
        : 0;

    // DOM Depth Ratio at zone
    const depthAtZone = allDomRows
      .filter((r) => z.price > 0 && Math.abs(r.price - z.price) / z.price <= 0.002)
      .reduce((s, r) => s + (r.qty || 0), 0);
    const depthRatio = avgDomSize > 0 ? +(depthAtZone / avgDomSize).toFixed(1) : 0;

    // Step 6 & 7: X Multiplier + Exact Score
    const xMultiplier = getXMultiplier(z.volume, avgBinVol);
    const score = calculateZoneScore({
      xMultiplier,
      touches,
      domDepthRatio: depthRatio,
      reactionStrength,
    });

    // Step 5: Label SUPPORT / RESISTANCE / POC
    const side = z.price <= lastPrice ? "SUPPORT" : "RESISTANCE";
    const label = z.isPoc ? "POC" : side;
    const isHighConfidence = score >= 85 && xMultiplier >= 2.0 && touches >= 2;
    const confidence = isHighConfidence ? "HIGH" : "MEDIUM";
    const confidenceLabel = isHighConfidence ? "HIGH CONFIDENCE" : "MEDIUM";

    console.log(`Zone ${pxStr} | X ${xMultiplier}x | Touches ${touches} | Score ${score}`);
    console.log(
      `Zone ${pxStr} | Lookback ${lookback} | Touches ${touches} | Age ${ageCandles} candles | Status ACTIVE`,
    );

    const totalTouchVol = lastTouchBuy + lastTouchSell;
    const buyersPct = totalTouchVol > 0 ? Math.round((lastTouchBuy / totalTouchVol) * 100) : 50;
    const sellersPct = 100 - buyersPct;

    scored.push({
      ...z,
      side,
      label,
      xMultiplier,
      reactionStrength: +reactionStrength.toFixed(2),
      score,
      confidence,
      confidenceLabel,
      touches,
      reactions: touches,
      ageCandles,
      lookback,
      reactionRate: touches > 0 ? 100 : 0,
      buyersPct,
      sellersPct,
      depthAtZone,
      depthRatio,
      strongLimitOrders: depthRatio >= 2.0,
      volumeLabel: formatCompact(z.volume),
    });
  }

  // Prefer Score >= 75; if historical zones have 0 DOM depth nearby, still show strongest POC + Support + Resistance
  const highScored = scored.filter((z) => z.score >= 75);
  const pool = highScored.length ? highScored : [...scored].sort((a, b) => b.volume - a.volume);
  const supports = pool.filter((z) => z.price <= lastPrice).sort((a, b) => b.price - a.price);
  const resistances = pool.filter((z) => z.price > lastPrice).sort((a, b) => a.price - b.price);
  const pocZone = pool.find((z) => z.isPoc);

  const visible = [];
  if (pocZone) visible.push(pocZone);
  if (supports[0] && !visible.some((v) => v.index === supports[0].index)) visible.push(supports[0]);
  if (resistances[0] && !visible.some((v) => v.index === resistances[0].index)) visible.push(resistances[0]);
  return visible.slice(0, 3);
}

/**
 * Step 8: Incremental DOM score refresh on new order book updates (without recalculating full history).
 */
export function refreshZonesOnDomUpdate(zones, dom, currentPrice = 0) {
  if (!Array.isArray(zones) || !zones.length || !dom) return zones || [];
  const allDomRows = [...(dom.bids || []), ...(dom.asks || [])];
  if (!allDomRows.length) return zones;
  const avgDomSize = allDomRows.reduce((s, r) => s + (r.qty || 0), 0) / allDomRows.length;

  const updated = [];
  for (const z of zones) {
    const depthAtZone = allDomRows
      .filter((r) => z.price > 0 && Math.abs(r.price - z.price) / z.price <= 0.002)
      .reduce((s, r) => s + (r.qty || 0), 0);
    const depthRatio = avgDomSize > 0 ? +(depthAtZone / avgDomSize).toFixed(1) : 0;
    const score = calculateZoneScore({
      xMultiplier: z.xMultiplier,
      touches: z.touches,
      domDepthRatio: depthRatio,
      reactionStrength: z.reactionStrength || 0,
    });
    if (score < 75) continue; // Hide immediately if Score drops below 75
    const side = currentPrice > 0 ? (z.price <= currentPrice ? "SUPPORT" : "RESISTANCE") : z.side;
    const isHighConfidence = score >= 85 && z.xMultiplier >= 2.0 && z.touches >= 2;
    updated.push({
      ...z,
      side,
      label: z.isPoc ? "POC" : side,
      depthAtZone,
      depthRatio,
      strongLimitOrders: depthRatio >= 2.0,
      score,
      confidence: isHighConfidence ? "HIGH" : "MEDIUM",
      confidenceLabel: isHighConfidence ? "HIGH CONFIDENCE" : "MEDIUM",
    });
  }
  return updated;
}

/**
 * Step 2 (Tap + Absorption): Check Absorption within 3 candles after a zone tap.
 */
export function checkAbsorption(candles, zone, avgCandleVol) {
  if (!Array.isArray(candles) || !zone || !(avgCandleVol > 0)) return null;
  const recent = candles.slice(-8);
  let tapIdx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    if (c.low <= zone.high * 1.0005 && c.high >= zone.low * 0.9995) {
      tapIdx = i;
      break;
    }
  }
  if (tapIdx < 0) return null;

  const isSupport = zone.side === "SUPPORT";
  const windowEnd = Math.min(recent.length - 1, tapIdx + 3);
  let absorbedVol = 0;
  let heldZone = true;
  let absCandle = recent[tapIdx];

  for (let i = tapIdx; i <= windowEnd; i++) {
    const c = recent[i];
    if (isSupport && c.close < zone.low * 0.9985) {
      heldZone = false;
      break;
    }
    if (!isSupport && c.close > zone.high * 1.0015) {
      heldZone = false;
      break;
    }
    const aggressiveVol = isSupport ? c.sellVol || c.volume * 0.5 : c.buyVol || c.volume * 0.5;
    absorbedVol += aggressiveVol;
    if (aggressiveVol >= (absCandle.volume || 0) * 0.5) absCandle = c;
  }

  if (!heldZone) return { tapIdx, absorbedVol, xRatio: 0, confirmed: false, isHuge: false, candle: absCandle };
  const xRatio = +(absorbedVol / avgCandleVol).toFixed(1);
  return {
    tapIdx,
    recent,
    candle: absCandle,
    absorbedVol,
    xRatio,
    confirmed: xRatio >= 1.5,
    isHuge: xRatio >= 2.0,
    side: isSupport ? "LONG" : "SHORT",
  };
}

/**
 * Step 3 (Confirmation): Check Imbalance confirmation candle after absorption.
 */
export function checkImbalance(recent, zone, absResult) {
  if (!absResult?.confirmed || !Array.isArray(recent)) return null;
  const isSupport = zone.side === "SUPPORT";
  const start = Math.min(recent.length - 1, absResult.tapIdx + 1);
  for (let i = start; i < recent.length; i++) {
    const c = recent[i];
    const buy = c.buyVol || c.volume * 0.5;
    const sell = c.sellVol || c.volume * 0.5;
    if (isSupport) {
      const bullishClose = c.close > c.open && c.close > zone.high;
      const buyImbalance = sell > 0 ? buy / sell >= 1.5 : buy > 0;
      if (bullishClose && buyImbalance) {
        return { confirmed: true, candle: c, ratio: sell > 0 ? +(buy / sell).toFixed(1) : 2.0 };
      }
    } else {
      const bearishClose = c.close < c.open && c.close < zone.low;
      const sellImbalance = buy > 0 ? sell / buy >= 1.5 : sell > 0;
      if (bearishClose && sellImbalance) {
        return { confirmed: true, candle: c, ratio: buy > 0 ? +(sell / buy).toFixed(1) : 2.0 };
      }
    }
  }
  return null;
}

/**
 * Evaluates State 1 (WAITING), State 2 (TAP_ABSORBING), State 3 (CONFIRMED), State 4 (INVALIDATED).
 */
export function getSignalState(candles, zones, dom = null, currentPrice = 0) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return { state: "WAITING", message: "Loading high-confidence zones…", zone: null };
  }
  const lastBar = candles[candles.length - 1];
  const px = currentPrice || lastBar.close;
  const avgCandleVol =
    candles.slice(-50).reduce((s, c) => s + (c.volume || 0), 0) / Math.min(50, candles.length);
  const atr14 = computeAtr14(candles);

  if (!zones?.length) {
    return {
      state: "WAITING",
      message: "NO SIGNAL YET - Waiting for 1.5x absorption",
      zone: null,
    };
  }

  const candidates = zones.map((zone) => {
    const highVol = avgCandleVol > 0 && lastBar.volume >= avgCandleVol * 1.3;
    if (
      highVol &&
      ((zone.side === "SUPPORT" && lastBar.close < zone.low * 0.9985) ||
        (zone.side === "RESISTANCE" && lastBar.close > zone.high * 1.0015))
    ) {
      return {
        priority: 0,
        result: { state: "INVALIDATED", message: "Zone broken, signal cancelled", zone },
      };
    }

    const abs = checkAbsorption(candles, zone, avgCandleVol);
    if (!abs) {
      return {
        priority: 1,
        dist: Math.abs(zone.price - px),
        result: { state: "WAITING", message: "NO SIGNAL YET - Waiting for 1.5x absorption", zone },
      };
    }

    if (!abs.confirmed) {
      return {
        priority: 1,
        dist: Math.abs(zone.price - px),
        result: {
          state: "WAITING",
          message: "NO SIGNAL YET - Waiting for 1.5x absorption",
          zone,
          absorption: abs,
        },
      };
    }

    const imb = checkImbalance(abs.recent, zone, abs);
    if (!imb?.confirmed) {
      return {
        priority: 2,
        dist: Math.abs(zone.price - px),
        result: {
          state: "TAP_ABSORBING",
          message: `Tap detected, watching absorption... ${zone.side === "SUPPORT" ? "Sellers" : "Buyers"}: ${formatCompact(abs.absorbedVol)} absorbed (${abs.xRatio}x) — Absorption watched, no confirmation`,
          zone,
          absorption: abs,
        },
      };
    }

    const isLong = zone.side === "SUPPORT";
    const entry = imb.candle.close;
    const buffer = zone.price * 0.002 + atr14;
    let sl = isLong ? zone.low - buffer : zone.high + buffer;
    if (isLong && sl >= zone.low) sl = zone.low - Math.max(zone.price * 0.002, atr14);
    else if (!isLong && sl <= zone.high) sl = zone.high + Math.max(zone.price * 0.002, atr14);

    const risk = Math.abs(entry - sl);
    const tp1 = isLong ? entry + 1.5 * risk : Math.max(0, entry - 1.5 * risk);
    const tp2 = isLong ? entry + 2.0 * risk : Math.max(0, entry - 2.0 * risk);
    const rr = risk > 0 ? +(Math.abs(tp2 - entry) / risk).toFixed(2) : 0;

    if (rr < 1.5) {
      return {
        priority: 1,
        dist: Math.abs(zone.price - px),
        result: { state: "WAITING", message: "R:R below 1:1.5 — Waiting for better structure", zone },
      };
    }

    return {
      priority: 3,
      dist: Math.abs(zone.price - px),
      result: {
        state: "CONFIRMED",
        side: isLong ? "LONG" : "SHORT",
        message: `${isLong ? "LONG" : "SHORT"} CONFIRMED: ${abs.xRatio}x Absorbed + Imbalance`,
        zone,
        absorption: abs,
        imbalance: imb,
        entry,
        sl,
        tp1,
        tp2,
        rr,
      },
    };
  });

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (a.dist ?? 0) - (b.dist ?? 0);
  });
  return candidates[0].result;
}
