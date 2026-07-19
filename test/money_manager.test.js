'use strict';
const assert = require('assert');
process.env.EXECUTION_MODE = 'analysis';
const manager = require('../src/money_manager');
const ensemble = { claude: { action: 'BUY' }, deepseek: { action: 'BUY' } };
const high = manager.evaluateLeverage({
  action: 'BUY', confidence: 90, executionScore: 90,
  approveLeverage: true, leverageApproval: 'APPROVED', recommendedLeverage: 5,
  leverageReason: 'approved', ensemble
}, {
  action: 'BUY', entryPrice: 100, stopLoss: 98,
  executionScore: 90, riskReward: 2.2,
  multiTF: { tf15m: 'BULLISH', tf1h: 'BULLISH', tf4h: 'BULLISH' }, tpProbability: 60,
  forecastDirection: 'BULLISH', volatilityLevel: 'LOW', liquidity: 'HIGH',
  marketMaxLeverage: 20
});
assert.strictEqual(high.approved, true);
assert.strictEqual(high.leverage, 5);
const unsafe = manager.evaluateLeverage({
  action: 'BUY', confidence: 99, executionScore: 99,
  approveLeverage: true, leverageApproval: 'APPROVED', recommendedLeverage: 100,
  leverageReason: 'requested', ensemble
}, {
  action: 'BUY', entryPrice: 100, stopLoss: 99.9,
  executionScore: 99, riskReward: 1.1,
  multiTF: { alignedTimeframes: 0 }, tpProbability: 5,
  forecastDirection: 'BEARISH', volatilityLevel: 'HIGH', liquidity: 'LOW',
  marketMaxLeverage: 100
});
assert.ok(unsafe.leverage <= 5);
assert.strictEqual(unsafe.approved, false);
const position = manager.calculatePosition({
  balance: 10000, entryPrice: 100, stopLoss: 98,
  leverage: 3, executionScore: 80, volatilityLevel: 'MEDIUM',
  marketRules: { minimumOrderAmount: 0.001, amountStep: 0.001 }
});
assert.strictEqual(position.executable, true);
assert.ok(position.marginUsed <= 800 + 1e-6);
assert.ok(position.riskPercent <= 0.5 + 1e-6);
const lockedPosition = manager.calculatePosition({
  balance: 10000, entryPrice: 100, stopLoss: 98,
  leverage: 2, executionScore: 80, volatilityLevel: 'MEDIUM',
  riskMultiplier: 0.5,
  marketRules: { minimumOrderAmount: 0.001, amountStep: 0.001 }
});
assert.ok(lockedPosition.riskAmount < position.riskAmount);
assert.ok(lockedPosition.riskPercent <= position.riskPercent * 0.6);
console.log('leverage downgrade and stop-based sizing verified');
