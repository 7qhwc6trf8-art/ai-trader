'use strict';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class MarketScanner {
  constructor() {
    const configured = Number(process.env.MAX_AI_ANALYSES_PER_SWEEP);
    this.maxAIAnalyses = Number.isInteger(configured) ? clamp(configured, 1, 50) : 12;
  }

  score(data, patterns = [], technical = {}) {
    const price = Math.max(1e-12, finite(data?.price));
    const rsi = finite(data?.rsi ?? technical?.rsi, 50);
    const volumeSpike = Math.max(0, finite(data?.volumeSpike, 1));
    const macdHistogram = finite(data?.macdHistogram ?? technical?.macdHistogram);
    const atr = Math.max(0, finite(data?.atr ?? technical?.atr));
    const change24h = Math.abs(finite(data?.change24h));
    const patternStrength = patterns.reduce((sum, pattern) => sum + finite(pattern?.strength ?? pattern?.confidence), 0);
    const patternScore = patterns.length ? patternStrength / patterns.length : 0;
    const rsiDislocation = Math.abs(rsi - 50) / 50;
    const normalizedMacd = Math.min(1, Math.abs(macdHistogram) / price * 500);
    const normalizedAtr = Math.min(1, atr / price * 25);
    const volumeScore = Math.min(1.5, Math.max(0, volumeSpike - 0.8));
    const trendBonus = String(technical?.marketTrend || '').toUpperCase() === 'NEUTRAL' ? 0 : 0.35;
    const volatilityBonus = String(technical?.volatilityLevel || '').toUpperCase() === 'HIGH' ? 0.3 : 0.1;

    const score = (
      patternScore * 0.035 +
      rsiDislocation * 22 +
      normalizedMacd * 18 +
      normalizedAtr * 12 +
      volumeScore * 12 +
      Math.min(12, change24h * 0.8) +
      trendBonus * 10 +
      volatilityBonus * 5
    );

    return Math.round(clamp(score, 0, 100) * 100) / 100;
  }

  rank(candidates, limit = this.maxAIAnalyses) {
    const sorted = [...candidates].sort((a, b) => b.scanScore - a.scanScore);
    const selected = [];
    const perCoin = new Map();

    // First pass limits duplicate timeframes for one coin so the expensive AI
    // budget covers more of the market universe.
    for (const candidate of sorted) {
      const count = perCoin.get(candidate.coin) || 0;
      if (count >= 2) continue;
      selected.push(candidate);
      perCoin.set(candidate.coin, count + 1);
      if (selected.length >= limit) return selected;
    }

    for (const candidate of sorted) {
      if (selected.includes(candidate)) continue;
      selected.push(candidate);
      if (selected.length >= limit) break;
    }

    return selected;
  }
}

module.exports = new MarketScanner();

