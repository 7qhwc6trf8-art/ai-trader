'use strict';

const { config } = require('./core/config');

const ACTIONS = new Set(['BUY', 'SELL', 'HOLD']);
const SENTIMENTS = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
const CONDITIONS = new Set(['TRENDING', 'RANGING', 'VOLATILE']);

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class AIValidator {
  constructor() {
    this.allowedLeverages = [...config.risk.allowedLeverages];
  }

  normalizeLeverage(value) {
    const numeric = Math.trunc(finite(value, 0));
    return this.allowedLeverages.includes(numeric) ? numeric : 0;
  }

  validate(response) {
    const errors = [];
    const warnings = [];
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return { valid: false, errors: ['AI response is not an object'], warnings, sanitized: this.getDefaultResponse() };
    }

    const action = String(response.action || '').toUpperCase();
    const confidence = finite(response.confidence);
    if (!ACTIONS.has(action)) errors.push('action must be BUY, SELL or HOLD');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) errors.push('confidence must be between 0 and 100');

    const sanitized = {
      sentiment: SENTIMENTS.has(String(response.sentiment || '').toUpperCase())
        ? String(response.sentiment).toUpperCase()
        : 'NEUTRAL',
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0,
      action: ACTIONS.has(action) ? action : 'HOLD',
      entryPrice: finite(response.entryPrice, 0),
      stopLoss: finite(response.stopLoss, 0),
      takeProfit: finite(response.takeProfit, 0),
      positionSizePercent: Math.max(0, Math.min(100, finite(response.positionSizePercent, 0))),
      riskReward: Math.max(0, finite(response.riskReward, 0)),
      marketCondition: CONDITIONS.has(String(response.marketCondition || '').toUpperCase())
        ? String(response.marketCondition).toUpperCase()
        : 'RANGING',
      signals: Array.isArray(response.signals) ? response.signals.map(String).slice(0, 20) : [],
      warnings: Array.isArray(response.warnings) ? response.warnings.map(String).slice(0, 20) : [],
      approveLeverage: response.approveLeverage === true,
      recommendedLeverage: this.normalizeLeverage(response.recommendedLeverage ?? response.approvedLeverage ?? response.leverage),
      approvedLeverage: this.normalizeLeverage(response.approvedLeverage ?? response.recommendedLeverage ?? response.leverage),
      leverageApproval: String(response.leverageApproval || '').toUpperCase(),
      leverageReason: String(response.leverageReason || '').trim(),
      tpEtaMinutes: Math.max(0, finite(response.tpEtaMinutes, 0)),
      forecastBias: SENTIMENTS.has(String(response.forecastBias || '').toUpperCase())
        ? String(response.forecastBias).toUpperCase()
        : 'NEUTRAL',
      reasoning: String(response.reasoning || '').trim(),
      source: response.source,
      ensemble: response.ensemble || null
    };

    if (!sanitized.reasoning) errors.push('reasoning is required');

    if (sanitized.action === 'HOLD') {
      sanitized.entryPrice = 0;
      sanitized.stopLoss = 0;
      sanitized.takeProfit = 0;
      sanitized.positionSizePercent = 0;
      sanitized.approveLeverage = false;
      sanitized.recommendedLeverage = 0;
      sanitized.approvedLeverage = 0;
      sanitized.leverageApproval = 'REJECTED';
      if (!sanitized.leverageReason) sanitized.leverageReason = 'HOLD has no leverage.';
    } else {
      if (!(sanitized.entryPrice > 0)) errors.push('BUY/SELL requires entryPrice > 0');
      if (!(sanitized.stopLoss > 0)) errors.push('BUY/SELL requires stopLoss > 0');
      if (!(sanitized.takeProfit > 0)) errors.push('BUY/SELL requires takeProfit > 0');
      if (sanitized.action === 'BUY') {
        if (!(sanitized.stopLoss < sanitized.entryPrice)) errors.push('BUY stopLoss must be below entryPrice');
        if (!(sanitized.takeProfit > sanitized.entryPrice)) errors.push('BUY takeProfit must be above entryPrice');
      } else {
        if (!(sanitized.stopLoss > sanitized.entryPrice)) errors.push('SELL stopLoss must be above entryPrice');
        if (!(sanitized.takeProfit < sanitized.entryPrice)) errors.push('SELL takeProfit must be below entryPrice');
      }

      const actualRisk = Math.abs(sanitized.entryPrice - sanitized.stopLoss);
      const actualReward = Math.abs(sanitized.takeProfit - sanitized.entryPrice);
      const actualRR = actualRisk > 0 ? actualReward / actualRisk : 0;
      sanitized.riskReward = actualRR;
      if (!(actualRR > 0)) errors.push('risk/reward cannot be calculated');

      if (!sanitized.approveLeverage) errors.push('BUY/SELL requires approveLeverage=true');
      if (sanitized.leverageApproval !== 'APPROVED') errors.push('BUY/SELL requires leverageApproval=APPROVED');
      if (!this.allowedLeverages.includes(sanitized.recommendedLeverage)) errors.push('recommendedLeverage is not an allowed tier');
      if (sanitized.approvedLeverage !== sanitized.recommendedLeverage) errors.push('approvedLeverage must equal recommendedLeverage');
      if (!sanitized.leverageReason) errors.push('leverageReason is required');
    }

    if (errors.length) {
      return {
        valid: false,
        errors,
        warnings,
        sanitized: {
          ...this.getDefaultResponse(),
          reasoning: `Rejected invalid AI response: ${errors.join('; ')}`,
          warnings: [...sanitized.warnings, ...errors]
        }
      };
    }

    return { valid: true, errors, warnings, sanitized };
  }

  sanitize(response) {
    return this.validate(response).sanitized;
  }

  getDefaultResponse() {
    return {
      sentiment: 'NEUTRAL', confidence: 0, action: 'HOLD', entryPrice: 0,
      stopLoss: 0, takeProfit: 0, positionSizePercent: 0, riskReward: 0,
      marketCondition: 'RANGING', signals: [], warnings: ['AI response rejected'],
      approveLeverage: false, recommendedLeverage: 0, approvedLeverage: 0,
      leverageApproval: 'REJECTED', leverageReason: 'Invalid AI response; leverage denied.',
      tpEtaMinutes: 0, forecastBias: 'NEUTRAL', reasoning: 'No valid AI response.',
      ensemble: null
    };
  }

  validateTradeParams(params) {
    const result = this.validate({
      ...params,
      confidence: params.confidence ?? 0,
      sentiment: params.sentiment || (params.action === 'BUY' ? 'BULLISH' : 'BEARISH'),
      marketCondition: params.marketCondition || 'RANGING',
      reasoning: params.reasoning || 'Validated execution plan',
      approveLeverage: true,
      recommendedLeverage: params.leverage,
      approvedLeverage: params.leverage,
      leverageApproval: 'APPROVED',
      leverageReason: params.leverageReason || 'Validated tier'
    });
    const errors = [...result.errors];
    if (!(finite(params.size, 0) > 0)) errors.push('size must be > 0');
    return { valid: errors.length === 0, errors };
  }

  isConfidenceHighEnough(confidence, threshold = 55) {
    return finite(confidence, 0) >= threshold;
  }

  isRiskRewardGoodEnough(riskReward, threshold = config.risk.minRiskReward) {
    return finite(riskReward, 0) >= threshold;
  }
}

module.exports = new AIValidator();
