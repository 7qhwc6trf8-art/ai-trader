'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const originalLoad = Module._load;

const noopLogger = new Proxy({}, { get: () => () => {} });
const mockBybit = {
  getMode: () => 'ro',
  getBalance: async () => ({ totalUSD: 100, tradableUSD: 100, walletUSDT: 100, fundingUSDT: 0, assets: [] }),
  getPortfolio: async () => ({ positions: [], totalValue: 100, availableToTrade: 100 }),
  getMarketRules: async () => ({ maxLeverage: 10, minimumOrderAmount: 0.001, amountStep: 0.001 }),
  getClosedPnl: async () => []
};

const candles = [];
let price = 100;
for (let i = 0; i < 220; i += 1) {
  const open = price;
  const close = open * 1.001;
  candles.push([Date.now() - (220 - i) * 3600000, open, close * 1.002, open * 0.998, close, 1000 + i]);
  price = close;
}
const marketData = {
  coin: 'BTC', timeframe: '1h', price, change24h: 2.4, volumeSpike: 1.5,
  candles,
  opens: candles.map(c => c[1]), highs: candles.map(c => c[2]), lows: candles.map(c => c[3]), closes: candles.map(c => c[4]), volumes: candles.map(c => c[5]),
  rsi: 61, ema: price * 0.97, ema200: price * 0.90,
  macd: 1, macdSignal: 0.8, macdHistogram: 0.2,
  bb: { upper: price * 1.02, middle: price * 0.99, lower: price * 0.96 },
  stoch: { k: 65, d: 58 }, atr: price * 0.006,
  support: price * 0.97, resistance: price * 1.03, vwap: price * 0.985,
  pivotPoints: { pivotPoint: price, r1: price * 1.01, s1: price * 0.99, r2: price * 1.02, s2: price * 0.98 },
  fibonacci: { keyLevels: { fib236: price * 0.995, fib382: price * 0.99, fib500: price * 0.985, fib618: price * 0.98, fib786: price * 0.97 } }
};

function emaCalc({ values }) { return [values.at(-1) || 0]; }
function rsiCalc() { return [61]; }
function atrCalc({ close }) { return [(close.at(-1) || 100) * 0.006]; }

Module._load = function(request, parent, isMain) {
  if (request === 'dotenv') return { config: () => ({}) };
  if (request === '@anthropic-ai/sdk') return class Anthropic { constructor() { this.messages = { create: async () => ({ content: [] }) }; } };
  if (request === 'technicalindicators') return {
    RSI: { calculate: rsiCalc }, EMA: { calculate: emaCalc },
    MACD: { calculate: () => [{ MACD: 1, signal: 0.8, histogram: 0.2 }] },
    BollingerBands: { calculate: () => [] }, Stochastic: { calculate: () => [] }, ATR: { calculate: atrCalc }
  };
  if (request === './analyzer' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return { getMarketData: async () => marketData };
  if (request === './bybit_client' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return mockBybit;
  if (request === './logger' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return noopLogger;
  if (request === './order_manager' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return { openPosition: async () => ({ success: false }) };
  if (request === './risk_manager' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return {};
  if (request === './websocket_manager' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return {};
  if (request === './forecast_engine' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return {
    createForecast: () => ({ available: true, direction: 'BULLISH', confidence: 70, horizonLabel: '24h', expectedReturnPct: 2, lowerPrice: price * 0.99, expectedPrice: price * 1.02, upperPrice: price * 1.04, upProbabilityPct: 65, downProbabilityPct: 35 }),
    publicForecast: f => f,
    evaluateTrade: (data, forecast, decision, options) => ({ available: true, tpReachProbabilityPct: 60, positionSize: options?.positionSize || 0, projectedNetProfit: 1, projectedLossAtStop: 0.5 })
  };
  if (request === './coin_universe' && parent?.filename?.endsWith('ultimate_ai_trader.js')) return { getAutoTradeCoins: () => ['BTC'] };
  return originalLoad(request, parent, isMain);
};

(async () => {
  process.env.AI_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  const trader = require('./src/ultimate_ai_trader');
  trader.currentBalance = 100;
  trader.updateBalance = () => { trader.currentBalance = 100; };
  trader.multiTimeframeAnalysis = async () => ({ '1m': 'BULLISH', '5m': 'BULLISH', '15m': 'BULLISH', '1h': 'BULLISH', '4h': 'BULLISH' });
  trader.requestDeepSeekAnalysis = async () => ({
    action: 'BUY', sentiment: 'BULLISH', confidence: 90,
    entryPrice: price, stopLoss: price * 0.99, takeProfit: price * 1.02,
    positionSizePercent: 5, riskReward: 2,
    marketCondition: 'TRENDING', signals: ['trend'], warnings: [],
    evidenceFor: ['EMA alignment'], evidenceAgainst: ['near resistance'],
    invalidation: 'close below support', scenario: 'continuation',
    approveLeverage: true, recommendedLeverage: 10, approvedLeverage: 10,
    leverageApproval: 'APPROVED', leverageReason: 'strong alignment',
    tpEtaMinutes: 240, forecastBias: 'BULLISH', reasoning: 'Aligned trend.'
  });

  const result = await trader.analyzeOnly('BTC', marketData, [{ name: 'Bull Flag', type: 'BULLISH', strength: 80 }]);
  assert(['BUY', 'HOLD'].includes(result.action));
  assert(result.reasoningEvidence);
  assert(result.calibration);
  assert(trader.getAIStatus().engineVersion === '14.0.0');
  assert(trader.getAISystemPrompt('risk').includes('skeptical risk auditor'));
  console.log(JSON.stringify({
    ok: true,
    action: result.action,
    confidence: result.confidence,
    leverage: result.leverage || 0,
    engineVersion: trader.getAIStatus().engineVersion,
    evidenceDirection: result.reasoningEvidence.score.dominantDirection
  }, null, 2));
})().finally(() => { Module._load = originalLoad; });
