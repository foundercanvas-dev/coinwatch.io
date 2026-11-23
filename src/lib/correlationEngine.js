export const CORRELATION_DEFAULTS = {
  estimationBars: 240,
  triggerBars: 5,
  maxLag: 5,
  minCoverage: 0.8,
  min24hUsd: 500_000,
  minTriggerZ: 3,
  confidenceZ: 3,
  minRhoLowerBound: 0.25,
  movingRatio: 0.6,
  gapZ: 1.5,
  sigmaFloor: 0.0003,
};

const finite = Number.isFinite;
const clip = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustSigma(values, floor) {
  const center = median(values);
  return Math.max(
    1.4826 * median(values.filter(finite).map((value) => Math.abs(value - center))),
    floor,
  );
}

export function marketFactor(symbols) {
  const keys = Object.keys(symbols);
  if (!keys.length) return [];
  const length = symbols[keys[0]].returns.length;
  return Array.from(
    { length },
    (_, index) => median(keys.map((key) => symbols[key].returns[index])) || 0,
  );
}

export function pearson(left, right) {
  let count = 0;
  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (finite(left[index]) && finite(right[index])) {
      count += 1;
      sumLeft += left[index];
      sumRight += right[index];
    }
  }
  if (count < 5) return { rho: Number.NaN, count };
  const meanLeft = sumLeft / count;
  const meanRight = sumRight / count;
  let varianceLeft = 0;
  let varianceRight = 0;
  let covariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (finite(left[index]) && finite(right[index])) {
      const deltaLeft = left[index] - meanLeft;
      const deltaRight = right[index] - meanRight;
      varianceLeft += deltaLeft * deltaLeft;
      varianceRight += deltaRight * deltaRight;
      covariance += deltaLeft * deltaRight;
    }
  }
  return {
    rho:
      varianceLeft > 0 && varianceRight > 0
        ? covariance / Math.sqrt(varianceLeft * varianceRight)
        : Number.NaN,
    count,
    covariance: covariance / (count - 1),
    varianceLeft: varianceLeft / (count - 1),
  };
}

export function rhoLowerBound(rho, count, confidenceZ = 3) {
  if (!finite(rho) || count < 8) return 0;
  const bounded = Math.max(-0.999, Math.min(0.999, rho));
  const fisher = Math.atanh(Math.abs(bounded)) - confidenceZ / Math.sqrt(count - 3);
  return fisher > 0 ? Math.tanh(fisher) : 0;
}

function betaOn(returns, factor, start, end) {
  const relation = pearson(factor.slice(start, end), returns.slice(start, end));
  return finite(relation.covariance) && relation.varianceLeft > 0
    ? relation.covariance / relation.varianceLeft
    : 0;
}

function residual(returns, factor, beta) {
  return returns.map((value, index) => (finite(value) ? value - beta * factor[index] : Number.NaN));
}

function crossAt(trigger, candidate, start, end, lag) {
  const left = [];
  const right = [];
  for (let index = start; index < end; index += 1) {
    const shifted = index + lag;
    if (shifted < start || shifted >= end) continue;
    left.push(trigger[index]);
    right.push(candidate[shifted]);
  }
  return { ...pearson(left, right), left, right };
}

export function analyzeCorrelationTrigger({ triggerSymbol, symbols, factor }, options = {}) {
  const params = { ...CORRELATION_DEFAULTS, ...options };
  const trigger = symbols[triggerSymbol];
  if (!trigger) return { ok: false, reason: "trigger unavailable" };
  const length = trigger.returns.length;
  const estimationStart = length - params.triggerBars - params.estimationBars;
  const estimationEnd = length - params.triggerBars;
  const triggerStart = length - params.triggerBars;
  if (estimationStart < 0)
    return {
      ok: false,
      reason: "not enough aligned bars",
    };

  const triggerMarketBeta = betaOn(trigger.returns, factor, estimationStart, estimationEnd);
  const triggerResidual = residual(trigger.returns, factor, triggerMarketBeta);
  const triggerSigma = robustSigma(
    triggerResidual.slice(estimationStart, estimationEnd),
    params.sigmaFloor,
  );
  const triggerMove = triggerResidual
    .slice(triggerStart)
    .reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
  const triggerZ = triggerMove / (triggerSigma * Math.sqrt(params.triggerBars));
  if (Math.abs(triggerZ) < params.minTriggerZ) {
    return {
      ok: false,
      reason: `trigger residual move too small (z=${triggerZ.toFixed(1)})`,
      triggerZ,
    };
  }

  const rows = [];
  for (const [symbol, candidate] of Object.entries(symbols)) {
    if (symbol === triggerSymbol || candidate.usd24h < params.min24hUsd) continue;
    const coverage =
      candidate.returns.slice(estimationStart, estimationEnd).filter(finite).length /
      params.estimationBars;
    if (coverage < params.minCoverage) continue;

    const marketBeta = betaOn(candidate.returns, factor, estimationStart, estimationEnd);
    const candidateResidual = residual(candidate.returns, factor, marketBeta);
    const candidateSigma = robustSigma(
      candidateResidual.slice(estimationStart, estimationEnd),
      params.sigmaFloor,
    );

    let best = null;
    for (let lag = -params.maxLag; lag <= params.maxLag; lag += 1) {
      const correlation = crossAt(
        triggerResidual,
        candidateResidual,
        estimationStart,
        estimationEnd,
        lag,
      );
      if (!finite(correlation.rho)) continue;
      const lowerBound = rhoLowerBound(correlation.rho, correlation.count, params.confidenceZ);
      if (
        !best ||
        lowerBound > best.lowerBound + 1e-9 ||
        (Math.abs(lowerBound - best.lowerBound) <= 1e-9 && Math.abs(lag) < Math.abs(best.lag))
      ) {
        best = {
          lag,
          rho: correlation.rho,
          count: correlation.count,
          lowerBound,
          left: correlation.left,
          right: correlation.right,
        };
      }
    }
    if (!best || best.lowerBound < params.minRhoLowerBound) continue;

    const residualRelation = pearson(best.left, best.right);
    const triggerVariance = pearson(best.left, best.left).varianceLeft;
    const beta = triggerVariance > 0 ? residualRelation.covariance / triggerVariance : 0;
    const actual = candidateResidual
      .slice(triggerStart)
      .reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
    const expected = beta * triggerMove;
    const direction = Math.sign(expected) || 1;
    const scale = candidateSigma * Math.sqrt(params.triggerBars);
    const actualZ = actual / scale;
    const gapSigma = ((expected - actual) * direction) / scale;
    const responseRatio = expected !== 0 ? actual / expected : 0;

    let status = "neutral";
    if (responseRatio >= params.movingRatio && actualZ * direction >= 1.5) status = "moving";
    else if (gapSigma >= params.gapZ) status = "lagging";
    else if (actualZ * direction <= -2) status = "diverging";

    const correlationStrength = clip(best.lowerBound / 0.7);
    const liquidity = clip(Math.log10(Math.max(candidate.usd24h, 1) / 1e6) / 2);
    const timing =
      status === "lagging"
        ? clip(gapSigma / 4)
        : status === "moving"
          ? 0.5 * clip(Math.abs(actualZ) / 4)
          : 0;
    const score = 100 * (0.55 * correlationStrength + 0.3 * timing + 0.15 * liquidity);

    rows.push({
      symbol,
      relation: best.rho >= 0 ? "positive" : "negative",
      rho: best.rho,
      rhoLowerBound: best.lowerBound,
      lag: best.lag,
      sampleSize: best.count,
      beta,
      marketBeta,
      expected,
      actual,
      actualZ,
      gapSigma,
      responseRatio,
      status,
      direction: expected >= 0 ? "long" : "short",
      score: Math.round(score),
    });
  }
  rows.sort((left, right) => right.score - left.score);
  return {
    ok: true,
    trigger: {
      symbol: triggerSymbol,
      zMove: triggerZ,
      move: triggerMove,
      side: triggerMove >= 0 ? "pump" : "dump",
    },
    rows,
    summary: summarizeCorrelation(rows),
  };
}

export function summarizeCorrelation(rows) {
  const related = rows.filter((row) => row.relation === "positive" && row.rhoLowerBound >= 0.3);
  const moving = related.filter((row) => row.status === "moving").length;
  const followers = related.filter((row) => row.lag > 0).length;
  const leaders = related.filter((row) => row.lag < 0).length;
  const breadth = related.length ? moving / related.length : 0;
  return {
    related: related.length,
    moving,
    lagging: related.filter((row) => row.status === "lagging").length,
    breadth,
    type:
      related.length >= 4 && breadth >= 0.5
        ? "sector-wide"
        : breadth < 0.15
          ? "idiosyncratic"
          : "spreading",
    role:
      followers >= 2 * Math.max(1, leaders)
        ? "leader"
        : leaders >= 2 * Math.max(1, followers)
          ? "follower"
          : "mixed",
  };
}

export function correlationBiasFeature(row) {
  if (!row || row.status !== "lagging") return 0;
  return Math.sign(row.expected) * clip(row.rhoLowerBound / 0.7) * Math.tanh(row.gapSigma / 3);
}

export function analyzeAnchorRelationships({ anchorSymbol, symbols, factor }, options = {}) {
  const params = { ...CORRELATION_DEFAULTS, ...options };
  const anchor = symbols[anchorSymbol];
  if (!anchor) return { ok: false, reason: "anchor unavailable" };
  const length = anchor.returns.length;
  const start = length - params.estimationBars;
  const end = length;
  if (start < 0) return { ok: false, reason: "not enough aligned bars" };

  const anchorMarketBeta = betaOn(anchor.returns, factor, start, end);
  const anchorResidual = residual(anchor.returns, factor, anchorMarketBeta);
  const recentStart = Math.max(start, end - params.triggerBars);
  const anchorRecentMove = anchorResidual
    .slice(recentStart, end)
    .reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
  const rows = [];

  for (const [symbol, candidate] of Object.entries(symbols)) {
    if (symbol === anchorSymbol || candidate.usd24h < params.min24hUsd) continue;
    const coverage =
      candidate.returns.slice(start, end).filter(finite).length / params.estimationBars;
    if (coverage < params.minCoverage) continue;

    const marketBeta = betaOn(candidate.returns, factor, start, end);
    const candidateResidual = residual(candidate.returns, factor, marketBeta);
    let best = null;
    for (let lag = -params.maxLag; lag <= params.maxLag; lag += 1) {
      const correlation = crossAt(anchorResidual, candidateResidual, start, end, lag);
      if (!finite(correlation.rho)) continue;
      const lowerBound = rhoLowerBound(correlation.rho, correlation.count, params.confidenceZ);
      if (
        !best ||
        lowerBound > best.lowerBound + 1e-9 ||
        (Math.abs(lowerBound - best.lowerBound) <= 1e-9 && Math.abs(lag) < Math.abs(best.lag))
      ) {
        best = {
          lag,
          rho: correlation.rho,
          count: correlation.count,
          lowerBound,
          left: correlation.left,
          right: correlation.right,
        };
      }
    }
    if (!best || best.lowerBound < params.minRhoLowerBound) continue;

    const relation = pearson(best.left, best.right);
    const anchorVariance = pearson(best.left, best.left).varianceLeft;
    const beta = anchorVariance > 0 ? relation.covariance / anchorVariance : 0;
    const actualMove = candidateResidual
      .slice(recentStart, end)
      .reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
    const expectedMove = beta * anchorRecentMove;
    const responseRatio = expectedMove !== 0 ? actualMove / expectedMove : 0;
    const sameDirection = Math.sign(actualMove) === Math.sign(expectedMove);
    const relationType = best.rho >= 0 ? "positive" : "inverse";
    const state =
      relationType === "inverse"
        ? "inverse"
        : best.lag > 0 && responseRatio < 0.6
          ? "following"
          : sameDirection && responseRatio >= 0.5
            ? "moving-together"
            : "decoupling";
    const correlationStrength = clip(best.lowerBound / 0.7);
    const liquidity = clip(Math.log10(Math.max(candidate.usd24h, 1) / 1e6) / 2);
    const timing = clip((params.maxLag - Math.abs(best.lag)) / params.maxLag);
    const score = 100 * (0.7 * correlationStrength + 0.2 * liquidity + 0.1 * timing);

    rows.push({
      symbol,
      relation: relationType,
      state,
      rho: best.rho,
      rhoLowerBound: best.lowerBound,
      lag: best.lag,
      sampleSize: best.count,
      beta,
      marketBeta,
      anchorRecentMove,
      expectedMove,
      actualMove,
      responseRatio,
      score: Math.round(score),
      coverage,
    });
  }

  rows.sort((left, right) => right.score - left.score);
  const positive = rows.filter((row) => row.relation === "positive");
  const inverse = rows.filter((row) => row.relation === "inverse");
  return {
    ok: true,
    anchor: {
      symbol: anchorSymbol,
      marketBeta: anchorMarketBeta,
      recentMove: anchorRecentMove,
    },
    rows,
    summary: {
      related: rows.length,
      positive: positive.length,
      inverse: inverse.length,
      followers: rows.filter((row) => row.lag > 0).length,
      leaders: rows.filter((row) => row.lag < 0).length,
      averageRhoLowerBound: rows.length
        ? rows.reduce((sum, row) => sum + row.rhoLowerBound, 0) / rows.length
        : 0,
    },
  };
}
