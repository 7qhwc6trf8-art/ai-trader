'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { sameCoin, normalizeCoin } = require('./symbol_utils');
const { config, finite } = require('./core/config');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class RiskManager {
  constructor() {
    this.file = process.env.RISK_STATE_FILE || path.join(config.app.dataDir, 'risk_state.json');
    this.state = this.load();
    this.ensureCurrentDay();
  }

  dateKey(timestamp = Date.now()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: config.app.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(timestamp))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  weekKey(timestamp = Date.now()) {
    // Compute ISO week from the calendar date in the configured trading
    // timezone, not from the server's UTC date. This keeps daily and weekly
    // circuit breakers on the same local calendar around midnight.
    const [year, month, dayOfMonth] = this.dateKey(timestamp).split('-').map(Number);
    const utc = new Date(Date.UTC(year, month - 1, dayOfMonth));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const isoYear = utc.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
  }

  emptyState() {
    return {
      version: 2,
      dayKey: this.dateKey(),
      weekKey: this.weekKey(),
      dayStartEquity: 0,
      weekStartEquity: 0,
      weekPeakEquity: 0,
      dailyNetPnl: 0,
      dailyGrossProfit: 0,
      dailyGrossLoss: 0,
      tradesOpenedToday: 0,
      closedTradesToday: 0,
      consecutiveLosses: 0,
      processedClosedTradeIds: {},
      lastTradeTimeByCoin: {},
      lastUpdatedAt: null
    };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...this.emptyState(),
        ...parsed,
        processedClosedTradeIds: parsed.processedClosedTradeIds || {},
        lastTradeTimeByCoin: parsed.lastTradeTimeByCoin || {}
      };
    } catch (_) {
      return this.emptyState();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.state.lastUpdatedAt = new Date().toISOString();
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.file);
  }

  ensureCurrentDay(equity = 0) {
    const today = this.dateKey();
    const week = this.weekKey();
    let changed = false;

    if (this.state.weekKey !== week) {
      this.state.weekKey = week;
      this.state.weekStartEquity = Math.max(0, finite(equity));
      this.state.weekPeakEquity = Math.max(0, finite(equity));
      changed = true;
    }

    if (this.state.dayKey !== today) {
      this.state.dayKey = today;
      this.state.dayStartEquity = Math.max(0, finite(equity));
      this.state.dailyNetPnl = 0;
      this.state.dailyGrossProfit = 0;
      this.state.dailyGrossLoss = 0;
      this.state.tradesOpenedToday = 0;
      this.state.closedTradesToday = 0;
      this.state.consecutiveLosses = 0;
      this.state.processedClosedTradeIds = {};
      changed = true;
    }

    if (equity > 0) {
      if (!(this.state.dayStartEquity > 0)) { this.state.dayStartEquity = equity; changed = true; }
      if (!(this.state.weekStartEquity > 0)) { this.state.weekStartEquity = equity; changed = true; }
      if (equity > finite(this.state.weekPeakEquity)) { this.state.weekPeakEquity = equity; changed = true; }
    }

    if (changed) this.save();
  }

  setEquity(equity) {
    const value = Math.max(0, finite(equity));
    this.ensureCurrentDay(value);
    if (value > finite(this.state.weekPeakEquity)) {
      this.state.weekPeakEquity = value;
      this.save();
    }
  }

  recordOpenedTrade(payload = {}) {
    this.ensureCurrentDay(finite(payload.equity));
    this.state.tradesOpenedToday += 1;
    const coin = normalizeCoin(payload.coin);
    const openedAtMs = Math.max(0, finite(payload.openedAtMs, Date.now()));
    if (coin) this.state.lastTradeTimeByCoin[coin] = openedAtMs;
    this.save();
    logger.action('RISK_TRADE_OPENED', {
      coin,
      openedAtMs,
      tradesOpenedToday: this.state.tradesOpenedToday
    });
  }

  getLastTradeTime(coin) {
    const normalized = normalizeCoin(coin);
    return normalized ? Math.max(0, finite(this.state.lastTradeTimeByCoin[normalized])) : 0;
  }

  reconcileClosedRecords(records = [], equity = 0) {
    this.ensureCurrentDay(equity);
    const sorted = [...records].sort((a, b) => finite(a.updatedTime || a.createdTime) - finite(b.updatedTime || b.createdTime));
    let changed = false;
    const newlyProcessed = [];

    for (const record of sorted) {
      const tradeId = String(record.tradeId || record.orderId || `${record.symbol || ''}:${record.updatedTime || record.createdTime || ''}:${record.closedPnl || ''}`);
      if (this.state.processedClosedTradeIds[tradeId]) continue;
      const pnl = finite(record.closedPnl ?? record.netPnl ?? record.pnl);
      this.state.dailyNetPnl += pnl;
      this.state.dailyGrossProfit += Math.max(0, pnl);
      this.state.dailyGrossLoss += Math.abs(Math.min(0, pnl));
      this.state.closedTradesToday += 1;
      this.state.consecutiveLosses = pnl < 0 ? this.state.consecutiveLosses + 1 : 0;
      this.state.processedClosedTradeIds[tradeId] = new Date().toISOString();
      newlyProcessed.push({ ...record, tradeId, pnl });
      changed = true;
    }

    const ids = Object.keys(this.state.processedClosedTradeIds);
    if (ids.length > 2000) {
      ids.sort((a, b) => String(this.state.processedClosedTradeIds[a]).localeCompare(String(this.state.processedClosedTradeIds[b])));
      for (const id of ids.slice(0, ids.length - 1500)) delete this.state.processedClosedTradeIds[id];
      changed = true;
    }

    if (changed) this.save();
    return newlyProcessed;
  }

  overwriteDailyFromExchange(snapshot = {}, equity = 0) {
    this.ensureCurrentDay(equity);
    if (!snapshot?.available) return;
    this.state.dailyNetPnl = finite(snapshot.netPnl);
    this.state.dailyGrossProfit = Math.max(0, finite(snapshot.grossProfit));
    this.state.dailyGrossLoss = Math.max(0, finite(snapshot.grossLoss));
    this.state.closedTradesToday = Math.max(this.state.closedTradesToday, Math.trunc(finite(snapshot.recordCount)));
    this.save();
  }

  calculatePositionPlan({ balance, entry, stopLoss, leverage = 1, volatilityMultiplier = 1, maxMarginPct = config.risk.maxMarginPerTradePct }) {
    balance = finite(balance);
    entry = finite(entry);
    stopLoss = finite(stopLoss);
    leverage = clamp(finite(leverage, 1), 1, config.risk.maxLeverage);
    const stopDistance = Math.abs(entry - stopLoss);
    if (!(balance > 0 && entry > 0 && stopDistance > 0)) {
      return { executable: false, size: 0, notional: 0, margin: 0, riskAmount: 0, reason: 'Invalid balance, entry or stop distance.' };
    }

    const riskFraction = clamp(
      config.risk.riskPerTradePct / 100 * clamp(volatilityMultiplier, 0.35, 1),
      0.0005,
      config.risk.maxRiskPerTradePct / 100
    );
    const riskAmount = balance * riskFraction;
    const riskBasedSize = riskAmount / stopDistance;
    const maxMargin = balance * clamp(maxMarginPct / 100, 0.005, 0.25);
    const maxNotional = maxMargin * leverage;
    const size = Math.max(0, Math.min(riskBasedSize, maxNotional / entry) * 0.995);
    const actualRisk = size * stopDistance;

    return {
      executable: size > 0,
      size,
      positionSize: size,
      notional: size * entry,
      margin: size * entry / leverage,
      marginUsed: size * entry / leverage,
      riskAmount: actualRisk,
      requestedRiskAmount: riskAmount,
      riskPercent: balance > 0 ? actualRisk / balance * 100 : 0,
      leverage,
      reason: 'Stop-based size capped by margin and configured maximum risk.'
    };
  }

  calculatePositionSize(balance, entry, stopLoss, leverage = 1) {
    return this.calculatePositionPlan({ balance, entry, stopLoss, leverage }).size;
  }

  calculateRiskReward(entry, stopLoss, takeProfit) {
    const risk = Math.abs(finite(entry) - finite(stopLoss));
    return risk > 0 ? Math.abs(finite(takeProfit) - finite(entry)) / risk : 0;
  }

  checkDailyLoss(_legacyDailyLoss, equity = 0) {
    this.ensureCurrentDay(equity);
    const base = finite(this.state.dayStartEquity, equity);
    if (!(base > 0)) return { passed: true, reason: null };

    const maxNetLoss = base * config.risk.maxDailyNetLossPct / 100;
    const maxGrossLoss = base * config.risk.maxDailyGrossLossPct / 100;
    const currentEquity = Math.max(0, finite(equity));
    const equityDrawdown = currentEquity > 0 ? Math.max(0, base - currentEquity) : 0;
    if (currentEquity > 0 && equityDrawdown >= maxNetLoss) {
      return { passed: false, reason: `Intraday equity drawdown reached: $${equityDrawdown.toFixed(2)} / $${maxNetLoss.toFixed(2)}.` };
    }
    if (this.state.dailyNetPnl <= -maxNetLoss) {
      return { passed: false, reason: `Daily net loss limit reached: $${Math.abs(this.state.dailyNetPnl).toFixed(2)} / $${maxNetLoss.toFixed(2)}.` };
    }
    if (this.state.dailyGrossLoss >= maxGrossLoss) {
      return { passed: false, reason: `Daily gross loss limit reached: $${this.state.dailyGrossLoss.toFixed(2)} / $${maxGrossLoss.toFixed(2)}.` };
    }
    return { passed: true, reason: null };
  }

  checkWeeklyDrawdown(equity) {
    this.setEquity(equity);
    const peak = finite(this.state.weekPeakEquity);
    const current = finite(equity);
    const drawdownPct = peak > 0 ? (peak - current) / peak * 100 : 0;
    return {
      passed: drawdownPct < config.risk.maxWeeklyDrawdownPct,
      drawdownPct,
      reason: drawdownPct >= config.risk.maxWeeklyDrawdownPct
        ? `Weekly drawdown ${drawdownPct.toFixed(2)}% reached the ${config.risk.maxWeeklyDrawdownPct}% limit.`
        : null
    };
  }

  validate(signal, portfolio = {}, account = {}) {
    const equity = finite(account.equity ?? portfolio.totalValue ?? portfolio.equity);
    this.ensureCurrentDay(equity);
    const checks = [];
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const executionScore = finite(signal.executionScore ?? signal.calibratedScore);
    const riskReward = finite(signal.riskReward);

    if (executionScore < config.risk.minExecutionScore) checks.push(`Execution score ${executionScore.toFixed(1)} < ${config.risk.minExecutionScore}`);
    if (riskReward < config.risk.minRiskReward) checks.push(`Risk/reward ${riskReward.toFixed(2)} < ${config.risk.minRiskReward.toFixed(2)}`);
    if (positions.length >= config.risk.maxOpenPositions) checks.push(`Max positions ${config.risk.maxOpenPositions} reached`);
    if (this.state.tradesOpenedToday >= config.risk.maxTradesPerDay) checks.push(`Max trades/day ${config.risk.maxTradesPerDay} reached`);
    if (this.state.consecutiveLosses >= config.risk.maxConsecutiveLosses) checks.push(`${this.state.consecutiveLosses} consecutive losses: circuit breaker active`);
    if (positions.some(position => sameCoin(position.symbol || position.coin, signal.coin || signal.symbol))) checks.push(`Position already exists for ${signal.coin || signal.symbol}`);

    const daily = this.checkDailyLoss(0, equity);
    if (!daily.passed) checks.push(daily.reason);
    const weekly = this.checkWeeklyDrawdown(equity);
    if (!weekly.passed) checks.push(weekly.reason);

    return { passed: checks.length === 0, checks, state: this.getStatus() };
  }

  updateDailyLoss(pnl) {
    // Backward-compatible local-close path. Exchange reconciliation remains the
    // primary source of truth and is idempotent.
    const synthetic = { orderId: `local-${Date.now()}-${Math.random()}`, closedPnl: finite(pnl), updatedTime: Date.now() };
    this.reconcileClosedRecords([synthetic]);
  }

  getStatus() {
    this.ensureCurrentDay();
    return {
      ...this.state,
      maxPositions: config.risk.maxOpenPositions,
      maxTradesPerDay: config.risk.maxTradesPerDay,
      maxDailyLossPct: config.risk.maxDailyNetLossPct,
      maxDailyGrossLossPct: config.risk.maxDailyGrossLossPct,
      riskPerTradePct: config.risk.riskPerTradePct,
      minExecutionScore: config.risk.minExecutionScore,
      minRiskReward: config.risk.minRiskReward,
      maxConsecutiveLosses: config.risk.maxConsecutiveLosses
    };
  }

  get maxPositions() {
    return config.risk.maxOpenPositions;
  }
}

module.exports = new RiskManager();
