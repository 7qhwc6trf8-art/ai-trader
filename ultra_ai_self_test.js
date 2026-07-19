'use strict';

const assert = require('assert');
const engine = require('./src/ultra_ai_reasoning');
const validator = require('./src/ai_validator');

function makeBullishData() {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 160; i += 1) {
    const open = price;
    const close = open * 1.0015;
    const high = close * 1.002;
    const low = open * 0.998;
    candles.push([Date.now() - ((160 - i) * 3600000), open, high, low, close, 1000 + i * 4]);
    price = close;
  }
  return {
    coin: 'BTC',
    timeframe: '1h',
    price,
    change24h: 3.2,
    volumeSpike: 1.7,
    candles,
    opens: candles.map(c => c[1]),
    highs: candles.map(c => c[2]),
    lows: candles.map(c => c[3]),
    closes: candles.map(c => c[4]),
    volumes: candles.map(c => c[5])
  };
}

const data = makeBullishData();
const price = data.price;
const tech = {
  ema9: price * 0.995,
  ema21: price * 0.990,
  ema50: price * 0.975,
  ema200: price * 0.90,
  rsi: 61,
  rsi21: 58,
  macd: 1.2,
  macdSignal: 0.9,
  macdHistogram: 0.3,
  stochK: 68,
  stochD: 60,
  bbUpper: price * 1.02,
  bbMiddle: price * 0.99,
  bbLower: price * 0.96,
  atr: price * 0.006,
  support: price * 0.97,
  resistance: price * 1.03,
  vwap: price * 0.985,
  volatilityLevel: 'LOW',
  liquidity: 'HIGH',
  marketTrend: 'BULLISH'
};
const multiTF = { '1m': 'BULLISH', '5m': 'BULLISH', '15m': 'BULLISH', '1h': 'BULLISH', '4h': 'BULLISH' };
const evidence = engine.buildEvidence({
  coin: 'BTC',
  data,
  techAnalysis: tech,
  multiTF,
  patterns: [{ name: 'Bull Flag', type: 'BULLISH', strength: 80 }],
  forecast: { available: true, direction: 'BULLISH', confidence: 70 },
  portfolio: { positions: [] },
  account: { availableBalance: 100, dailyNetPnl: 0, dailyTargetRemaining: 10 }
});

assert(evidence.dataQuality >= 80, 'data quality should be high');
assert.strictEqual(evidence.score.dominantDirection, 'BULLISH');

const buy = engine.calibrateDecision({
  action: 'BUY',
  sentiment: 'BULLISH',
  confidence: 91,
  entryPrice: price,
  stopLoss: price * 0.99,
  takeProfit: price * 1.02,
  approveLeverage: true,
  leverageApproval: 'APPROVED',
  recommendedLeverage: 10,
  reasoning: 'Trend and momentum align.'
}, evidence, data);

assert.strictEqual(buy.action, 'BUY');
assert(buy.confidence <= evidence.score.confidenceCeiling);
assert([4, 5, 10].includes(buy.recommendedLeverage));
assert(buy.stopLoss < buy.entryPrice && buy.takeProfit > buy.entryPrice);
assert(buy.riskReward >= 1.2);

const contradictedSell = engine.calibrateDecision({
  action: 'SELL',
  sentiment: 'BEARISH',
  confidence: 88,
  entryPrice: price,
  stopLoss: price * 1.01,
  takeProfit: price * 0.98,
  approveLeverage: true,
  leverageApproval: 'APPROVED',
  recommendedLeverage: 10,
  reasoning: 'Countertrend short.'
}, evidence, data);
assert.strictEqual(contradictedSell.action, 'HOLD');
assert.strictEqual(contradictedSell.recommendedLeverage, 0);

const permissive = validator.validate({
  action: 'BUY',
  sentiment: 'BULLISH',
  confidence: 70,
  entryPrice: price,
  stopLoss: 0,
  takeProfit: 0,
  leverageApproval: 'REJECTED'
});
assert(permissive.valid, 'provider parser should permit repairable price fields');

const strict = validator.validateTradeParams({
  coin: 'BTC',
  action: 'BUY',
  entryPrice: price,
  stopLoss: price * 1.01,
  takeProfit: price * 1.02,
  size: 0.01,
  leverage: 4
});
assert.strictEqual(strict.valid, false);

console.log(JSON.stringify({
  ok: true,
  engineVersion: engine.version,
  dataQuality: evidence.dataQuality,
  dominantDirection: evidence.score.dominantDirection,
  evidenceGap: evidence.score.absoluteEdge,
  confidenceCeiling: evidence.score.confidenceCeiling,
  calibratedBuyConfidence: buy.confidence,
  calibratedBuyLeverage: buy.recommendedLeverage,
  contradictionResult: contradictedSell.action
}, null, 2));
