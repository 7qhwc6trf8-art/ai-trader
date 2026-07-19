'use strict';

function envNumber(name, fallback, min = -Infinity, max = Infinity) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

module.exports = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  aiProvider: process.env.AI_PROVIDER || 'ensemble',
  ensembleJudge: process.env.ENSEMBLE_JUDGE || 'claude',
  bybitMode: process.env.BYBIT_MODE || 'ro',
  bybitMarketType: process.env.BYBIT_MARKET_TYPE || 'swap',
  minimumDataQuality: envNumber('AI_MIN_DATA_QUALITY', 55, 0, 100),
  minimumRiskReward: envNumber('AI_MIN_RISK_REWARD', 1.2, 0.25, 20),
  dailyProfitTarget: envNumber('DAILY_PROFIT_TARGET_USD', 10, 0, 1000000),
  allowMockMarketData: envBoolean('ALLOW_MOCK_MARKET_DATA', false)
});
