'use strict';

class AIValidator {
  constructor() {
    this.allowedActions = ['BUY', 'SELL', 'HOLD'];
    this.allowedSentiments = ['BULLISH', 'BEARISH', 'NEUTRAL'];
    this.allowedConditions = ['TRENDING', 'RANGING', 'VOLATILE'];
    this.allowedLeverages = String(process.env.AI_LEVERAGE_OPTIONS || '1,2,3,5')
      .split(',').map(Number).filter(v => Number.isFinite(v) && v >= 1 && v <= 5);
  }

  normalizeLeverage(value, confidence = 0) {
    const numeric = Math.floor(Number(value) || 0);
    if (this.allowedLeverages.includes(numeric)) return numeric;
    if (confidence >= 85 && this.allowedLeverages.includes(5)) return 5;
    if (confidence >= 75 && this.allowedLeverages.includes(3)) return 3;
    if (confidence >= 65 && this.allowedLeverages.includes(2)) return 2;
    return this.allowedLeverages[0] || 1;
  }

  validate(response) {
    const errors = [];
    const warnings = [];

    if (!response || typeof response !== 'object') {
      errors.push('AI response is null or invalid');
      return { valid: false, errors, warnings, sanitized: this.getDefaultResponse() };
    }

    const sanitized = { ...response };
    sanitized.action = String(sanitized.action || 'HOLD').toUpperCase();
    if (!this.allowedActions.includes(sanitized.action)) {
      sanitized.action = 'HOLD';
      warnings.push('Invalid action - defaulted to HOLD');
    }

    sanitized.confidence = Math.max(0, Math.min(100, Number(sanitized.confidence) || 0));
    sanitized.sentiment = String(sanitized.sentiment || 'NEUTRAL').toUpperCase();
    if (!this.allowedSentiments.includes(sanitized.sentiment)) sanitized.sentiment = 'NEUTRAL';
    sanitized.marketCondition = String(sanitized.marketCondition || 'RANGING').toUpperCase();
    if (!this.allowedConditions.includes(sanitized.marketCondition)) sanitized.marketCondition = 'RANGING';

    sanitized.signals = Array.isArray(sanitized.signals) ? sanitized.signals : [];
    sanitized.warnings = Array.isArray(sanitized.warnings) ? sanitized.warnings : [];
    sanitized.reasoning = sanitized.reasoning || 'No reasoning provided';
    sanitized.riskReward = Math.max(0, Number(sanitized.riskReward) || 0);
    sanitized.tpEtaMinutes = Math.max(0, Number(sanitized.tpEtaMinutes) || 0);
    sanitized.forecastBias = String(sanitized.forecastBias || 'NEUTRAL').toUpperCase();
    if (!this.allowedSentiments.includes(sanitized.forecastBias)) sanitized.forecastBias = 'NEUTRAL';

    if (sanitized.action === 'HOLD') {
      sanitized.entryPrice = 0;
      sanitized.stopLoss = 0;
      sanitized.takeProfit = 0;
      sanitized.positionSizePercent = 0;
      sanitized.approveLeverage = false;
      sanitized.recommendedLeverage = 0;
      sanitized.approvedLeverage = 0;
      sanitized.leverageApproval = 'REJECTED';
      sanitized.leverageReason = sanitized.leverageReason || 'No leverage for HOLD.';
    } else {
      sanitized.entryPrice = Math.max(0, Number(sanitized.entryPrice) || 0);
      sanitized.stopLoss = Math.max(0, Number(sanitized.stopLoss) || 0);
      sanitized.takeProfit = Math.max(0, Number(sanitized.takeProfit) || 0);
      sanitized.positionSizePercent = Math.max(0, Math.min(100, Number(sanitized.positionSizePercent) || 0));

      const requested = sanitized.recommendedLeverage ?? sanitized.approvedLeverage ?? sanitized.leverage;
      sanitized.recommendedLeverage = this.normalizeLeverage(requested, sanitized.confidence);
      sanitized.approvedLeverage = sanitized.recommendedLeverage;
      sanitized.approveLeverage = String(sanitized.leverageApproval || 'APPROVED').toUpperCase() !== 'REJECTED';
      sanitized.leverageApproval = sanitized.approveLeverage ? 'APPROVED' : 'REJECTED';
      sanitized.leverageReason = sanitized.leverageReason || `${sanitized.recommendedLeverage}x selected by AI.`;

      if (sanitized.action === 'BUY') {
        if (!sanitized.stopLoss || sanitized.stopLoss >= sanitized.entryPrice) sanitized.stopLoss = sanitized.entryPrice * 0.97;
        if (!sanitized.takeProfit || sanitized.takeProfit <= sanitized.entryPrice) sanitized.takeProfit = sanitized.entryPrice * 1.05;
      } else {
        if (!sanitized.stopLoss || sanitized.stopLoss <= sanitized.entryPrice) sanitized.stopLoss = sanitized.entryPrice * 1.03;
        if (!sanitized.takeProfit || sanitized.takeProfit >= sanitized.entryPrice) sanitized.takeProfit = sanitized.entryPrice * 0.95;
      }
    }

    return { valid: errors.length === 0, errors, warnings, sanitized };
  }

  sanitize(response) {
    return this.validate(response).sanitized;
  }

  getDefaultResponse() {
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
      warnings: ['AI response invalid - default used'],
      approveLeverage: false,
      recommendedLeverage: 0,
      approvedLeverage: 0,
      leverageApproval: 'REJECTED',
      leverageReason: 'AI response invalid; leverage denied.',
      tpEtaMinutes: 0,
      forecastBias: 'NEUTRAL',
      reasoning: 'No valid AI response - default HOLD'
    };
  }

  validateTradeParams(params) {
    const errors = [];
    if (!params.coin) errors.push('Missing coin');
    if (!params.action) errors.push('Missing action');
    if (!params.entryPrice || params.entryPrice <= 0) errors.push('Invalid entryPrice');
    if (!params.stopLoss || params.stopLoss <= 0) errors.push('Invalid stopLoss');
    if (!params.takeProfit || params.takeProfit <= 0) errors.push('Invalid takeProfit');
    if (!params.size || params.size <= 0) errors.push('Invalid size');
    if (!this.allowedLeverages.includes(Number(params.leverage))) errors.push('Invalid AI leverage tier');

    if (params.action === 'BUY') {
      if (params.stopLoss >= params.entryPrice) errors.push('Stop loss must be below entry for BUY');
      if (params.takeProfit <= params.entryPrice) errors.push('Take profit must be above entry for BUY');
    }
    if (params.action === 'SELL') {
      if (params.stopLoss <= params.entryPrice) errors.push('Stop loss must be above entry for SELL');
      if (params.takeProfit >= params.entryPrice) errors.push('Take profit must be below entry for SELL');
    }

    return { valid: errors.length === 0, errors };
  }

  isConfidenceHighEnough(confidence, threshold = 55) {
    return Number(confidence) >= threshold;
  }

  isRiskRewardGoodEnough(riskReward, threshold = 1.15) {
    return Number(riskReward) >= threshold;
  }
}

module.exports = new AIValidator();

