'use strict';

const assert = require('assert');
const Module = require('module');

process.env.STATISTICS_TIMEZONE = 'UTC';
process.env.STATISTICS_BACKFILL_DAYS = '30';
process.env.STATISTICS_RESYNC_DAYS = '7';
process.env.STATISTICS_SYNC_SECONDS = '15';

const statsRows = new Map();
const meta = new Map();
const db = {
  saveTrade() {},
  findOpenSignalContext() { return null; },
  closeSignalContext() {},
  upsertDailyStat(row) { statsRows.set(row.date, { ...row }); },
  getRecentDailyStats(limit) { return [...statsRows.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit); },
  getDailyStats(startDate, endDate) { return [...statsRows.values()].filter(row => row.date >= startDate && row.date <= endDate).sort((a, b) => a.date.localeCompare(b.date)); },
  getStatsCoverage() {
    const keys = [...statsRows.keys()].sort();
    return { firstDate: keys[0] || null, lastDate: keys.at(-1) || null, days: keys.length };
  },
  setStatisticsMeta(key, value) { meta.set(String(key), { value: String(value), updatedAt: new Date().toISOString() }); },
  getStatisticsMeta(key) { return meta.get(String(key)) || null; },
  deleteDailyStatsBefore(date) { for (const key of [...statsRows.keys()]) if (key < date) statsRows.delete(key); },
  saveBalance() {}
};

const now = Date.now();
const sixDaysAgo = now - 6 * 86400000;
const records = [
  {
    symbol: 'BTCUSDT', orderId: 'old-win', side: 'Buy', leverage: 2,
    qty: 1, entryPrice: 100, exitPrice: 110, closedPnl: 10,
    openFee: 0, closeFee: 0, createdTime: sixDaysAgo - 3600000, updatedTime: sixDaysAgo
  },
  {
    symbol: 'ETHUSDT', orderId: 'today-loss', side: 'Sell', leverage: 2,
    qty: 1, entryPrice: 100, exitPrice: 105, closedPnl: -5,
    openFee: 0, closeFee: 0, createdTime: now - 3600000, updatedTime: now
  }
];

const bybit = {
  zonedMidnightToUtcMs(year, month, day) { return Date.UTC(year, month - 1, day); },
  async getBalance() { return { unavailable: false, totalUSD: 205 }; },
  async getPositions() { return []; },
  async getClosedPnl({ startTime, endTime }) {
    const selected = records.filter(record => record.updatedTime >= startTime && record.updatedTime <= endTime);
    return { available: true, records: selected };
  }
};

const logger = { action() {}, error() {} };
const signalCalibrator = { record() {} };
const symbolUtils = { normalizeCoin(symbol) { return String(symbol).replace(/USDT.*/, ''); } };

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename?.endsWith('account_statistics.js')) {
    if (request === './database') return db;
    if (request === './bybit_client') return bybit;
    if (request === './logger') return logger;
    if (request === './signal_calibrator') return signalCalibrator;
    if (request === './symbol_utils') return symbolUtils;
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const accountStatistics = require('../src/account_statistics');
    await accountStatistics.sync({ force: true, fullBackfill: true });

    const daily = accountStatistics.get('daily', 10);
    assert.strictEqual(daily.rows.length, 7, 'Expected seven tracked calendar days');
    assert.strictEqual(daily.rows[0].realizedPnl, -5, 'Current day loss was not recorded');
    assert(Math.abs(daily.rows.at(-1).returnPct - 5) < 1e-9, 'Old winning day should be +5%');

    const week = accountStatistics.get('week', 10);
    assert.strictEqual(week.availability.available, true, 'Weekly statistics should unlock after seven days');
    assert.strictEqual(week.current.realizedPnl, 5, 'Weekly realized PnL should be +$5');
    assert(Math.abs(week.current.returnPct - 2.5) < 1e-9, 'Weekly return should be +2.5%');

    const month = accountStatistics.get('month', 10);
    assert.strictEqual(month.availability.available, false, 'Monthly statistics should still be locked');
    assert.strictEqual(month.availability.remainingDays, 23, 'Monthly countdown should show 23 remaining days');

    const year = accountStatistics.get('year', 10);
    assert.strictEqual(year.availability.available, false, 'Yearly statistics should still be locked');
    assert.strictEqual(year.availability.remainingDays, 358, 'Year countdown should show 358 remaining days');

    console.log('OK: account statistics runtime sync, +/- history and unlock behavior passed.');
  } finally {
    Module._load = originalLoad;
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
