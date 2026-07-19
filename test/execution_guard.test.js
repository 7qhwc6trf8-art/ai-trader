'use strict';
const assert = require('assert');
process.env.EXECUTION_MODE = 'analysis';
process.env.AI_PROVIDER = 'ensemble';
const guard = require('../src/execution_guard');
const now = Date.now();
const base = {
  coin: 'BTC/USDT:USDT', action: 'BUY', entryPrice: 100,
  stopLoss: 98, takeProfit: 104.5, executionScore: 85,
  positionSize: 10, timestamp: now,
  ensemble: { claude: { action: 'BUY' }, deepseek: { action: 'BUY' } }
};
const allowed = guard.validate({
  signal: base, portfolio: { positions: [] }, equity: 10000,
  plannedNotional: 1000, plannedMargin: 333, leverage: 3,
  ticker: { last: 100.02, bid: 99.99, ask: 100.01 }, now
});
assert.strictEqual(allowed.passed, true, allowed.reasons.join(' | '));
const duplicate = guard.validate({
  signal: base,
  portfolio: { positions: [{ symbol: 'BTCUSDT', notional: 500, size: 5, markPrice: 100 }] },
  equity: 10000, plannedNotional: 1000, plannedMargin: 333, leverage: 3,
  ticker: { last: 100, bid: 99.99, ask: 100.01 }, now
});
assert.strictEqual(duplicate.passed, false);
assert.ok(duplicate.reasons.some(reason => reason.includes('already exists')));
const stale = guard.validate({
  signal: { ...base, timestamp: now - 999999 }, portfolio: { positions: [] }, equity: 10000,
  plannedNotional: 1000, plannedMargin: 333, leverage: 3,
  ticker: { last: 100, bid: 99.99, ask: 100.01 }, now
});
assert.strictEqual(stale.passed, false);
assert.ok(stale.reasons.some(reason => reason.includes('stale')));
console.log('execution preflight, exposure, duplicate and stale gates verified');
