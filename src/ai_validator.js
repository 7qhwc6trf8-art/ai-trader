'use strict';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value, min)));
}

function upper(value, fallback = '') {
  const text = String(value ?? fallback).trim().toUpperCase();
  return text || fallback;
}

function uniqueStrings(values, max = 12) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].slice(0, max);
}

class AIValidator {
  constructor() {
    this.allowedActions = ['BUY', 'SELL', 'HOLD'];
    this.allowedSentiments = ['BULLISH', 'BEARISH', 'NEUTRAL'];
    this.allowedConditions = ['TRENDING', 'RANGING', 'VOLATILE'];
    this.allowedLeverages = [4, 5, 10, 100];
  }

  normalizeLeverage(value) {
    const numeric = Math.floor(finite(value));
    if (this.allowedLeverages.includes(numeric)) return numeric;
    const below = this.allowedLeverages.filter(item => item <= numeric);
    return below.length ? below[below.length - 1] : 4;
  }

  calculateRiskReward(action, entryPrice, stopLoss, takeProfit) {
    if (!['BUY', 'SELL'].includes(action)) return 0;
    const risk = Math.abs(finite(entryPrice) - finite(stopLoss));
    const reward = Math.abs(finite(takeProfit) - finite(entryPrice));
    return risk > 0 ? reward / risk : 0;
  }

  validate(response, context = {}) {
    const errors = [];
    const warnings = [];
    const strictPrices = context.strictPrices === true;

    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      errors.push('AI response is null, non-object, or an array');
      return { valid: false, errors, warnings, sanitized: this.getDefaultResponse() };
    }

    const sanitized = { ...response };
    sanitized.action = upper(sanitized.action, 'HOLD');
    if (!this.allowedActions.includes(sanitized.action)) {
      errors.push(`Unsupported action: ${sanitized.action}`);
      sanitized.action = 'HOLD';
    }

    sanitized.sentiment = upper(sanitized.sentiment, sanitized.action === 'BUY' ? 'BULLISH' : sanitized.action === 'SELL' ? 'BEARISH' : 'NEUTRAL');
    if (!this.allowedSentiments.includes(sanitized.sentiment)) {
      warnings.push('Invalid sentiment was normalized to NEUTRAL');
      sanitized.sentiment = 'NEUTRAL';
    }

    sanitized.marketCondition = upper(sanitized.marketCondition, 'RANGING');
    if (!this.allowedConditions.includes(sanitized.marketCondition)) {
      warnings.push('Invalid market condition was normalized to RANGING');
      sanitized.marketCondition = 'RANGING';
    }

    sanitized.forecastBias = upper(sanitized.forecastBias, 'NEUTRAL');
    if (!this.allowedSentiments.includes(sanitized.forecastBias)) sanitized.forecastBias = 'NEUTRAL';

    sanitized.confidence = clamp(sanitized.confidence, 0, 100);
    sanitized.positionSizePercent = clamp(sanitized.positionSizePercent, 0, 100);
    sanitized.tpEtaMinutes = Math.max(0, finite(sanitized.tpEtaMinutes));
    sanitized.signals = uniqueStrings(sanitized.signals);
    sanitized.warnings = uniqueStrings([...(sanitized.warnings || []), ...warnings]);
    sanitized.evidenceFor = uniqueStrings(sanitized.evidenceFor, 8);
    sanitized.evidenceAgainst = uniqueStrings(sanitized.evidenceAgainst, 8);
    sanitized.reasoning = String(sanitized.reasoning || 'No reasoning summary was provided.').trim().slice(0, 2500);
    sanitized.invalidation = String(sanitized.invalidation || '').trim().slice(0, 500);
    sanitized.scenario = String(sanitized.scenario || '').trim().slice(0, 800);

    if (sanitized.action === 'HOLD') {
      sanitized.entryPrice = 0;
      sanitized.stopLoss = 0;
      sanitized.takeProfit = 0;
      sanitized.positionSizePercent = 0;
      sanitized.riskReward = 0;
      sanitized.approveLeverage = false;
      sanitized.recommendedLeverage = 0;
      sanitized.approvedLeverage = 0;
      sanitized.leverageApproval = 'REJECTED';
      sanitized.leverageReason = String(sanitized.leverageReason || 'No leverage is permitted for HOLD.').slice(0, 500);
      return { valid: errors.length === 0, errors, warnings: sanitized.warnings, sanitized };
    }

    const contextPrice = finite(context.marketPrice ?? context.price);
    sanitized.entryPrice = Math.max(0, finite(sanitized.entryPrice, contextPrice));
    sanitized.stopLoss = Math.max(0, finite(sanitized.stopLoss));
    sanitized.takeProfit = Math.max(0, finite(sanitized.takeProfit));

    if (sanitized.entryPrice <= 0) {
      (strictPrices ? errors : warnings).push('BUY/SELL requires a positive entryPrice');
    }

    if (sanitized.action === 'BUY') {
      if (sanitized.stopLoss <= 0 || sanitized.stopLoss >= sanitized.entryPrice) {
        (strictPrices ? errors : warnings).push('BUY stopLoss must be below entryPrice');
      }
      if (sanitized.takeProfit <= sanitized.entryPrice) {
        (strictPrices ? errors : warnings).push('BUY takeProfit must be above entryPrice');
      }
      if (sanitized.sentiment === 'BEARISH') warnings.push('BUY action conflicts with BEARISH sentiment');
    }

    if (sanitized.action === 'SELL') {
      if (sanitized.stopLoss <= sanitized.entryPrice) {
        (strictPrices ? errors : warnings).push('SELL stopLoss must be above entryPrice');
      }
      if (sanitized.takeProfit <= 0 || sanitized.takeProfit >= sanitized.entryPrice) {
        (strictPrices ? errors : warnings).push('SELL takeProfit must be below entryPrice');
      }
      if (sanitized.sentiment === 'BULLISH') warnings.push('SELL action conflicts with BULLISH sentiment');
    }

    sanitized.riskReward = this.calculateRiskReward(
      sanitized.action,
      sanitized.entryPrice,
      sanitized.stopLoss,
      sanitized.takeProfit
    );

    if (!Number.isFinite(sanitized.riskReward) || sanitized.riskReward <= 0) {
      (strictPrices ? errors : warnings).push('Risk/reward could not be calculated from entry, stop and target');
      sanitized.riskReward = 0;
    }

    const requestedRaw = sanitized.recommendedLeverage ?? sanitized.approvedLeverage ?? sanitized.leverage;
    const explicitApproval = sanitized.approveLeverage === true || upper(sanitized.leverageApproval) === 'APPROVED';

    if (!explicitApproval) {
      sanitized.approveLeverage = false;
      sanitized.recommendedLeverage = 0;
      sanitized.approvedLeverage = 0;
      sanitized.leverageApproval = 'REJECTED';
      sanitized.leverageReason = String(sanitized.leverageReason || 'AI did not explicitly approve leverage.').slice(0, 500);
      warnings.push('Directional signal has no explicit leverage approval');
    } else {
      sanitized.recommendedLeverage = this.normalizeLeverage(requestedRaw);
      sanitized.approvedLeverage = sanitized.recommendedLeverage;
      sanitized.approveLeverage = true;
      sanitized.leverageApproval = 'APPROVED';
      sanitized.leverageReason = String(sanitized.leverageReason || `${sanitized.recommendedLeverage}x selected by AI.`).slice(0, 500);
    }

    sanitized.warnings = uniqueStrings([...(sanitized.warnings || []), ...warnings]);
    return { valid: errors.length === 0, errors, warnings: sanitized.warnings, sanitized };
  }

  sanitize(response, context = {}) {
    return this.validate(response, context).sanitized;
  }

  getDefaultResponse(reason = 'AI response invalid - default HOLD') {
    return {
      sentiment: 'NEUTRAL',
      confidence: 0,
      action: 'HOLD',
      entryPrice: 0,
      stopLoss: 0,
      takeProfit: 0,
      positionSizePercent: 0,
      riskReward: 0,
      marketCondition: 'RANGING',
      signals: [],
      warnings: [reason],
      evidenceFor: [],
      evidenceAgainst: [],
      invalidation: '',
      scenario: '',
      approveLeverage: false,
      recommendedLeverage: 0,
      approvedLeverage: 0,
      leverageApproval: 'REJECTED',
      leverageReason: 'AI response invalid; leverage denied.',
      tpEtaMinutes: 0,
      forecastBias: 'NEUTRAL',
      reasoning: reason
    };
  }

  validateTradeParams(params) {
    const errors = [];
    const action = upper(params?.action);
    if (!params?.coin) errors.push('Missing coin');
    if (!['BUY', 'SELL'].includes(action)) errors.push('Action must be BUY or SELL');
    if (finite(params?.entryPrice) <= 0) errors.push('Invalid entryPrice');
    if (finite(params?.stopLoss) <= 0) errors.push('Invalid stopLoss');
    if (finite(params?.takeProfit) <= 0) errors.push('Invalid takeProfit');
    if (finite(params?.size) <= 0) errors.push('Invalid size');
    if (!this.allowedLeverages.includes(Number(params?.leverage))) errors.push('Invalid AI leverage tier');

    if (action === 'BUY') {
      if (finite(params.stopLoss) >= finite(params.entryPrice)) errors.push('Stop loss must be below entry for BUY');
      if (finite(params.takeProfit) <= finite(params.entryPrice)) errors.push('Take profit must be above entry for BUY');
    }
    if (action === 'SELL') {
      if (finite(params.stopLoss) <= finite(params.entryPrice)) errors.push('Stop loss must be above entry for SELL');
      if (finite(params.takeProfit) >= finite(params.entryPrice)) errors.push('Take profit must be below entry for SELL');
    }

    return { valid: errors.length === 0, errors };
  }

  isConfidenceHighEnough(confidence, threshold = 55) {
    return finite(confidence) >= finite(threshold, 55);
  }

  isRiskRewardGoodEnough(riskReward, threshold = 1.15) {
    return finite(riskReward) >= finite(threshold, 1.15);
  }
}

module.exports = new AIValidator();
module.exports.AIValidator = AIValidator;
