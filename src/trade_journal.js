'use strict';

const fs = require('fs');
const path = require('path');

class TradeJournal {
  constructor() {
    this.dir = path.join(__dirname, '../logs');
    this.file = path.join(this.dir, 'trade_journal.ndjson');
  }

  append(type, payload = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const row = { timestamp: new Date().toISOString(), type, ...payload };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    return row;
  }

  signal(payload) { return this.append('SIGNAL', payload); }
  blocked(payload) { return this.append('BLOCKED', payload); }
  opened(payload) { return this.append('OPENED', payload); }
  closed(payload) { return this.append('CLOSED', payload); }
}

module.exports = new TradeJournal();
