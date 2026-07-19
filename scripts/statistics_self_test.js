'use strict';

const assert = require('assert');

const DAY = 86400000;
const thresholds = { daily: 1, week: 7, month: 30, year: 365 };

function availability(period, elapsedDays) {
  const availableDays = elapsedDays + 1;
  const requiredDays = thresholds[period];
  return {
    available: availableDays >= requiredDays,
    remainingDays: Math.max(0, requiredDays - availableDays)
  };
}

function aggregate(rows) {
  const openingEquity = rows[0].openingEquity;
  const realizedPnl = rows.reduce((sum, row) => sum + row.realizedPnl, 0);
  const trades = rows.reduce((sum, row) => sum + row.trades, 0);
  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const losses = rows.reduce((sum, row) => sum + row.losses, 0);
  return {
    openingEquity,
    realizedPnl,
    returnPct: openingEquity > 0 ? realizedPnl / openingEquity * 100 : 0,
    trades,
    wins,
    losses
  };
}

const period = aggregate([
  { openingEquity: 200, realizedPnl: 10, trades: 2, wins: 2, losses: 0 },
  { openingEquity: 210, realizedPnl: -5, trades: 1, wins: 0, losses: 1 }
]);
assert.strictEqual(period.realizedPnl, 5);
assert.strictEqual(period.returnPct, 2.5);
assert.strictEqual(period.trades, 3);
assert.strictEqual(period.wins, 2);
assert.strictEqual(period.losses, 1);

assert.deepStrictEqual(availability('week', 0), { available: false, remainingDays: 6 });
assert.deepStrictEqual(availability('week', 6), { available: true, remainingDays: 0 });
assert.deepStrictEqual(availability('month', 9), { available: false, remainingDays: 20 });
assert.deepStrictEqual(availability('month', 29), { available: true, remainingDays: 0 });
assert.deepStrictEqual(availability('year', 364), { available: true, remainingDays: 0 });
assert.strictEqual(new Date(Date.UTC(2026, 6, 19) + DAY).toISOString().slice(0, 10), '2026-07-20');

console.log('OK: statistics aggregation and daily/week/month/year unlock countdown passed.');
