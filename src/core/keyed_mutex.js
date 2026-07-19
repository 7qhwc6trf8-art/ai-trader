'use strict';

class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  async run(key, task) {
    if (typeof task !== 'function') throw new TypeError('KeyedMutex task must be a function');
    const normalized = String(key || 'global');
    const previous = this.tails.get(normalized) || Promise.resolve();
    const execution = previous.catch(() => undefined).then(task);
    const tail = execution.catch(() => undefined);
    this.tails.set(normalized, tail);
    try {
      return await execution;
    } finally {
      if (this.tails.get(normalized) === tail) this.tails.delete(normalized);
    }
  }

  isLocked(key) {
    return this.tails.has(String(key || 'global'));
  }
}

module.exports = new KeyedMutex();
