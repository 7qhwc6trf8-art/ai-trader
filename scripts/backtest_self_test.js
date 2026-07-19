'use strict';

const assert = require('assert');
const BacktestEngine = require('../src/backtest');

const hour = 3600000;
const candles = [];
for (let i = 0; i < 206; i++) {
  let open = 100, high = 101, low = 99, close = 100;
  if (i === 201) { high = 106; low = 99; close = 105; }
  if (i === 203) { high = 101; low = 94; close = 95; }
  candles.push([i * hour, open, high, low, close, 1000]);
}

(async () => {
  const engine = new BacktestEngine({
    initialBalance: 10000,
    feeRate: 0,
    slippageRate: 0,
    fundingRatePer8h: 0,
    riskFraction: 0.01,
    maxMarginFraction: 1,
    leverage: 1,
    warmupCandles: 200,
    intrabarPolicy: 'WORST_CASE'
  });

  const result = await engine.run(history => {
    if (history.length === 201) return { action: 'BUY', stopLoss: 95, takeProfit: 105 };
    if (history.length === 203) return { action: 'SELL', stopLoss: 105, takeProfit: 95 };
    return { action: 'HOLD' };
  }, candles);

  assert.strictEqual(result.totalTrades, 2);
  assert.strictEqual(result.longTrades, 1);
  assert.strictEqual(result.shortTrades, 1);
  assert.strictEqual(result.trades[0].entryPrice, 100, 'Signal must execute at next candle open');
  assert.strictEqual(result.trades[0].exitReason, 'TAKE_PROFIT');
  assert.strictEqual(result.trades[1].exitReason, 'TAKE_PROFIT');

  const bothHit = engine.resolveIntrabarExit(
    { side: 'BUY', stop: 95, target: 105 },
    { open: 100, high: 106, low: 94 }
  );
  assert.strictEqual(bothHit.reason, 'STOP_LOSS', 'Worst-case policy must choose stop when both levels hit');

  const gap = engine.resolveIntrabarExit(
    { side: 'BUY', stop: 95, target: 105 },
    { open: 90, high: 92, low: 88 }
  );
  assert.strictEqual(gap.price, 90, 'Gap stop must fill at candle open');

  console.log('OK: next-open execution, LONG/SHORT, gap fills and worst-case intrabar behavior passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
