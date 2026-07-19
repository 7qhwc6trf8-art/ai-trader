'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-bot-import-'));
process.env.EXECUTION_MODE = 'analysis';
process.env.TELEGRAM_TOKEN = '000000000:TEST_ONLY';
process.env.AUTHORIZED_TELEGRAM_USER_IDS = '123456';
process.env.TRADING_DB_PATH = path.join(temp, 'trading.db');
process.env.DATA_DIR = path.join(temp, 'data');
process.env.LOGS_DIR = path.join(temp, 'logs');
process.env.AUTO_START_TRADING = 'false';

const beforeSigint = process.listenerCount('SIGINT');
const beforeSigterm = process.listenerCount('SIGTERM');
const moduleValue = require('../src/bot');

assert.strictEqual(typeof moduleValue.launchBot, 'function');
assert.strictEqual(typeof moduleValue.installShutdownHandlers, 'function');
assert.strictEqual(process.listenerCount('SIGINT'), beforeSigint);
assert.strictEqual(process.listenerCount('SIGTERM'), beforeSigterm);
assert.strictEqual(moduleValue.tradingAccount.getMode(), 'paper');
moduleValue.stopMaintenanceJobs();

console.log('bot imports without Telegram, Bybit, cron or signal-handler side effects');
