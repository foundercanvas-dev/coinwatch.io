const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function ema(values, length) {
  if (!values.length) return 0;
  const alpha = 2 / (length + 1);
  return values.reduce(
    (average, value, index) => (index === 0 ? value : value * alpha + average * (1 - alpha)),
    values[0],
  );
}

function emaPeriods(barCount) {
  if (barCount >= 400) return [20, 50, 200];
  if (barCount >= 200) return [12, 26, 100];
  if (barCount >= 100) return [9, 21, 50];
  if (barCount >= 50) return [8, 21, 34];
  return [5, 13, 21];
}

function timeframeAtr(bars, length = 14) {
  const start = Math.max(1, bars.length - length);
  const ranges = [];
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
  return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : 0;
}

export function adaptiveEmaTrend(bars) {
  const validBars = bars.filter(
    (bar) =>
      Number(bar.close) > 0 &&
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)),
  );
  // The final bar is still forming; confirmed bars keep the trend from flickering intrabar.
  const confirmedBars = validBars.length > 1 ? validBars.slice(0, -1) : validBars;
  const barsAvailable = validBars.length;
  const barsUsed = confirmedBars.length;
  if (barsUsed < 30) {
    return {
      label: "Collecting",
      direction: "flat",
      strength: 0,
      barsUsed,
      barsAvailable,
      emaLabel: "Waiting for 30 closed bars",
    };
  }

  const periods = emaPeriods(barsUsed);
  const closes = confirmedBars.map((bar) => Number(bar.close));
  const [fastPeriod, mediumPeriod, slowPeriod] = periods;
  const fast = ema(closes, fastPeriod);
  const medium = ema(closes, mediumPeriod);
  const slow = ema(closes, slowPeriod);
  const lookback = clamp(Math.round(mediumPeriod / 5), 3, 10);
  const previousCloses = closes.slice(0, -lookback);
  const previousFast = ema(previousCloses, fastPeriod);
  const previousMedium = ema(previousCloses, mediumPeriod);
  const previousSlow = ema(previousCloses, slowPeriod);
  const price = closes.at(-1);
  const atr = Math.max(timeframeAtr(confirmedBars), price * 0.0001);
  const normalize = (distance, sensitivity = 1) => Math.tanh((distance / atr) * sensitivity);

  const score =
    0.25 * normalize(fast - medium, 1.8) +
    0.2 * normalize(medium - slow, 1.25) +
    0.2 * normalize(fast - previousFast, 1.5) +
    0.15 * normalize(medium - previousMedium, 1.5) +
    0.1 * normalize(slow - previousSlow, 1.25) +
    0.1 * normalize(price - fast, 1.25);
  const direction = Math.abs(score) < 0.16 ? "flat" : score > 0 ? "up" : "down";
  const strength = clamp((Math.abs(score) / 0.82) * 100, 0, 100);

  return {
    label: direction === "up" ? "Bullish" : direction === "down" ? "Bearish" : "Sideways",
    direction,
    strength,
    barsUsed,
    barsAvailable,
    emaLabel: `EMA ${periods.join(" / ")}`,
  };
}
