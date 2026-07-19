'use strict';

const logger = require('./logger');
const { sameCoin } = require('./symbol_utils');

const finite = (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class RiskManager {
  constructor(config = {}) {
    this.riskPerTrade = clamp(finite(process.env.RISK_PER_TRADE_PCT, 0.35) / 100, 0.0005, 0.02);
    this.maxRiskPerTrade = clamp(finite(process.env.MAX_RISK_PER_TRADE_PCT, 0.50) / 100, this.riskPerTrade, 0.03);
    this.maxPositions = clamp(Math.floor(finite(process.env.MAX_OPEN_POSITIONS, 2)), 1, 10);
    this.maxTradesPerDay = clamp(Math.floor(finite(process.env.MAX_TRADES_PER_DAY, 4)), 1, 50);
    this.maxDailyLossPct = clamp(finite(process.env.MAX_DAILY_LOSS_PCT, 2), 0.25, 20);
    this.maxConsecutiveLosses = clamp(Math.floor(finite(process.env.MAX_CONSECUTIVE_LOSSES, 2)), 1, 10);
    this.minRiskReward = clamp(finite(process.env.MIN_RISK_REWARD, 1.5), 0.5, 10);
    this.minExecutionScore = clamp(finite(process.env.MIN_EXECUTION_SCORE, 68), 0, 100);
    this.resetDaily();
  }

  dateKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.DAILY_TARGET_TIMEZONE || 'Asia/Yerevan' }).format(new Date()); }
  resetDailyIfNeeded() { if (this.lastResetDate !== this.dateKey()) this.resetDaily(); }
  resetDaily() {
    this.dailyNetPnl = 0;
    this.tradesToday = 0;
    this.consecutiveLosses = 0;
    this.lastResetDate = this.dateKey();
  }

  validate(signal, portfolio = {}, account = {}) {
    this.resetDailyIfNeeded();
    const checks = [];
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const equity = finite(account.equity ?? portfolio.totalValue ?? portfolio.equity);
    const lossBaseEquity = finite(account.openingEquity, equity);
    const executionScore = finite(signal.executionScore ?? signal.calibratedScore ?? signal.confidence);
    const rr = finite(signal.riskReward);

    if (executionScore < this.minExecutionScore) checks.push(`Execution score ${executionScore.toFixed(1)} < ${this.minExecutionScore}`);
    if (rr < this.minRiskReward) checks.push(`Risk/reward ${rr.toFixed(2)} < ${this.minRiskReward.toFixed(2)}`);
    if (positions.length >= this.maxPositions) checks.push(`Max positions ${this.maxPositions} reached`);
    if (this.tradesToday >= this.maxTradesPerDay) checks.push(`Max trades/day ${this.maxTradesPerDay} reached`);
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) checks.push(`${this.consecutiveLosses} consecutive losses: daily circuit breaker active`);
    if (lossBaseEquity > 0 && this.dailyNetPnl <= -(lossBaseEquity * this.maxDailyLossPct / 100)) checks.push(`Daily loss limit ${this.maxDailyLossPct}% reached`);
    if (positions.some(p => sameCoin(p.symbol || p.coin, signal.coin || signal.symbol))) checks.push(`Position already exists for ${signal.coin || signal.symbol}`);

    return { passed: checks.length === 0, checks };
  }

  calculatePositionPlan({ balance, entry, stopLoss, leverage = 1, volatilityMultiplier = 1, maxMarginPct = 8 }) {
    balance = finite(balance); entry = finite(entry); stopLoss = finite(stopLoss); leverage = clamp(finite(leverage, 1), 1, 5);
    const stopDistance = Math.abs(entry - stopLoss);
    if (!(balance > 0 && entry > 0 && stopDistance > 0)) return { size: 0, notional: 0, margin: 0, riskAmount: 0 };
    const riskFraction = clamp(this.riskPerTrade * clamp(volatilityMultiplier, 0.35, 1), 0.0005, this.maxRiskPerTrade);
    const riskAmount = balance * riskFraction;
    const riskBasedSize = riskAmount / stopDistance;
    const maxMargin = balance * clamp(maxMarginPct / 100, 0.005, 0.25);
    const maxNotional = maxMargin * leverage;
    const size = Math.min(riskBasedSize, maxNotional / entry) * 0.997;
    return { size, notional: size * entry, margin: size * entry / leverage, riskAmount, riskPercent: riskFraction * 100 };
  }

  calculatePositionSize(balance, entry, stopLoss, leverage = 1) {
    return this.calculatePositionPlan({ balance, entry, stopLoss, leverage }).size;
  }

  calculateRiskReward(entry, stopLoss, takeProfit) {
    const risk = Math.abs(finite(entry) - finite(stopLoss));
    return risk > 0 ? Math.abs(finite(takeProfit) - finite(entry)) / risk : 0;
  }

  syncDailyState({ netPnl = 0, trades = 0, consecutiveLosses = 0, dateKey = null } = {}) {
    this.dailyNetPnl = finite(netPnl);
    this.tradesToday = Math.max(0, Math.trunc(finite(trades)));
    this.consecutiveLosses = Math.max(0, Math.trunc(finite(consecutiveLosses)));
    this.lastResetDate = dateKey || this.dateKey();
    logger.action('RISK_DAILY_SYNC', {
      dailyNetPnl: this.dailyNetPnl,
      tradesToday: this.tradesToday,
      consecutiveLosses: this.consecutiveLosses,
      dateKey: this.lastResetDate
    });
  }

  updateDailyLoss(pnl) {
    this.resetDailyIfNeeded();
    pnl = finite(pnl);
    this.dailyNetPnl += pnl;
    this.tradesToday += 1;
    this.consecutiveLosses = pnl < 0 ? this.consecutiveLosses + 1 : 0;
    logger.action('RISK_DAILY_UPDATE', { dailyNetPnl: this.dailyNetPnl, tradesToday: this.tradesToday, consecutiveLosses: this.consecutiveLosses });
  }

  getStatus() {
    this.resetDailyIfNeeded();
    return {
      dailyNetPnl: this.dailyNetPnl,
      tradesToday: this.tradesToday,
      consecutiveLosses: this.consecutiveLosses,
      maxPositions: this.maxPositions,
      maxTradesPerDay: this.maxTradesPerDay,
      maxDailyLossPct: this.maxDailyLossPct,
      riskPerTradePct: this.riskPerTrade * 100,
      minExecutionScore: this.minExecutionScore,
      minRiskReward: this.minRiskReward
    };
  }
}

module.exports = new RiskManager();
