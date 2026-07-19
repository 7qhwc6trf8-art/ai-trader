'use strict';
const assert = require('assert');
const mutex = require('../src/core/keyed_mutex');
(async () => {
  const events = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await Promise.all([
    mutex.run('BTC', async () => { events.push('a-start'); await sleep(30); events.push('a-end'); }),
    mutex.run('BTC', async () => { events.push('b-start'); events.push('b-end'); }),
    mutex.run('ETH', async () => { events.push('eth'); })
  ]);
  assert.ok(events.indexOf('b-start') > events.indexOf('a-end'));
  assert.strictEqual(mutex.isLocked('BTC'), false);
  console.log('per-symbol execution serialization verified');
})().catch(error => { console.error(error); process.exit(1); });
