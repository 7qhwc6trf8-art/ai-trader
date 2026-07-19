'use strict';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(String(value).toLowerCase());
}

class MoneyManager {
  constructor() {
    this.allowedLeverages = this.parseLeverageOptions(process.env.AI_LEVERAGE_OPTIONS || '1,2,3,5');
    this.maxConfiguredLeverage = clamp(
      Math.floor(finite(process.env.MAX_AI_LEVERAGE, Math.max(...this.allowedLeverages))),
      1,
      5
    );
    this.allowedLeverages = this.allowedLeverages.filter(value => value <= this.maxConfiguredLeverage);
    if (this.allowedLeverages.length === 0) this.allowedLeverages = [1];

    this.requireAIApproval = truthy(process.env.REQUIRE_AI_LEVERAGE_APPROVAL, true);
    this.allowDowngrade = truthy(process.env.ALLOW_AI_LEVERAGE_DOWNGRADE, true);
    this.allowJudgeResolution = truthy(process.env.ALLOW_JUDGE_RESOLUTION, true);
    this.maxWideStopPct = clamp(finite(process.env.MAX_WIDE_STOP_DISTANCE_PCT, 10), 6, 12);

    this.baseRiskFraction = clamp(finite(process.env.RISK_PER_TRADE_PCT, 0.6) / 100, 0.001, 0.05);
    this.maxRiskFraction = clamp(finite(process.env.MAX_RISK_PER_TRADE_PCT, 0.8) / 100, this.baseRiskFraction, 0.05);
    this.maxMarginFraction = clamp(finite(process.env.MAX_MARGIN_PER_TRADE_PCT, 15) / 100, 0.01, 0.95);
    this.feeRate = clamp(finite(process.env.TRADING_FEE_RATE, 0.001), 0, 0.01);

    this.tiers = {
      1: { minConfidence: 55, minRiskReward: 1.20, minAlignedTimeframes: 1, minTpProbability: 15, minStopDistancePct: 0.25, maxStopDistancePct: this.maxWideStopPct },
      2: { minConfidence: 62, minRiskReward: 1.35, minAlignedTimeframes: 1, minTpProbability: 20, minStopDistancePct: 0.25, maxStopDistancePct: 4.5 },
      3: { minConfidence: 70, minRiskReward: 1.50, minAlignedTimeframes: 2, minTpProbability: 25, minStopDistancePct: 0.30, maxStopDistancePct: 4.0 },
      5: { minConfidence: 80, minRiskReward: 1.80, minAlignedTimeframes: 2, minTpProbability: 35, minStopDistancePct: 0.35, maxStopDistancePct: 3.0 }
    };
  }

  parseLeverageOptions(value) {
    const parsed = String(value || '')
      .split(',')
      .map(item => Math.floor(Number(item.trim())))
      .filter(item => Number.isFinite(item) && item >= 1 && item <= 5);
    return [...new Set(parsed.length ? parsed : [1, 2, 3, 5])].sort((a, b) => a - b);
  }

  normalizeLeverage(value, fallback = 1) {
    const numeric = Math.floor(finite(value, fallback));
    const options = this.allowedLeverages;
    if (options.includes(numeric)) return numeric;
    const below = options.filter(option => option <= numeric);
    return below.length ? below[below.length - 1] : options[0];
  }

  inferAILeverage(aiAnalysis = {}) {
    const explicit = finite(
      aiAnalysis.recommendedLeverage ?? aiAnalysis.approvedLeverage ?? aiAnalysis.leverage,
      0
    );
    if (explicit > 0) return this.normalizeLeverage(explicit);

    const confidence = finite(aiAnalysis.confidence);
    // Never infer extreme leverage from an LLM confidence score.
    if (confidence >= 85 && this.allowedLeverages.includes(5)) return 5;
    if (confidence >= 75 && this.allowedLeverages.includes(3)) return 3;
    if (confidence >= 65 && this.allowedLeverages.includes(2)) return 2;
    return this.allowedLeverages[0];
  }

  countAlignedTimeframes(action, multiTF = {}) {
    const expected = action === 'BUY' ? 'BULLISH' : 'BEARISH';
    return Object.values(multiTF).filter(value => String(value).toUpperCase() === expected).length;
  }

  tierFor(leverage) {
    const normalized = this.normalizeLeverage(leverage, 1);
    return this.tiers[normalized] || this.tiers[1];
  }

  evaluateTier(leverage, metrics) {
    const tier = this.tierFor(leverage);
    const reasons = [];

    if (metrics.confidence < tier.minConfidence) {
      reasons.push(`confidence ${metrics.confidence.toFixed(0)}% < ${tier.minConfidence}%`);
    }
    if (metrics.riskReward < tier.minRiskReward) {
      reasons.push(`risk/reward ${metrics.riskReward.toFixed(2)} < ${tier.minRiskReward.toFixed(2)}`);
    }
    if (!Number.isFinite(metrics.stopDistancePct) || metrics.stopDistancePct < tier.minStopDistancePct) {
      reasons.push(`stop distance below ${tier.minStopDistancePct.toFixed(2)}%`);
    }
    if (metrics.stopDistancePct > tier.maxStopDistancePct) {
      reasons.push(`stop distance ${metrics.stopDistancePct.toFixed(2)}% > ${tier.maxStopDistancePct.toFixed(2)}%`);
    }
    if (metrics.alignedTimeframes < tier.minAlignedTimeframes) {
      reasons.push(`only ${metrics.alignedTimeframes} aligned timeframe(s); ${tier.minAlignedTimeframes} required`);
    }
    if (metrics.tpProbability < tier.minTpProbability) {
      reasons.push(`TP probability ${metrics.tpProbability.toFixed(1)}% < ${tier.minTpProbability.toFixed(1)}%`);
    }
    if (metrics.forecastConflicts && leverage >= 5) {
      reasons.push(`rough forecast conflicts with ${metrics.action}`);
    }
    // Provider disagreement is resolved by the final judge before this layer.
    // The money manager only downgrades risk; it never creates a duplicate
    // 'direction agreement required' rejection.
    if (metrics.ensembleDisagrees && leverage > 1) {
      reasons.push('provider disagreement limits leverage to 1x');
    }

    return { passed: reasons.length === 0, reasons, tier };
  }

  evaluateLeverage(aiAnalysis, context = {}) {
    const action = String(context.action || aiAnalysis?.action || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) {
      return { approved: false, leverage: 0, requestedLeverage: 0, reason: 'No leverage for HOLD.' };
    }

    const requestedLeverage = this.inferAILeverage(aiAnalysis);
    const approvalText = String(aiAnalysis?.leverageApproval || '').toUpperCase();
    const explicitRejection = aiAnalysis?.approveLeverage === false || approvalText === 'REJECTED';
    const explicitApproval = !explicitRejection && (
      aiAnalysis?.approveLeverage === true ||
      aiAnalysis?.approve10x === true ||
      approvalText === 'APPROVED'
    );

    if (this.requireAIApproval && !explicitApproval) {
      return {
        approved: false,
        leverage: 0,
        requestedLeverage,
        explicitAIApproval: false,
        reason: 'Final AI did not approve any leverage tier.'
      };
    }

    const confidence = finite(context.executionScore ?? aiAnalysis?.executionScore ?? aiAnalysis?.calibratedScore ?? aiAnalysis?.confidence);
    const riskReward = finite(context.riskReward ?? aiAnalysis?.riskReward);
    const entry = finite(context.entryPrice ?? aiAnalysis?.entryPrice);
    const stop = finite(context.stopLoss ?? aiAnalysis?.stopLoss);
    const stopDistancePct = entry > 0 ? (Math.abs(entry - stop) / entry) * 100 : Infinity;
    const alignedTimeframes = this.countAlignedTimeframes(action, context.multiTF);
    const tpProbability = finite(context.tpProbability);
    const forecastDirection = String(context.forecastDirection || 'NEUTRAL').toUpperCase();
    const expectedForecastDirection = action === 'BUY' ? 'BULLISH' : 'BEARISH';
    const forecastConflicts = forecastDirection !== 'NEUTRAL' && forecastDirection !== expectedForecastDirection;
    const volatilityLevel = String(context.volatilityLevel || 'MEDIUM').toUpperCase();
    const liquidity = String(context.liquidity || 'MEDIUM').toUpperCase();

    const ensemble = aiAnalysis?.ensemble;
    const claudeAction = String(ensemble?.claude?.action || '').toUpperCase();
    const deepseekAction = String(ensemble?.deepseek?.action || '').toUpperCase();
    const completeEnsemble = Boolean(claudeAction && deepseekAction);
    const ensembleAgreement = completeEnsemble && claudeAction === action && deepseekAction === action;
    const ensembleDisagrees = completeEnsemble && !ensembleAgreement;

    const exchangeMax = clamp(
      Math.floor(finite(context.marketMaxLeverage, finite(process.env.BYBIT_FALLBACK_MAX_LEVERAGE, 5))),
      1,
      100
    );

    // Wide stops are not automatically rejected. They force lower leverage
    // and therefore a smaller risk-sized position. Stops above the hard cap
    // remain blocked because liquidation/fee sensitivity becomes excessive.
    let stopBasedMaxLeverage = 0;
    if (stopDistancePct <= 3.0) stopBasedMaxLeverage = 5;
    else if (stopDistancePct <= 4.5) stopBasedMaxLeverage = 3;
    else if (stopDistancePct <= 6.0) stopBasedMaxLeverage = 2;
    else if (stopDistancePct <= this.maxWideStopPct) stopBasedMaxLeverage = 1;

    if (stopBasedMaxLeverage === 0) {
      return {
        approved: false,
        leverage: 0,
        requestedLeverage,
        exchangeMaxLeverage: exchangeMax,
        confidence,
        riskReward,
        stopDistancePct,
        alignedTimeframes,
        tpProbability,
        forecastDirection,
        ensembleAgreement,
        attempts: [],
        reason: `Stop distance ${stopDistancePct.toFixed(2)}% exceeds the hard ${this.maxWideStopPct.toFixed(2)}% safety cap.`
      };
    }

    const agreementMaxLeverage = ensembleDisagrees ? 1 : 5;
    const configuredCandidates = this.allowedLeverages
      .filter(value => value <= requestedLeverage && value <= exchangeMax && value <= stopBasedMaxLeverage && value <= agreementMaxLeverage)
      .sort((a, b) => b - a);

    const candidates = this.allowDowngrade
      ? configuredCandidates
      : configuredCandidates.filter(value => value === requestedLeverage);

    const metrics = {
      action,
      confidence,
      riskReward,
      stopDistancePct,
      alignedTimeframes,
      tpProbability,
      forecastDirection,
      forecastConflicts,
      volatilityLevel,
      liquidity,
      completeEnsemble,
      ensembleAgreement,
      ensembleDisagrees
    };

    const attempts = [];
    for (const leverage of candidates) {
      const evaluation = this.evaluateTier(leverage, metrics);
      attempts.push({ leverage, ...evaluation });
      if (evaluation.passed) {
        const downgraded = leverage !== requestedLeverage;
        return {
          approved: true,
          leverage,
          requestedLeverage,
          downgraded,
          exchangeMaxLeverage: exchangeMax,
          explicitAIApproval: explicitApproval,
          confidence,
          riskReward,
          stopDistancePct,
          alignedTimeframes,
          tpProbability,
          forecastDirection,
          ensembleAgreement,
          minimumConfidence: evaluation.tier.minConfidence,
          reason: downgraded
            ? `AI requested ${requestedLeverage}x; hard risk gate downgraded to ${leverage}x${stopDistancePct > 6 ? ` because the stop is ${stopDistancePct.toFixed(2)}% wide` : ensembleDisagrees ? ' because providers disagreed and the final judge resolved direction' : ''}.`
            : (aiAnalysis?.leverageReason || `AI selected ${leverage}x and the hard risk gate approved it.`),
          attempts
        };
      }
    }

    const requestedAboveExchange = requestedLeverage > exchangeMax
      ? `AI requested ${requestedLeverage}x but Bybit reports a ${exchangeMax}x maximum for this symbol. `
      : '';
    const bestAttempt = attempts[0];
    const detail = bestAttempt?.reasons?.join('; ') || 'no configured leverage tier is supported by this market';
    return {
      approved: false,
      leverage: 0,
      requestedLeverage,
      exchangeMaxLeverage: exchangeMax,
      explicitAIApproval: explicitApproval,
      confidence,
      riskReward,
      stopDistancePct,
      alignedTimeframes,
      tpProbability,
      forecastDirection,
      ensembleAgreement,
      attempts,
      reason: `${requestedAboveExchange}${detail}`.trim()
    };
  }

  // Backward-compatible alias used by older callers/tests.
  evaluate10xApproval(aiAnalysis, context = {}) {
    return this.evaluateLeverage(aiAnalysis, context);
  }

  dynamicRiskFraction(confidence, volatilityLevel, consecutiveLosses = 0, leverage = 1) {
    let multiplier = 0.75;
    if (confidence >= 95) multiplier = 1.0;
    else if (confidence >= 85) multiplier = 0.9;
    else if (confidence >= 70) multiplier = 0.82;

    if (String(volatilityLevel).toUpperCase() === 'HIGH') multiplier *= 0.65;
    if (String(volatilityLevel).toUpperCase() === 'MEDIUM') multiplier *= 0.85;
    if (leverage >= 5) multiplier *= 0.72;
    else if (leverage >= 3) multiplier *= 0.82;
    else if (leverage >= 2) multiplier *= 0.90;

    multiplier *= Math.max(0.40, 1 - (Math.max(0, consecutiveLosses) * 0.20));
    return clamp(this.baseRiskFraction * multiplier, 0.0005, this.maxRiskFraction);
  }

  calculatePosition(params = {}) {
    const balance = Math.max(0, finite(params.balance));
    const entryPrice = finite(params.entryPrice);
    const stopLoss = finite(params.stopLoss);
    const leverage = clamp(Math.floor(finite(params.leverage, 1)), 1, 5);
    const riskFraction = this.dynamicRiskFraction(
      finite(params.confidence),
      params.volatilityLevel,
      finite(params.consecutiveLosses),
      leverage
    );
    const riskAmount = balance * riskFraction;
    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    const marketRules = params.marketRules || {};
    const liveMinimum = finite(marketRules.minimumOrderAmount, finite(params.minimumOrderAmount));
    const minimumOrderAmount = liveMinimum > 0 ? liveMinimum : 0.001;
    const amountStep = Math.max(0, finite(marketRules.amountStep));

    if (balance <= 0 || entryPrice <= 0 || riskPerUnit <= 0) {
      return { executable: false, positionSize: 0, reason: 'Invalid balance, entry price or stop-loss distance.' };
    }

    const feeBuffer = Math.max(0.88, 1 - (this.feeRate * 6));
    const rawPositionSize = (riskAmount / riskPerUnit) * feeBuffer;
    const maxByBalance = (balance * leverage / entryPrice) * 0.90;
    const leverageMarginCap = leverage >= 5
      ? Math.min(this.maxMarginFraction, 0.08)
      : this.maxMarginFraction;
    const maxByMarginAllocation = (balance * leverage * leverageMarginCap) / entryPrice;
    const maxPositionSize = Math.min(maxByBalance, maxByMarginAllocation);

    if (maxPositionSize < minimumOrderAmount) {
      const minimumNotional = minimumOrderAmount * entryPrice;
      return {
        executable: false,
        positionSize: 0,
        riskAmount,
        riskFraction,
        reason: `Minimum order needs about $${(minimumNotional / leverage).toFixed(2)} margin at ${leverage}x, above the configured per-trade margin cap.`
      };
    }

    let positionSize = Math.min(Math.max(rawPositionSize, minimumOrderAmount), maxPositionSize);
    if (amountStep > 0) {
      positionSize = Math.floor((positionSize / amountStep) + 1e-12) * amountStep;
    }
    if (positionSize < minimumOrderAmount) positionSize = minimumOrderAmount;

    const notional = positionSize * entryPrice;
    const marginUsed = notional / leverage;
    const stopLossAmount = positionSize * riskPerUnit;

    return {
      executable: Number.isFinite(positionSize) && positionSize > 0,
      positionSize,
      rawPositionSize,
      maximumPositionSize: maxPositionSize,
      riskFraction,
      riskPercent: riskFraction * 100,
      riskAmount,
      stopLossAmount,
      notional,
      marginUsed,
      marginPercent: balance > 0 ? (marginUsed / balance) * 100 : 0,
      leverage,
      minimumOrderAmount,
      reason: 'Position sized from stop-loss risk and capped by leverage-aware margin limits.'
    };
  }
}

module.exports = new MoneyManager();

