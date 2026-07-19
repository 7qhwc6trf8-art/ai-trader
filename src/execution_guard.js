'use strict';

const { normalizeCoin, sameCoin } = require('./symbol_utils');
const { config, finite } = require('./core/config');

class ExecutionGuard {
  calculateNetRiskReward({ entry, stop, target, notional = 0, size = 0 }) {
    const riskPerUnit = Math.abs(entry - stop);
    const rewardPerUnit = Math.abs(target - entry);
    if (!(riskPerUnit > 0 && rewardPerUnit > 0)) return 0;
    const effectiveSize = size > 0 ? size : (entry > 0 ? notional / entry : 0);
    const grossRisk = riskPerUnit * effectiveSize;
    const grossReward = rewardPerUnit * effectiveSize;
    const estimatedCosts = Math.abs(notional || entry * effectiveSize) *
      (config.costs.takerFeeRate * 2 + config.costs.estimatedSlippageRate * 2);
    return grossRisk + estimatedCosts > 0
      ? Math.max(0, grossReward - estimatedCosts) / (grossRisk + estimatedCosts)
      : 0;
  }

  validate({
    signal,
    portfolio = {},
    equity = 0,
    plannedNotional = 0,
    plannedMargin = 0,
    leverage = 1,
    ticker = null,
    now = Date.now()
  }) {
    const reasons = [];
    const warnings = [];
    const action = String(signal?.action || '').toUpperCase();
    const coin = normalizeCoin(signal?.coin || signal?.symbol);
    const entry = finite(signal?.entryPrice);
    const stop = finite(signal?.stopLoss);
    const target = finite(signal?.takeProfit);
    const score = finite(signal?.executionScore ?? signal?.calibratedScore);
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const size = finite(signal?.positionSize);
    const rawRiskReward = entry > 0 && stop > 0 ? Math.abs(target - entry) / Math.abs(entry - stop) : 0;
    const netRiskReward = this.calculateNetRiskReward({ entry, stop, target, notional: plannedNotional, size });

    if (!['BUY', 'SELL'].includes(action)) reasons.push('Action must be BUY or SELL.');
    if (!coin) reasons.push('Missing normalized coin symbol.');
    if (!(entry > 0 && stop > 0 && target > 0)) reasons.push('Entry, stop-loss and take-profit must be positive.');
    if (score < config.risk.minExecutionScore) reasons.push(`Execution score ${score.toFixed(1)} < ${config.risk.minExecutionScore}.`);
    if (rawRiskReward < config.risk.minRiskReward) reasons.push(`Raw risk/reward ${rawRiskReward.toFixed(2)} < ${config.risk.minRiskReward.toFixed(2)}.`);
    if (netRiskReward < config.risk.minNetRiskReward) reasons.push(`Estimated net risk/reward ${netRiskReward.toFixed(2)} < ${config.risk.minNetRiskReward.toFixed(2)} after costs.`);
    if (leverage < 1 || leverage > config.risk.maxLeverage || !config.risk.allowedLeverages.includes(Number(leverage))) {
      reasons.push(`Leverage ${leverage}x is outside allowed tiers: ${config.risk.allowedLeverages.join(', ')}x.`);
    }

    if (entry > 0 && stop > 0) {
      const stopPct = Math.abs(entry - stop) / entry * 100;
      if (stopPct < config.risk.minStopDistancePct) reasons.push(`Stop distance ${stopPct.toFixed(3)}% is too tight.`);
      if (stopPct > config.risk.maxStopDistancePct) reasons.push(`Stop distance ${stopPct.toFixed(3)}% is too wide.`);
      if (action === 'BUY' && stop >= entry) reasons.push('BUY stop-loss must be below entry.');
      if (action === 'BUY' && target <= entry) reasons.push('BUY take-profit must be above entry.');
      if (action === 'SELL' && stop <= entry) reasons.push('SELL stop-loss must be above entry.');
      if (action === 'SELL' && target >= entry) reasons.push('SELL take-profit must be below entry.');
    }

    const signalTimestamp = finite(signal?.signalTimestamp ?? signal?.timestamp ?? signal?.generatedAt, now);
    const ageMs = Math.max(0, now - signalTimestamp);
    if (ageMs > config.bybit.signalMaxAgeMs) reasons.push(`Signal is stale (${Math.round(ageMs / 1000)}s old).`);

    const last = finite(ticker?.last ?? ticker?.mark);
    const bid = finite(ticker?.bid);
    const ask = finite(ticker?.ask);
    const spreadPct = bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : 0;
    const entryDriftPct = last > 0 && entry > 0 ? Math.abs(last - entry) / entry * 100 : 0;
    if (spreadPct > config.bybit.maxSpreadPct) reasons.push(`Spread ${spreadPct.toFixed(3)}% > ${config.bybit.maxSpreadPct}%.`);
    if (entryDriftPct > config.bybit.maxEntryDriftPct) reasons.push(`Entry drift ${entryDriftPct.toFixed(3)}% > ${config.bybit.maxEntryDriftPct}%.`);
    if (!(last > 0)) {
      const message = 'Fresh ticker price was unavailable during execution preflight.';
      if (config.app.executionMode === 'live') reasons.push(message);
      else warnings.push(message);
    }
    if (config.app.executionMode === 'live' && (!(bid > 0) || !(ask > 0))) {
      reasons.push('Fresh bid/ask quotes were unavailable during execution preflight.');
    }

    const ensemble = signal?.ensemble;
    const claude = ensemble?.claude;
    const deepseek = ensemble?.deepseek;
    const ensembleComplete = Boolean(claude?.action && deepseek?.action && !claude?.error && !deepseek?.error);
    const ensembleAgreement = ensembleComplete && String(claude.action).toUpperCase() === action && String(deepseek.action).toUpperCase() === action;
    if (config.ai.provider === 'ensemble' && config.ai.requireCompleteEnsemble && !ensembleComplete) reasons.push('Complete Claude + DeepSeek review is required.');
    if (config.ai.provider === 'ensemble' && config.ai.requireDirectionAgreement && !ensembleAgreement) reasons.push('Claude and DeepSeek must agree with the final direction.');

    if (config.app.executionMode === 'live' && config.calibration.requireForLive) {
      const samples = finite(signal?.calibration?.samples ?? signal?.calibrationSamples);
      if (samples < config.calibration.minimumLiveSamples) {
        reasons.push(`Live execution needs ${config.calibration.minimumLiveSamples} calibration samples; only ${samples} available.`);
      }
    }

    if (positions.some(position => sameCoin(position.symbol || position.coin, coin))) reasons.push(`A ${coin} position already exists on Bybit.`);

    const totalExposure = positions.reduce((sum, position) => {
      const notional = finite(position.notional, Math.abs(finite(position.size) * finite(position.markPrice || position.entryPrice)));
      return sum + Math.abs(notional);
    }, 0);
    const symbolExposure = positions
      .filter(position => sameCoin(position.symbol || position.coin, coin))
      .reduce((sum, position) => sum + Math.abs(finite(position.notional, finite(position.size) * finite(position.markPrice || position.entryPrice))), 0);

    if (equity > 0) {
      const portfolioPct = (totalExposure + plannedNotional) / equity * 100;
      const symbolPct = (symbolExposure + plannedNotional) / equity * 100;
      const marginPct = plannedMargin / equity * 100;
      if (portfolioPct > config.risk.maxPortfolioExposurePct) reasons.push(`Portfolio exposure ${portfolioPct.toFixed(1)}% exceeds ${config.risk.maxPortfolioExposurePct}%.`);
      if (symbolPct > config.risk.maxSymbolExposurePct) reasons.push(`Symbol exposure ${symbolPct.toFixed(1)}% exceeds ${config.risk.maxSymbolExposurePct}%.`);
      if (marginPct > config.risk.maxMarginPerTradePct) reasons.push(`Trade margin ${marginPct.toFixed(1)}% exceeds ${config.risk.maxMarginPerTradePct}%.`);
    }

    return {
      passed: reasons.length === 0,
      reasons,
      warnings,
      coin,
      score,
      rawRiskReward,
      netRiskReward,
      signalAgeMs: ageMs,
      spreadPct,
      entryDriftPct,
      ensembleComplete,
      ensembleAgreement
    };
  }
}

module.exports = new ExecutionGuard();
