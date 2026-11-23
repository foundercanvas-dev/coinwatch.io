const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function atr(bars, length = 14) {
  const ranges = [];
  const start = Math.max(1, bars.length - length);
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      ),
    );
  }
  return mean(ranges);
}

function clusterPivots(pivots, tolerance, totalBars) {
  const clusters = [];
  for (const pivot of pivots) {
    let cluster = clusters.find((item) => Math.abs(item.level - pivot.level) <= tolerance);
    const recencyWeight = 0.55 + 0.45 * (pivot.index / Math.max(1, totalBars - 1));
    if (!cluster) {
      cluster = { level: pivot.level, weight: 0, touches: 0, latestIndex: pivot.index };
      clusters.push(cluster);
    }
    cluster.level =
      (cluster.level * cluster.weight + pivot.level * recencyWeight) /
      (cluster.weight + recencyWeight);
    cluster.weight += recencyWeight;
    cluster.touches += 1;
    cluster.latestIndex = Math.max(cluster.latestIndex, pivot.index);
  }
  return clusters;
}

function chooseLevel(clusters, price, volatility, side, totalBars) {
  const minimumDistance = volatility * 0.18;
  const eligible = clusters.filter((cluster) =>
    side === "support"
      ? cluster.level <= price - minimumDistance
      : cluster.level >= price + minimumDistance,
  );
  if (!eligible.length) return null;
  return eligible
    .map((cluster) => {
      const distanceAtr = Math.abs(price - cluster.level) / Math.max(volatility, price * 0.0001);
      const recency = cluster.latestIndex / Math.max(1, totalBars - 1);
      return {
        ...cluster,
        score: cluster.weight * 2.4 + recency * 1.5 - Math.min(distanceAtr, 12) * 0.1,
      };
    })
    .sort((left, right) => right.score - left.score)[0];
}

export function marketStructureLevels(bars, currentPrice) {
  const price = Number(currentPrice);
  const validBars = bars.filter(
    (bar) =>
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)) &&
      Number.isFinite(Number(bar.close)) &&
      Number(bar.high) >= Number(bar.low),
  );
  const closedBars = validBars.length > 1 ? validBars.slice(0, -1) : validBars;
  if (closedBars.length < 15 || !(price > 0)) {
    return { support: null, resistance: null, supportTouches: 0, resistanceTouches: 0 };
  }

  const window = closedBars.slice(-240).map((bar) => ({
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
  }));
  const volatility = Math.max(atr(window), price * 0.0005);
  const tolerance = Math.max(volatility * 0.35, price * 0.001);
  const span = window.length >= 180 ? 4 : window.length >= 80 ? 3 : 2;
  const lows = [];
  const highs = [];

  for (let index = span; index < window.length - span; index += 1) {
    const bar = window[index];
    const neighbors = window.slice(index - span, index + span + 1);
    if (neighbors.every((neighbor) => bar.low <= neighbor.low)) {
      lows.push({ level: bar.low, index });
    }
    if (neighbors.every((neighbor) => bar.high >= neighbor.high)) {
      highs.push({ level: bar.high, index });
    }
  }

  const supportCluster = chooseLevel(
    clusterPivots(lows, tolerance, window.length),
    price,
    volatility,
    "support",
    window.length,
  );
  const resistanceCluster = chooseLevel(
    clusterPivots(highs, tolerance, window.length),
    price,
    volatility,
    "resistance",
    window.length,
  );
  const recent = window.slice(-60);
  const fallbackSupport = Math.min(...recent.map((bar) => bar.low));
  const fallbackResistance = Math.max(...recent.map((bar) => bar.high));

  return {
    support: supportCluster?.level ?? (fallbackSupport < price ? fallbackSupport : null),
    resistance:
      resistanceCluster?.level ?? (fallbackResistance > price ? fallbackResistance : null),
    supportTouches: supportCluster?.touches ?? 1,
    resistanceTouches: resistanceCluster?.touches ?? 1,
  };
}
