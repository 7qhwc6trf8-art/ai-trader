'use strict';
const assert = require('assert');
process.env.EXECUTION_MODE = 'analysis';
process.env.MAX_AI_ANALYSES_PER_SWEEP = '3';
process.env.MAX_AI_TIMEFRAMES_PER_COIN = '1';
process.env.MIN_PRESCAN_SCORE = '40';
const scanner = require('../src/market_scanner');
const ranked = scanner.rank([
  { coin: 'BTC', tf: '15m', scanScore: 90 },
  { coin: 'BTC', tf: '1h', scanScore: 85 },
  { coin: 'ETH', tf: '1h', scanScore: 80 },
  { coin: 'SOL', tf: '1h', scanScore: 39 },
  { coin: 'XRP', tf: '4h', scanScore: 70 }
]);
assert.deepStrictEqual(ranked.map(item => item.coin), ['BTC', 'ETH', 'XRP']);
assert.ok(ranked.every(item => item.scanScore >= 40));
console.log('pre-scan floor and one-finalist-per-coin AI budget verified');
