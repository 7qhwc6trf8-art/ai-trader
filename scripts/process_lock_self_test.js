'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProcessLock } = require('../src/process_lock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-trader-lock-'));
const lockPath = path.join(dir, 'instance.lock');
const first = new ProcessLock(lockPath);
const second = new ProcessLock(lockPath);

first.acquire();
assert(fs.existsSync(lockPath), 'Lock file was not created');
assert.throws(() => second.acquire(), /already running/, 'Second live instance must be blocked');
first.release();
assert(!fs.existsSync(lockPath), 'Lock file was not released');

fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: new Date(0).toISOString() }));
second.acquire();
assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid, 'Stale lock was not replaced');
second.release();
fs.rmSync(dir, { recursive: true, force: true });

console.log('OK: duplicate local bot instances are blocked and stale locks recover safely.');
