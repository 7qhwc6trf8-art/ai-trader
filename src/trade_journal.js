'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./core/config');
const { normalizeCoin } = require('./symbol_utils');

class TradeJournal {
  constructor() {
    this.dir = config.app.logsDir;
    this.file = path.join(this.dir, 'trade_journal.ndjson');
    this.stateFile = path.join(config.app.dataDir, 'trade_journal_state.json');
    this.state = this.loadState();
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return { version: 4, openByCoin: {}, pendingByCoin: {}, signalsById: {}, processedEventIds: {}, ...parsed, version: 4 };
    } catch (_) {
      return { version: 4, openByCoin: {}, pendingByCoin: {}, signalsById: {}, processedEventIds: {} };
    }
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.stateFile);
  }

  makeId(type, payload = {}) {
    const raw = [type, payload.eventId, payload.tradeId, payload.orderId, payload.signalId, payload.coin, payload.timestamp, payload.closedAt].filter(Boolean).join('|');
    return crypto.createHash('sha256').update(raw || `${type}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 28);
  }

  append(type, payload = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const timestamp = payload.timestamp || new Date().toISOString();
    const eventId = payload.eventId || this.makeId(type, { ...payload, timestamp });
    if (this.state.processedEventIds[eventId]) return { duplicate: true, eventId, type, ...payload };

    const row = { timestamp, eventId, type, ...payload };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    this.state.processedEventIds[eventId] = timestamp;

    const eventIds = Object.keys(this.state.processedEventIds);
    if (eventIds.length > 20000) {
      eventIds.sort((a, b) => String(this.state.processedEventIds[a]).localeCompare(String(this.state.processedEventIds[b])));
      for (const id of eventIds.slice(0, eventIds.length - 15000)) delete this.state.processedEventIds[id];
    }
    this.saveState();
    return row;
  }

  signal(payload = {}) {
    const coin = normalizeCoin(payload.coin || payload.symbol);
    const row = this.append('SIGNAL', { ...payload, coin });
    if (payload.signalId) {
      this.state.signalsById[String(payload.signalId)] = {
        signalId: String(payload.signalId),
        signal: { ...payload, coin },
        signaledAt: row.timestamp
      };
      const ids = Object.keys(this.state.signalsById);
      if (ids.length > 5000) {
        ids.sort((a, b) => String(this.state.signalsById[a]?.signaledAt || '').localeCompare(String(this.state.signalsById[b]?.signaledAt || '')));
        for (const id of ids.slice(0, ids.length - 3500)) delete this.state.signalsById[id];
      }
      this.saveState();
    }
    return row;
  }

  blocked(payload) { return this.append('BLOCKED', payload); }


  submitted(payload = {}) {
    const coin = normalizeCoin(payload.coin || payload.symbol);
    const row = this.append('ORDER_SUBMITTED', { ...payload, coin });
    if (coin) {
      this.state.pendingByCoin[coin] = {
        ...payload,
        coin,
        submittedAt: row.timestamp
      };
      this.saveState();
    }
    return row;
  }

  opened(payload = {}) {
    const coin = normalizeCoin(payload.coin || payload.symbol);
    const row = this.append('OPENED', { ...payload, coin });
    if (coin) {
      const signalId = payload.signalId ? String(payload.signalId) : null;
      const storedSignal = signalId ? this.state.signalsById[signalId]?.signal : null;
      delete this.state.pendingByCoin[coin];
      this.state.openByCoin[coin] = {
        signalId,
        orderId: payload.orderId || null,
        tradeId: payload.tradeId || payload.orderId || null,
        entryPrice: payload.entryPrice,
        stopLoss: payload.stopLoss,
        takeProfit: payload.takeProfit,
        riskAmount: payload.riskAmount,
        openedAt: row.timestamp,
        signal: payload.signal || storedSignal || null
      };
      this.saveState();
    }
    return row;
  }

  closed(payload = {}) {
    const coin = normalizeCoin(payload.coin || payload.symbol);
    const row = this.append('CLOSED', { ...payload, coin });
    if (coin) {
      delete this.state.openByCoin[coin];
      delete this.state.pendingByCoin[coin];
      this.saveState();
    }
    return row;
  }

  protection(payload) { return this.append('PROTECTION', payload); }
  fatal(payload) { return this.append('FATAL', payload); }

  findOpenByCoin(coin) {
    return this.state.openByCoin[normalizeCoin(coin)] || null;
  }

  findPendingByCoin(coin) {
    return this.state.pendingByCoin[normalizeCoin(coin)] || null;
  }

  clearPending(coin) {
    const normalized = normalizeCoin(coin);
    if (!normalized || !this.state.pendingByCoin[normalized]) return false;
    delete this.state.pendingByCoin[normalized];
    this.saveState();
    return true;
  }

  listOpen() {
    return { ...this.state.openByCoin };
  }

  listPending() {
    return { ...this.state.pendingByCoin };
  }
}

module.exports = new TradeJournal();
