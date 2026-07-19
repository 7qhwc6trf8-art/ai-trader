'use strict';

const fs = require('fs');
const path = require('path');

class ProcessLock {
  constructor(lockPath = process.env.BOT_INSTANCE_LOCK_PATH || path.resolve(process.cwd(), '.ai-trader.lock')) {
    this.lockPath = path.resolve(lockPath);
    this.acquired = false;
  }

  isProcessAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
    try {
      process.kill(numericPid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but this user cannot signal it.
      return error?.code === 'EPERM';
    }
  }

  readOwner() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  writeLock() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const fd = fs.openSync(this.lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cwd: process.cwd()
      }, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    this.acquired = true;
  }

  acquire() {
    if (this.acquired) return true;
    try {
      this.writeLock();
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const owner = this.readOwner();
    if (owner?.pid && this.isProcessAlive(owner.pid)) {
      throw new Error(
        `Another AI Trader instance is already running (PID ${owner.pid}). ` +
        `Stop it before starting this process. Lock: ${this.lockPath}`
      );
    }

    // The previous process died without cleanup. Remove only a confirmed stale
    // or unreadable lock, then retry using exclusive creation.
    try {
      fs.unlinkSync(this.lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.writeLock();
    return true;
  }

  release() {
    if (!this.acquired) return;
    const owner = this.readOwner();
    if (!owner?.pid || Number(owner.pid) === process.pid) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    this.acquired = false;
  }
}

const singleton = new ProcessLock();
module.exports = singleton;
module.exports.ProcessLock = ProcessLock;
