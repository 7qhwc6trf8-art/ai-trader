'use strict';

const { normalizeCoin, sameCoin } = require('./symbol_utils');

const finite = (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class ExecutionGuard {
  constructor() {
    this.maxPortfolioExposurePct = clamp(finite(process.env.MAX_PORTFOLIO_EXPOSURE_PCT, 35), 1, 100);
    this.maxSymbolExposurePct = clamp(finite(process.env.MAX_SYMBOL_EXPOSURE_PCT, 12), 0.5, 100);
    this.maxMarginPerTradePct = clamp(finite(process.env.MAX_MARGIN_PER_TRADE_PCT, 8), 0.5, 100);
    this.maxLeverage = clamp(Math.floor(finite(process.env.MAX_AI_LEVERAGE, 5)), 1, 5);
    this.minStopPct = clamp(finite(process.env.MIN_STOP_DISTANCE_PCT, 0.25), 0.01, 20);
    this.maxStopPct = clamp(finite(process.env.MAX_STOP_DISTANCE_PCT, 5), this.minStopPct, 50);
    this.minExecutionScore = clamp(finite(process.env.MIN_EXECUTION_SCORE, 68), 0, 100);
  }

  validate({ signal, portfolio = {}, equity = 0, plannedNotional = 0, plannedMargin = 0, leverage = 1 }) {
    const reasons = [];
    const action = String(signal?.action || '').toUpperCase();
    const coin = normalizeCoin(signal?.coin || signal?.symbol);
    const entry = finite(signal?.entryPrice);
    const stop = finite(signal?.stopLoss);
    const score = finite(signal?.executionScore ?? signal?.calibratedScore ?? signal?.confidence);
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];

    if (!['BUY', 'SELL'].includes(action)) reasons.push('Action must be BUY or SELL.');
    if (!coin) reasons.push('Missing normalized coin symbol.');
    if (!(entry > 0) || !(stop > 0)) reasons.push('Entry and stop-loss must be positive.');
    if (score < this.minExecutionScore) reasons.push(`Execution score ${score.toFixed(1)} < ${this.minExecutionScore}.`);
    if (leverage < 1 || leverage > this.maxLeverage) reasons.push(`Leverage ${leverage}x outside 1-${this.maxLeverage}x.`);

    if (entry > 0 && stop > 0) {
      const stopPct = Math.abs(entry - stop) / entry * 100;
      if (stopPct < this.minStopPct) reasons.push(`Stop distance ${stopPct.toFixed(3)}% is too tight.`);
      if (stopPct > this.maxStopPct) reasons.push(`Stop distance ${stopPct.toFixed(3)}% is too wide.`);
      if (action === 'BUY' && stop >= entry) reasons.push('BUY stop-loss must be below entry.');
      if (action === 'SELL' && stop <= entry) reasons.push('SELL stop-loss must be above entry.');
    }

    if (positions.some(p => sameCoin(p.symbol || p.coin, coin))) {
      reasons.push(`A ${coin} position already exists on Bybit.`);
    }

    const totalExposure = positions.reduce((sum, p) => {
      const notional = finite(p.notional, Math.abs(finite(p.size) * finite(p.markPrice || p.entryPrice)));
      return sum + Math.abs(notional);
    }, 0);
    const symbolExposure = positions
      .filter(p => sameCoin(p.symbol || p.coin, coin))
      .reduce((sum, p) => sum + Math.abs(finite(p.notional, finite(p.size) * finite(p.markPrice || p.entryPrice))), 0);

    if (equity > 0) {
      const portfolioPct = (totalExposure + plannedNotional) / equity * 100;
      const symbolPct = (symbolExposure + plannedNotional) / equity * 100;
      const marginPct = plannedMargin / equity * 100;
      if (portfolioPct > this.maxPortfolioExposurePct) reasons.push(`Portfolio exposure ${portfolioPct.toFixed(1)}% exceeds ${this.maxPortfolioExposurePct}%.`);
      if (symbolPct > this.maxSymbolExposurePct) reasons.push(`Symbol exposure ${symbolPct.toFixed(1)}% exceeds ${this.maxSymbolExposurePct}%.`);
      if (marginPct > this.maxMarginPerTradePct) reasons.push(`Trade margin ${marginPct.toFixed(1)}% exceeds ${this.maxMarginPerTradePct}%.`);
    }

    return { passed: reasons.length === 0, reasons, coin, score };
  }
}

module.exports = new ExecutionGuard();
