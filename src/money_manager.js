'use strict';

const { config, finite, bool } = require('./core/config');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class MoneyManager {
  constructor() {
    this.allowedLeverages = [...config.risk.allowedLeverages];
    this.maxConfiguredLeverage = config.risk.maxLeverage;
    this.requireAIApproval = bool(process.env.REQUIRE_AI_LEVERAGE_APPROVAL, true);
    this.allowDowngrade = bool(process.env.ALLOW_AI_LEVERAGE_DOWNGRADE, true);
    this.baseRiskFraction = config.risk.riskPerTradePct / 100;
    this.maxRiskFraction = config.risk.maxRiskPerTradePct / 100;
    this.maxMarginFraction = config.risk.maxMarginPerTradePct / 100;
    this.feeRate = config.costs.takerFeeRate;

    this.tiers = {
      1: this.makeTier(1, 58, 1.35, 1, 12, 0.20, 6.0),
      2: this.makeTier(2, 66, 1.45, 1, 18, 0.25, 5.0),
      3: this.makeTier(3, 73, 1.60, 2, 24, 0.30, 4.0),
      5: this.makeTier(5, 82, 1.85, 3, 32, 0.35, 3.0)
    };
  }

  makeTier(leverage, minScore, minRiskReward, minAlignedTimeframes, minTpProbability, minStopDistancePct, maxStopDistancePct) {
    return {
      leverage,
      minScore: finite(process.env[`MIN_${leverage}X_EXECUTION_SCORE`], minScore),
      minRiskReward: finite(process.env[`MIN_${leverage}X_RISK_REWARD`], minRiskReward),
      minAlignedTimeframes: Math.max(0, Math.trunc(finite(process.env[`MIN_${leverage}X_ALIGNED_TIMEFRAMES`], minAlignedTimeframes))),
      minTpProbability: finite(process.env[`MIN_${leverage}X_TP_PROBABILITY_PCT`], minTpProbability),
      minStopDistancePct: finite(process.env[`MIN_${leverage}X_STOP_DISTANCE_PCT`], minStopDistancePct),
      maxStopDistancePct: finite(process.env[`MAX_${leverage}X_STOP_DISTANCE_PCT`], maxStopDistancePct)
    };
  }

  parseLeverageOptions() {
    return [...this.allowedLeverages];
  }

  normalizeLeverage(value, fallback = 1) {
    const numeric = Math.floor(finite(value, fallback));
    if (this.allowedLeverages.includes(numeric)) return numeric;
    const below = this.allowedLeverages.filter(option => option <= numeric);
    return below.length ? below.at(-1) : this.allowedLeverages[0];
  }

  inferAILeverage(aiAnalysis = {}) {
    const explicit = finite(aiAnalysis.recommendedLeverage ?? aiAnalysis.approvedLeverage ?? aiAnalysis.leverage, 0);
    if (explicit > 0) return this.normalizeLeverage(explicit);
    const score = finite(aiAnalysis.executionScore ?? aiAnalysis.calibratedScore ?? aiAnalysis.confidence);
    if (score >= 84 && this.allowedLeverages.includes(5)) return 5;
    if (score >= 76 && this.allowedLeverages.includes(3)) return 3;
    if (score >= 68 && this.allowedLeverages.includes(2)) return 2;
    return this.allowedLeverages[0];
  }

  countAlignedTimeframes(action, multiTF = {}) {
    const expected = action === 'BUY' ? 'BULLISH' : 'BEARISH';
    return Object.values(multiTF).filter(value => String(value).toUpperCase() === expected).length;
  }

  tierFor(leverage) {
    return this.tiers[this.normalizeLeverage(leverage)] || this.tiers[1];
  }

  evaluateTier(leverage, metrics) {
    const tier = this.tierFor(leverage);
    const reasons = [];
    if (metrics.executionScore < tier.minScore) reasons.push(`execution score ${metrics.executionScore.toFixed(1)} < ${tier.minScore}`);
    if (metrics.riskReward < tier.minRiskReward) reasons.push(`risk/reward ${metrics.riskReward.toFixed(2)} < ${tier.minRiskReward.toFixed(2)}`);
    if (!Number.isFinite(metrics.stopDistancePct) || metrics.stopDistancePct < tier.minStopDistancePct) reasons.push(`stop distance below ${tier.minStopDistancePct.toFixed(2)}%`);
    if (metrics.stopDistancePct > tier.maxStopDistancePct) reasons.push(`stop distance ${metrics.stopDistancePct.toFixed(2)}% > ${tier.maxStopDistancePct.toFixed(2)}%`);
    if (metrics.alignedTimeframes < tier.minAlignedTimeframes) reasons.push(`only ${metrics.alignedTimeframes} aligned timeframe(s); ${tier.minAlignedTimeframes} required`);
    if (metrics.tpProbability < tier.minTpProbability) reasons.push(`TP probability ${metrics.tpProbability.toFixed(1)}% < ${tier.minTpProbability.toFixed(1)}%`);
    if (metrics.forecastConflicts && leverage >= 3) reasons.push(`forecast conflicts with ${metrics.action}`);
    if (config.ai.requireCompleteEnsemble && !metrics.completeEnsemble) reasons.push('complete Claude + DeepSeek ensemble is required');
    if (config.ai.requireDirectionAgreement && !metrics.ensembleAgreement) reasons.push('Claude and DeepSeek direction agreement is required');
    if (metrics.volatilityLevel === 'HIGH' && leverage >= 5) reasons.push('5x is disabled in HIGH volatility');
    if (metrics.liquidity === 'LOW' && leverage >= 3) reasons.push(`${leverage}x is disabled in LOW liquidity`);
    return { passed: reasons.length === 0, reasons, tier };
  }

  evaluateLeverage(aiAnalysis, context = {}) {
    const action = String(context.action || aiAnalysis.action || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) return { approved: false, leverage: 0, requestedLeverage: 0, reason: 'No leverage for HOLD.' };

    const requestedLeverage = this.inferAILeverage(aiAnalysis);
    const explicitApproval = aiAnalysis.approveLeverage === true ||
      String(aiAnalysis.leverageApproval || '').toUpperCase() === 'APPROVED' ||
      finite(aiAnalysis.recommendedLeverage ?? aiAnalysis.approvedLeverage) > 0;
    if (this.requireAIApproval && !explicitApproval) {
      return { approved: false, leverage: 0, requestedLeverage, explicitAIApproval: false, reason: 'Final AI did not approve an allowed leverage tier.' };
    }

    const entry = finite(context.entryPrice ?? aiAnalysis.entryPrice);
    const stop = finite(context.stopLoss ?? aiAnalysis.stopLoss);
    const executionScore = finite(context.executionScore ?? aiAnalysis.executionScore ?? aiAnalysis.calibratedScore ?? aiAnalysis.confidence);
    const riskReward = finite(context.riskReward ?? aiAnalysis.riskReward);
    const stopDistancePct = entry > 0 ? Math.abs(entry - stop) / entry * 100 : Infinity;
    const alignedTimeframes = this.countAlignedTimeframes(action, context.multiTF);
    const tpProbability = finite(context.tpProbability);
    const forecastDirection = String(context.forecastDirection || 'NEUTRAL').toUpperCase();
    const expectedForecastDirection = action === 'BUY' ? 'BULLISH' : 'BEARISH';
    const forecastConflicts = forecastDirection !== 'NEUTRAL' && forecastDirection !== expectedForecastDirection;
    const volatilityLevel = String(context.volatilityLevel || 'MEDIUM').toUpperCase();
    const liquidity = String(context.liquidity || 'MEDIUM').toUpperCase();
    const ensemble = aiAnalysis.ensemble;
    const claudeAction = String(ensemble?.claude?.action || '').toUpperCase();
    const deepseekAction = String(ensemble?.deepseek?.action || '').toUpperCase();
    const completeEnsemble = Boolean(claudeAction && deepseekAction && !ensemble?.claude?.error && !ensemble?.deepseek?.error);
    const ensembleAgreement = completeEnsemble && claudeAction === action && deepseekAction === action;
    const exchangeMax = clamp(Math.floor(finite(context.marketMaxLeverage, config.risk.maxLeverage)), 1, config.risk.maxLeverage);

    const candidates = this.allowedLeverages
      .filter(value => value <= requestedLeverage && value <= exchangeMax)
      .sort((a, b) => b - a);
    const evaluatedCandidates = this.allowDowngrade ? candidates : candidates.filter(value => value === requestedLeverage);
    const metrics = { action, executionScore, riskReward, stopDistancePct, alignedTimeframes, tpProbability, forecastConflicts, volatilityLevel, liquidity, completeEnsemble, ensembleAgreement };
    const attempts = [];

    for (const leverage of evaluatedCandidates) {
      const result = this.evaluateTier(leverage, metrics);
      attempts.push({ leverage, ...result });
      if (result.passed) {
        return {
          approved: true,
          leverage,
          requestedLeverage,
          downgraded: leverage !== requestedLeverage,
          exchangeMaxLeverage: exchangeMax,
          explicitAIApproval: explicitApproval,
          executionScore,
          riskReward,
          stopDistancePct,
          alignedTimeframes,
          tpProbability,
          ensembleAgreement,
          reason: leverage !== requestedLeverage
            ? `AI requested ${requestedLeverage}x; V16 downgraded it to ${leverage}x.`
            : (aiAnalysis.leverageReason || `${leverage}x passed the V16 hard gate.`),
          attempts
        };
      }
    }

    return {
      approved: false,
      leverage: 0,
      requestedLeverage,
      exchangeMaxLeverage: exchangeMax,
      explicitAIApproval: explicitApproval,
      executionScore,
      attempts,
      reason: attempts[0]?.reasons?.join('; ') || 'No allowed leverage tier passed the V16 hard gate.'
    };
  }


  dynamicRiskFraction(executionScore, volatilityLevel, consecutiveLosses = 0, leverage = 1) {
    let multiplier = executionScore >= 88 ? 1 : executionScore >= 80 ? 0.88 : executionScore >= 72 ? 0.72 : 0.55;
    if (String(volatilityLevel).toUpperCase() === 'HIGH') multiplier *= 0.60;
    else if (String(volatilityLevel).toUpperCase() === 'MEDIUM') multiplier *= 0.85;
    if (leverage >= 5) multiplier *= 0.72;
    else if (leverage >= 3) multiplier *= 0.85;
    multiplier *= Math.max(0.35, 1 - Math.max(0, consecutiveLosses) * 0.25);
    return clamp(this.baseRiskFraction * multiplier, 0.0005, this.maxRiskFraction);
  }

  calculatePosition(params = {}) {
    const balance = Math.max(0, finite(params.balance));
    const entryPrice = finite(params.entryPrice);
    const stopLoss = finite(params.stopLoss);
    const leverage = clamp(Math.floor(finite(params.leverage, 1)), 1, config.risk.maxLeverage);
    const executionScore = finite(params.executionScore ?? params.confidence);
    const configuredRiskFraction = this.dynamicRiskFraction(executionScore, params.volatilityLevel, finite(params.consecutiveLosses), leverage);
    const riskMultiplier = clamp(finite(params.riskMultiplier, 1), 0.05, 1);
    const riskFraction = clamp(configuredRiskFraction * riskMultiplier, 0.0001, this.maxRiskFraction);
    const requestedRiskAmount = balance * riskFraction;
    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    const marketRules = params.marketRules || {};
    const minimumOrderAmount = Math.max(0, finite(marketRules.minimumOrderAmount, finite(params.minimumOrderAmount)));
    const amountStep = Math.max(0, finite(marketRules.amountStep));

    if (!(balance > 0 && entryPrice > 0 && riskPerUnit > 0)) {
      return { executable: false, positionSize: 0, reason: 'Invalid balance, entry price or stop-loss distance.' };
    }

    const roundTripCostRate = config.costs.takerFeeRate * 2 + config.costs.estimatedSlippageRate * 2;
    const feeAdjustedRisk = requestedRiskAmount / Math.max(1, 1 + roundTripCostRate * entryPrice / riskPerUnit);
    const rawPositionSize = feeAdjustedRisk / riskPerUnit;
    const maxByAvailableBalance = balance * leverage * 0.90 / entryPrice;
    const maxByMarginAllocation = balance * leverage * this.maxMarginFraction / entryPrice;
    const maxPositionSize = Math.min(maxByAvailableBalance, maxByMarginAllocation);

    if (minimumOrderAmount > 0 && maxPositionSize < minimumOrderAmount) {
      return {
        executable: false,
        positionSize: 0,
        requestedRiskAmount,
        reason: `Bybit minimum order exceeds the configured ${config.risk.maxMarginPerTradePct}% margin cap.`
      };
    }

    let positionSize = Math.min(rawPositionSize, maxPositionSize);
    if (amountStep > 0) positionSize = Math.floor((positionSize / amountStep) + 1e-12) * amountStep;
    if (minimumOrderAmount > 0 && positionSize < minimumOrderAmount) positionSize = minimumOrderAmount;
    if (!(positionSize > 0) || positionSize > maxPositionSize + Number.EPSILON) {
      return { executable: false, positionSize: 0, reason: 'Calculated size is not executable inside the margin cap.' };
    }

    const notional = positionSize * entryPrice;
    const marginUsed = notional / leverage;
    const stopLossAmount = positionSize * riskPerUnit;
    const estimatedRoundTripCosts = notional * roundTripCostRate;

    return {
      executable: true,
      positionSize,
      rawPositionSize,
      maximumPositionSize: maxPositionSize,
      riskFraction,
      riskPercent: balance > 0 ? stopLossAmount / balance * 100 : 0,
      riskAmount: stopLossAmount,
      requestedRiskAmount,
      stopLossAmount,
      notional,
      marginUsed,
      marginPercent: balance > 0 ? marginUsed / balance * 100 : 0,
      estimatedRoundTripCosts,
      leverage,
      minimumOrderAmount,
      reason: 'V16 stop-based sizing with fee, slippage, leverage and margin caps.'
    };
  }
}

module.exports = new MoneyManager();
