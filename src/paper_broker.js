'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config, finite } = require('./core/config');
const market = require('./market');
const { normalizeCoin, sameCoin } = require('./symbol_utils');

class PaperBroker {
  constructor() {
    this.file = process.env.PAPER_STATE_FILE || path.join(config.app.dataDir, 'paper_account.json');
    this.initialBalance = Math.max(1, finite(process.env.PAPER_INITIAL_BALANCE, 10000));
    this.state = this.load();
  }

  emptyState() {
    return { version: 1, walletBalance: this.initialBalance, positions: {}, closedTrades: [], processedEvents: {}, updatedAt: null };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...this.emptyState(), ...parsed, positions: parsed.positions || {}, closedTrades: parsed.closedTrades || [], processedEvents: parsed.processedEvents || {} };
    } catch (_) {
      return this.emptyState();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.state.updatedAt = new Date().toISOString();
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.file);
  }

  async getTicker(symbol) {
    try { return await market.getTicker(symbol); }
    catch (_) {
      const candles = await market.getCandles(symbol, '1m', 3);
      const last = candles[candles.length - 1][4];
      const spread = last * 0.0002;
      return { last, mark: last, bid: last - spread / 2, ask: last + spread / 2 };
    }
  }

  unrealized(position, markPrice) {
    return position.action === 'BUY'
      ? (markPrice - position.entryPrice) * position.size
      : (position.entryPrice - markPrice) * position.size;
  }

  funding(position, timestamp = Date.now()) {
    const periods = Math.max(0, timestamp - position.openedAtMs) / (8 * 60 * 60 * 1000);
    const direction = position.action === 'BUY' ? 1 : -1;
    return position.notional * config.costs.fundingRate8h * periods * direction;
  }

  async syncPositions() {
    const closed = [];
    for (const position of Object.values(this.state.positions)) {
      const candles = await market.getCandles(position.coin, '1m', 10);
      const newCandles = candles.filter(candle => Number(candle[0]) > finite(position.lastCandleTime, 0));
      for (const candle of newCandles) {
        const [timestamp, open, high, low, close] = candle.map(Number);
        position.markPrice = close;
        position.lastCandleTime = timestamp;
        const isLong = position.action === 'BUY';
        const stopHit = isLong ? low <= position.stopLoss : high >= position.stopLoss;
        const targetHit = isLong ? high >= position.takeProfit : low <= position.takeProfit;
        let exitPrice = null;
        let reason = null;
        if (isLong && open <= position.stopLoss) { exitPrice = open; reason = 'PAPER_STOP_GAP'; }
        else if (!isLong && open >= position.stopLoss) { exitPrice = open; reason = 'PAPER_STOP_GAP'; }
        else if (isLong && open >= position.takeProfit) { exitPrice = open; reason = 'PAPER_TARGET_GAP'; }
        else if (!isLong && open <= position.takeProfit) { exitPrice = open; reason = 'PAPER_TARGET_GAP'; }
        else if (stopHit && targetHit) { exitPrice = position.stopLoss; reason = 'PAPER_STOP_AMBIGUOUS'; }
        else if (stopHit) { exitPrice = position.stopLoss; reason = 'PAPER_STOP_LOSS'; }
        else if (targetHit) { exitPrice = position.takeProfit; reason = 'PAPER_TAKE_PROFIT'; }

        if (exitPrice !== null) {
          closed.push(await this.closePosition(position.coin, position.size, isLong ? 'long' : 'short', { exitPrice, reason, timestamp }));
          break;
        }
      }
    }
    if (closed.length) this.save();
    return closed;
  }

  async getBalance() {
    await this.syncPositions();
    let floating = 0;
    let usedMargin = 0;
    for (const position of Object.values(this.state.positions)) {
      const ticker = await this.getTicker(position.coin);
      const mark = finite(ticker?.last ?? ticker?.mark, position.markPrice || position.entryPrice);
      position.markPrice = mark;
      floating += this.unrealized(position, mark) - this.funding(position);
      usedMargin += position.notional / position.leverage;
    }
    const totalUSD = this.state.walletBalance + floating;
    const tradableUSD = Math.max(0, totalUSD - usedMargin);
    this.save();
    return {
      totalUSD, tradableUSD, availableUSDT: tradableUSD, walletUSDT: this.state.walletBalance,
      fundingUSDT: 0, assets: [{ asset: 'USDT', free: tradableUSD, used: usedMargin, total: totalUSD, usdValue: totalUSD }],
      mode: 'paper', isMock: false, paper: true, unavailable: false
    };
  }

  async getPortfolio() {
    const balance = await this.getBalance();
    const positions = [];
    for (const position of Object.values(this.state.positions)) {
      const ticker = await this.getTicker(position.coin);
      const markPrice = finite(ticker?.last ?? ticker?.mark, position.entryPrice);
      const unrealizedPnl = this.unrealized(position, markPrice) - this.funding(position);
      positions.push({
        ...position,
        symbol: `${position.coin}/USDT:USDT`,
        side: position.action === 'BUY' ? 'long' : 'short',
        markPrice,
        unrealizedPnl,
        percentage: position.notional > 0 ? unrealizedPnl / position.notional * 100 : 0
      });
    }
    return { totalValue: balance.totalUSD, equity: balance.totalUSD, availableToTrade: balance.tradableUSD, positions, mode: 'paper' };
  }

  async openPosition(coin, action, size, stopLoss, takeProfit, leverage, approval = {}) {
    await this.syncPositions();
    const normalized = normalizeCoin(coin);
    if (Object.values(this.state.positions).some(position => sameCoin(position.coin, normalized))) return { success: false, error: `Paper position already exists for ${normalized}` };
    if (Object.keys(this.state.positions).length >= config.risk.maxOpenPositions) return { success: false, error: 'Paper max positions reached' };
    const numericSize = finite(size);
    const numericLeverage = Math.trunc(finite(leverage, 1));
    if (!(numericSize > 0) || !config.risk.allowedLeverages.includes(numericLeverage)) return { success: false, error: 'Invalid paper size or leverage' };
    const ticker = await this.getTicker(normalized);
    const rawPrice = finite(ticker?.last ?? ticker?.mark);
    if (!(rawPrice > 0)) return { success: false, error: 'Paper ticker unavailable' };
    const expected = finite(approval.expectedEntryPrice, rawPrice);
    const drift = expected > 0 ? Math.abs(rawPrice - expected) / expected * 100 : 0;
    if (drift > config.bybit.maxEntryDriftPct) return { success: false, error: `Paper entry drift ${drift.toFixed(3)}% is too high` };
    const entryPrice = rawPrice * (action === 'BUY' ? 1 + config.costs.estimatedSlippageRate : 1 - config.costs.estimatedSlippageRate);
    if (action === 'BUY' && !(stopLoss < entryPrice && takeProfit > entryPrice)) return { success: false, error: 'Invalid paper BUY protection' };
    if (action === 'SELL' && !(stopLoss > entryPrice && takeProfit < entryPrice)) return { success: false, error: 'Invalid paper SELL protection' };
    const notional = entryPrice * numericSize;
    const balance = await this.getBalance();
    const margin = notional / numericLeverage;
    if (margin > balance.tradableUSD) return { success: false, error: 'Insufficient paper margin' };
    const entryFee = notional * config.costs.takerFeeRate;
    this.state.walletBalance -= entryFee;
    const orderId = approval.clientOrderId || `paper-${crypto.randomUUID()}`;
    const candles = await market.getCandles(normalized, '1m', 2);
    const position = {
      coin: normalized, action, size: numericSize, leverage: numericLeverage, entryPrice,
      stopLoss: finite(stopLoss), takeProfit: finite(takeProfit), notional, margin,
      entryFee, openedAt: new Date().toISOString(), openedAtMs: Date.now(),
      lastCandleTime: Number(candles.at(-1)?.[0] || Date.now()), markPrice: rawPrice,
      orderId, clientOrderId: approval.clientOrderId || orderId, signalId: approval.signalId || null
    };
    this.state.positions[normalized] = position;
    this.save();
    return {
      success: true,
      paper: true,
      order: { id: orderId, clientOrderId: position.clientOrderId, status: 'closed', filled: numericSize, average: entryPrice },
      position,
      protection: { success: true, paper: true, verification: { protected: true } },
      clientOrderId: position.clientOrderId
    };
  }

  async closePosition(coin, size, side, options = {}) {
    const normalized = normalizeCoin(coin);
    const position = this.state.positions[normalized];
    if (!position) return { error: `No paper position for ${normalized}` };
    const ticker = options.exitPrice ? null : await this.getTicker(normalized);
    const rawExit = finite(options.exitPrice, finite(ticker?.last ?? ticker?.mark, position.markPrice));
    const exitPrice = rawExit * (position.action === 'BUY' ? 1 - config.costs.estimatedSlippageRate : 1 + config.costs.estimatedSlippageRate);
    const qty = Math.min(position.size, finite(size, position.size));
    const gross = position.action === 'BUY' ? (exitPrice - position.entryPrice) * qty : (position.entryPrice - exitPrice) * qty;
    const closeFee = exitPrice * qty * config.costs.takerFeeRate;
    const funding = this.funding(position, finite(options.timestamp, Date.now()));
    const closedPnl = gross - position.entryFee - closeFee - funding;
    this.state.walletBalance += gross - closeFee - funding;
    const record = {
      tradeId: position.orderId,
      orderId: position.orderId,
      symbol: `${normalized}USDT`,
      side: position.action === 'BUY' ? 'Buy' : 'Sell',
      leverage: position.leverage,
      qty,
      entryPrice: position.entryPrice,
      exitPrice,
      closedPnl,
      openFee: position.entryFee,
      closeFee,
      createdTime: position.openedAtMs,
      updatedTime: finite(options.timestamp, Date.now()),
      reason: options.reason || 'PAPER_MANUAL_CLOSE'
    };
    delete this.state.positions[normalized];
    this.state.closedTrades.push(record);
    this.state.closedTrades = this.state.closedTrades.slice(-10000);
    this.save();
    return { ...record, success: true, paper: true };
  }

  dateKey(timestamp, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  async getOrders(_coin = null, limit = 20) {
    await this.syncPositions();
    const open = Object.values(this.state.positions).map(position => ({
      id: position.orderId,
      symbol: `${position.coin}/USDT:USDT`,
      side: position.action === 'BUY' ? 'buy' : 'sell',
      amount: position.size,
      filled: position.size,
      price: position.entryPrice,
      average: position.entryPrice,
      status: 'open',
      timestamp: position.openedAtMs,
      paper: true
    }));
    const closed = [...this.state.closedTrades].reverse().map(record => ({
      id: record.orderId,
      symbol: `${normalizeCoin(record.symbol)}/USDT:USDT`,
      side: String(record.side || '').toLowerCase(),
      amount: finite(record.qty),
      filled: finite(record.qty),
      price: finite(record.exitPrice),
      average: finite(record.exitPrice),
      status: 'closed',
      timestamp: finite(record.updatedTime),
      pnl: finite(record.closedPnl),
      paper: true
    }));
    return [...open, ...closed].slice(0, Math.max(1, Math.min(1000, Number(limit) || 20)));
  }

  async getDailyClosedPnl(timeZone = config.app.timezone, now = Date.now()) {
    await this.syncPositions();
    const dayKey = this.dateKey(now, timeZone);
    const records = this.state.closedTrades.filter(record => this.dateKey(record.updatedTime, timeZone) === dayKey);
    const netPnl = records.reduce((sum, record) => sum + finite(record.closedPnl), 0);
    return {
      available: true, paper: true, dayKey, timeZone,
      netPnl,
      grossProfit: records.reduce((sum, record) => sum + Math.max(0, finite(record.closedPnl)), 0),
      grossLoss: records.reduce((sum, record) => sum + Math.abs(Math.min(0, finite(record.closedPnl))), 0),
      recordCount: records.length,
      records,
      syncedAt: new Date().toISOString(),
      error: null
    };
  }

  async getMarketRules(coin, price) { return market.getMarketRules(coin, price); }
  getMode() { return 'paper'; }
}

module.exports = new PaperBroker();
