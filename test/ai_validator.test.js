'use strict';
const assert = require('assert');
process.env.EXECUTION_MODE = 'analysis';
const validator = require('../src/ai_validator');
const valid = validator.validate({
  action: 'BUY', sentiment: 'BULLISH', confidence: 82,
  entryPrice: 100, stopLoss: 98, takeProfit: 104,
  marketCondition: 'TRENDING', reasoning: 'test',
  approveLeverage: true, recommendedLeverage: 3, approvedLeverage: 3,
  leverageApproval: 'APPROVED', leverageReason: 'safe tier'
});
assert.strictEqual(valid.valid, true);
assert.strictEqual(valid.sanitized.riskReward, 2);
const inventedProtection = validator.validate({
  action: 'SELL', sentiment: 'BEARISH', confidence: 90,
  entryPrice: 100, stopLoss: 0, takeProfit: 0,
  reasoning: 'missing protection', approveLeverage: true,
  recommendedLeverage: 5, approvedLeverage: 5,
  leverageApproval: 'APPROVED', leverageReason: 'requested'
});
assert.strictEqual(inventedProtection.valid, false);
assert.strictEqual(inventedProtection.sanitized.action, 'HOLD');
assert.strictEqual(inventedProtection.sanitized.stopLoss, 0);
const excessive = validator.validate({
  action: 'BUY', confidence: 99, entryPrice: 100, stopLoss: 98, takeProfit: 104,
  reasoning: 'bad leverage', approveLeverage: true,
  recommendedLeverage: 100, approvedLeverage: 100,
  leverageApproval: 'APPROVED', leverageReason: 'unsafe'
});
assert.strictEqual(excessive.valid, false);
assert.strictEqual(excessive.sanitized.action, 'HOLD');
console.log('AI fail-closed validation verified');
