const { RSI, EMA, MACD, BollingerBands, Stochastic } = require("technicalindicators");
const { calculateFibonacci, calculatePivotPoints, calculateVWAP } = require('./technical_tools');

function calculate(candles) {
  const closes = candles.map(x => x[4]);
  const highs = candles.map(x => x[2]);
  const lows = candles.map(x => x[3]);
  const volumes = candles.map(x => x[5]);

  const rsi = RSI.calculate({ period: 14, values: closes });
  const ema = EMA.calculate({ period: 50, values: closes });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });

  const lastIndex = closes.length - 1;
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / Math.max(1, volumes.length);
  const volumeSpike = avgVolume > 0 ? volumes[lastIndex] / avgVolume : 1;

  const sortedLows = [...lows].sort((a, b) => a - b);
  const sortedHighs = [...highs].sort((a, b) => b - a);
  const pivotPoints = calculatePivotPoints(highs[lastIndex], lows[lastIndex], closes[lastIndex]);
  const fibonacci = calculateFibonacci(highs, lows, closes, 120);
  const vwap = calculateVWAP(highs, lows, closes, volumes, 120);

  return {
    rsi: rsi.at(-1) || 50,
    ema: ema.at(-1) || closes[lastIndex],
    macd: macd.at(-1) || { histogram: 0 },
    bb: bb.at(-1) || { upper: 0, middle: 0, lower: 0 },
    stoch: stoch.at(-1) || { k: 0, d: 0 },
    close: closes[lastIndex],
    high: highs[lastIndex],
    low: lows[lastIndex],
    volumeSpike: volumeSpike || 1,
    support: sortedLows[Math.floor(sortedLows.length * 0.3)],
    resistance: sortedHighs[Math.floor(sortedHighs.length * 0.3)],
    pivotPoints,
    fibonacci,
    vwap
  };
}

module.exports = calculate;

