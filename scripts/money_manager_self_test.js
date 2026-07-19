'use strict';

const assert = require('assert');
process.env.AI_LEVERAGE_OPTIONS = '1,2,3,5';
process.env.MAX_AI_LEVERAGE = '5';
process.env.REQUIRE_AI_LEVERAGE_APPROVAL = 'true';
const moneyManager = require('../src/money_manager');

const context = {
  action: 'BUY', entryPrice: 100, stopLoss: 98, riskReward: 2,
  multiTF: { '15m': 'BULLISH', '1h': 'BULLISH', '4h': 'BULLISH' },
  tpProbability: 80, forecastDirection: 'BULLISH', volatilityLevel: 'MEDIUM',
  liquidity: 'HIGH', marketMaxLeverage: 10, executionScore: 90
};

const rejected = moneyManager.evaluateLeverage({
  action: 'BUY', confidence: 95, recommendedLeverage: 5,
  approveLeverage: false, leverageApproval: 'REJECTED'
}, context);
assert.strictEqual(rejected.approved, false, 'Explicit AI leverage rejection must never be overridden by a numeric tier');

const approved = moneyManager.evaluateLeverage({
  action: 'BUY', confidence: 95, recommendedLeverage: 5,
  approveLeverage: true, leverageApproval: 'APPROVED', leverageReason: 'Strong setup'
}, context);
assert.strictEqual(approved.approved, true);
assert.strictEqual(approved.leverage, 5);

console.log('OK: explicit leverage rejection and approved leverage tier behavior passed.');
