'use strict';
const assert = require('assert');
process.env.EXECUTION_MODE = 'analysis';
const BacktestEngine = require('../src/backtest');
const t = 1700000000000;
const m = 60000;
const bars = [
  [t+0*m,100,101,99,100,1000],
  [t+1*m,100,101,99,100,1000],
  [t+2*m,100,101,99,100,1000],
  [t+3*m,101,102,100,101,1000],
  [t+4*m,101,105,100,104,1000],
  [t+5*m,103,104,101,102,1000],
  [t+6*m,102,103,97,98,1000],
  [t+7*m,98,99,97,98,1000]
];
const engine = new BacktestEngine({ minimumWarmup: 2, feeRate: 0, slippageRate: 0, fundingRatePer8h: 0, leverage: 2, riskFraction: 0.005 });
(async () => {
  const result = await engine.run((_history, context) => {
    if (context.index === 2) return { action: 'BUY', stopLoss: 98, takeProfit: 104, leverage: 2 };
    if (context.index === 4 && context.trades.length === 1) return { action: 'SELL', stopLoss: 106, takeProfit: 98, leverage: 2 };
    return { action: 'HOLD' };
  }, bars);
  assert.strictEqual(result.totalTrades, 2);
  assert.strictEqual(result.longTrades, 1);
  assert.strictEqual(result.shortTrades, 1);
  assert.strictEqual(result.trades[0].entryPrice, 101, 'signal must enter at next bar open');
  assert.strictEqual(result.trades[0].exitReason, 'TAKE_PROFIT');
  assert.strictEqual(result.trades[1].entryPrice, 103);
  assert.strictEqual(result.trades[1].exitReason, 'TAKE_PROFIT');
  const ambiguous = engine.resolveBarExit({ side: 'BUY', stop: 98, target: 104, liquidationPrice: 50 }, { open: 100, high: 105, low: 97 });
  assert.strictEqual(ambiguous.reason, 'STOP_LOSS_AMBIGUOUS');
  console.log('LONG/SHORT, next-bar entry and worst-case intrabar backtest verified');
})().catch(error => { console.error(error); process.exit(1); });
