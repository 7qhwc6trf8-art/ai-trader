'use strict';

/**
 * Small compatibility layer over Node's built-in node:sqlite and
 * better-sqlite3. V16 prefers the built-in backend when available so a native
 * npm postinstall failure cannot make the entire bot unbootable. Node 20 users
 * can still use the optional better-sqlite3 package.
 */
let Backend = null;
let backendName = null;
let backendError = null;

try {
  const { DatabaseSync } = require('node:sqlite');
  Backend = DatabaseSync;
  backendName = 'node:sqlite';
} catch (error) {
  backendError = error;
}

if (!Backend) {
  try {
    Backend = require('better-sqlite3');
    backendName = 'better-sqlite3';
  } catch (error) {
    backendError = error;
  }
}

class SQLiteDatabase {
  constructor(filename) {
    if (!Backend) {
      const error = new Error(
        'No SQLite backend is available. Use Node.js 22.5+ or install better-sqlite3.'
      );
      error.cause = backendError;
      throw error;
    }
    try {
      this.raw = new Backend(filename);
    } catch (error) {
      // A require() can succeed while a better-sqlite3 native binding is
      // missing. If that happens and node:sqlite is available, recover here.
      if (backendName === 'better-sqlite3') {
        try {
          const { DatabaseSync } = require('node:sqlite');
          this.raw = new DatabaseSync(filename);
          backendName = 'node:sqlite';
        } catch (_) {
          throw error;
        }
      } else {
        throw error;
      }
    }
    this.open = true;
  }

  pragma(statement) {
    const text = String(statement || '').trim().replace(/;+$/, '');
    if (!text) return undefined;
    // better-sqlite3's pragma() returns rows for query pragmas. V16 only uses
    // assignment pragmas, so exec is portable and deterministic.
    return this.raw.exec(`PRAGMA ${text};`);
  }

  exec(sql) {
    return this.raw.exec(sql);
  }

  prepare(sql) {
    return this.raw.prepare(sql);
  }

  transaction(fn) {
    if (typeof this.raw.transaction === 'function') return this.raw.transaction(fn);
    return (...args) => {
      this.raw.exec('BEGIN IMMEDIATE;');
      try {
        const result = fn(...args);
        this.raw.exec('COMMIT;');
        return result;
      } catch (error) {
        try { this.raw.exec('ROLLBACK;'); } catch (_) {}
        throw error;
      }
    };
  }

  close() {
    if (!this.open) return;
    this.raw.close();
    this.open = false;
  }
}

function isAvailable() {
  return Boolean(Backend);
}

function getBackendName() {
  return backendName;
}

module.exports = { SQLiteDatabase, isAvailable, getBackendName };
