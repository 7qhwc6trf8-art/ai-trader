'use strict';

const assert = require('assert');
const { deduplicateOrders } = require('../src/order_utils');

const result = deduplicateOrders([
  { id: 'a', symbol: 'ETH/USDT:USDT', status: 'open', filled: 0, timestamp: 1 },
  { id: 'a', symbol: 'ETH/USDT:USDT', status: 'closed', filled: 1, timestamp: 2 },
  { id: 'b', symbol: 'BTC/USDT:USDT', status: 'open', filled: 0, timestamp: 3 },
  { id: 'b', symbol: 'BTC/USDT:USDT', status: 'open', filled: 0.5, timestamp: 4 }
]);

assert.strictEqual(result.length, 2);
assert.strictEqual(result.find(order => order.id === 'a').status, 'closed');
assert.strictEqual(result.find(order => order.id === 'b').filled, 0.5);
console.log('OK: duplicate Bybit order IDs collapse to the newest/terminal representation.');
