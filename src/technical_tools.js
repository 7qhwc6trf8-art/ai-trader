'use strict';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  const number = finite(value);
  return Number(number.toFixed(digits));
}

function sliceTail(values, size) {
  if (!Array.isArray(values)) return [];
  return values.map(Number).filter(Number.isFinite).slice(-Math.max(2, size || values.length));
}

function calculatePivotPoints(high, low, close) {
  const h = finite(high);
  const l = finite(low);
  const c = finite(close);
  const pp = (h + l + c) / 3;
  return {
    pivotPoint: round(pp),
    r1: round((2 * pp) - l),
    s1: round((2 * pp) - h),
    r2: round(pp + (h - l)),
    s2: round(pp - (h - l)),
    r3: round(h + 2 * (pp - l)),
    s3: round(l - 2 * (h - pp))
  };
}

function calculateVWAP(highs, lows, closes, volumes, lookback = 120) {
  const hs = sliceTail(highs, lookback);
  const ls = sliceTail(lows, lookback);
  const cs = sliceTail(closes, lookback);
  const vs = sliceTail(volumes, lookback);
  const length = Math.min(hs.length, ls.length, cs.length, vs.length);
  if (length < 2) return 0;

  let pv = 0;
  let vol = 0;
  for (let i = 0; i < length; i += 1) {
    const typical = (hs[i] + ls[i] + cs[i]) / 3;
    const volume = Math.max(0, vs[i]);
    pv += typical * volume;
    vol += volume;
  }
  return vol > 0 ? round(pv / vol) : 0;
}

function calculateFibonacci(highs, lows, closes, lookback = 120) {
  const hs = sliceTail(highs, lookback);
  const ls = sliceTail(lows, lookback);
  const cs = sliceTail(closes, lookback);
  if (hs.length < 2 || ls.length < 2 || cs.length < 2) {
    return null;
  }

  const swingHigh = Math.max(...hs);
  const swingLow = Math.min(...ls);
  const currentPrice = cs[cs.length - 1];
  const range = swingHigh - swingLow;
  if (!Number.isFinite(range) || range <= 0) return null;

  const midpoint = swingLow + (range * 0.5);
  const trend = currentPrice >= midpoint ? 'UPTREND' : 'DOWNTREND';

  const buildLevel = ratio => {
    const price = trend === 'UPTREND'
      ? swingHigh - (range * ratio)
      : swingLow + (range * ratio);
    return { ratio, price: round(price) };
  };

  const retracementRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const extensionRatios = [1.272, 1.618, 2];

  return {
    trend,
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
    currentPrice: round(currentPrice),
    range: round(range),
    retracements: retracementRatios.map(buildLevel),
    extensions: extensionRatios.map(buildLevel),
    keyLevels: {
      fib236: round(buildLevel(0.236).price),
      fib382: round(buildLevel(0.382).price),
      fib500: round(buildLevel(0.5).price),
      fib618: round(buildLevel(0.618).price),
      fib786: round(buildLevel(0.786).price)
    }
  };
}

module.exports = {
  finite,
  round,
  calculatePivotPoints,
  calculateVWAP,
  calculateFibonacci
};

