'use strict';
const assert = require('assert');
const { getAuthorizedIds, isAuthorized, createAuthorizationMiddleware } = require('../src/telegram_auth');

const ids = getAuthorizedIds({ AUTHORIZED_TELEGRAM_USER_IDS: '123,456', CHAT_ID: '-100999' });
assert.deepStrictEqual([...ids], ['123', '456']);
assert.strictEqual(isAuthorized({ from: { id: 123 } }, ids), true);
assert.strictEqual(isAuthorized({ from: { id: 999 } }, ids), false);
let nextCalled = false;
let replied = '';
(async () => {
  await createAuthorizationMiddleware({ ids })({ from: { id: 999 }, reply: async text => { replied = text; } }, async () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.match(replied, /Unauthorized/);
  await createAuthorizationMiddleware({ ids })({ from: { id: 456 } }, async () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  console.log('Telegram user allowlist blocks unauthorized bot control');
})().catch(error => { console.error(error); process.exit(1); });
