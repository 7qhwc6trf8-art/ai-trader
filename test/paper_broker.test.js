'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-paper-'));
process.env.EXECUTION_MODE = 'paper';
process.env.DATA_DIR = dir;
process.env.PAPER_STATE_FILE = path.join(dir, 'paper.json');
process.env.PAPER_INITIAL_BALANCE = '10000';
const market = require('../src/market');
let phase = 0;
market.getTicker = async () => ({ last: 100, mark: 100, bid: 99.99, ask: 100.01 });
market.getMarketRules = async () => ({ minimumOrderAmount: 0.001, amountStep: 0.001, maxLeverage: 10, marketType: 'swap' });
market.getCandles = async () => phase === 0
  ? [[60000,100,101,99,100,1000],[120000,100,101,99,100,1000]]
  : [[60000,100,101,99,100,1000],[120000,100,101,99,100,1000],[180000,100,105,99,104,1000]];
const broker = require('../src/paper_broker');
(async () => {
  const opened = await broker.openPosition('BTC', 'BUY', 1, 98, 104, 2, { expectedEntryPrice: 100, clientOrderId: 'paper-test', signalId: 'sig-1' });
  assert.strictEqual(opened.success, true, opened.error);
  assert.strictEqual((await broker.getPortfolio()).positions.length, 1);
  phase = 1;
  const closed = await broker.syncPositions();
  assert.strictEqual(closed.length, 1);
  assert.ok(closed[0].closedPnl > 0);
  assert.strictEqual((await broker.getPortfolio()).positions.length, 0);
  assert.strictEqual((await broker.getOrders(null, 20)).filter(o => o.status === 'closed').length, 1);
  const daily = await broker.getDailyClosedPnl('UTC', 180000);
  assert.strictEqual(daily.recordCount, 1);
  console.log('persistent paper open, protected close and PnL reconciliation verified');
})().catch(error => { console.error(error); process.exit(1); });
