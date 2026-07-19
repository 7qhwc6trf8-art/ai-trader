'use strict';

const { getMarketData } = require('./analyzer');
const ultimateAI = require('./ultimate_ai_trader');
const logger = require('./logger');

/**
 * Pure analysis entry point. It never submits an order.
 * Provider selection is controlled by AI_PROVIDER=ensemble|claude|deepseek.
 */
async function analyzeUltra(coin, options = {}) {
  const symbol = String(coin || '').toUpperCase().replace('/USDT', '').replace(':USDT', '').trim();
  if (!symbol) throw new Error('A coin symbol is required');

  const timeframe = options.timeframe || '1h';
  const limit = Math.max(80, Math.min(1000, Number(options.limit) || 250));
  const data = options.data || await getMarketData(symbol, timeframe, limit);

  logger.step('ULTRA_AI_ANALYSIS_ONLY_START', { coin: symbol, timeframe, limit });
  const result = await ultimateAI.analyzeOnly(symbol, data, options.patterns || null);
  logger.step('ULTRA_AI_ANALYSIS_ONLY_COMPLETE', {
    coin: symbol,
    action: result.action,
    confidence: result.confidence,
    leverage: result.leverage || 0,
    dataQuality: result.reasoningEvidence?.dataQuality
  });

  return {
    coin: symbol,
    timeframe,
    ...result,
    timestamp: new Date().toISOString()
  };
}

// Backward-compatible name. It now uses the configured production AI pipeline,
// rather than bypassing Claude/DeepSeek ensemble validation.
async function analyzeWithDeepSeek(coin, options = {}) {
  return analyzeUltra(coin, options);
}

module.exports = {
  analyzeUltra,
  analyzeWithDeepSeek,
  analyze: analyzeUltra
};
