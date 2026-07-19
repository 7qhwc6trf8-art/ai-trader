'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-journal-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.LOGS_DIR = path.join(temp, 'logs');
process.env.EXECUTION_MODE = 'analysis';
const journal = require('../src/trade_journal');

journal.signal({ signalId: 'signal-open', coin: 'BTC/USDT', action: 'BUY', confidence: 82 });
journal.opened({ signalId: 'signal-open', tradeId: 'trade-1', coin: 'BTC', entryPrice: 100, stopLoss: 98, takeProfit: 104, riskAmount: 2 });
journal.signal({ signalId: 'signal-blocked-later', coin: 'BTCUSDT', action: 'SELL', confidence: 99 });
journal.blocked({ signalId: 'signal-blocked-later', coin: 'BTC', reasons: ['duplicate position'] });

const open = journal.findOpenByCoin('BTC/USDT:USDT');
assert.strictEqual(open.tradeId, 'trade-1');
assert.strictEqual(open.signalId, 'signal-open');
assert.strictEqual(open.signal.action, 'BUY');


journal.submitted({ signalId: 'signal-pending', tradeId: 'pending-1', coin: 'ETH', action: 'BUY', stopLoss: 90, takeProfit: 110 });
assert.strictEqual(journal.findPendingByCoin('ETH/USDT').tradeId, 'pending-1');
journal.opened({ signalId: 'signal-pending', tradeId: 'pending-1', coin: 'ETH', entryPrice: 100, stopLoss: 90, takeProfit: 110 });
assert.strictEqual(journal.findPendingByCoin('ETH'), null);

journal.closed({ eventId: 'close-trade-1', tradeId: 'trade-1', coin: 'BTC' });
assert.strictEqual(journal.findOpenByCoin('BTC'), null);
console.log('blocked signals cannot overwrite the signal attached to an open trade');
