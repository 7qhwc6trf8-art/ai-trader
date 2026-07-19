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
    this.allowedLeverages = this.parseLeverageOptions(process.env.AI_LEVERAGE_OPTIONS || '4,5,10,100');
    this.maxConfiguredLeverage = clamp(
      Math.floor(finite(process.env.MAX_AI_LEVERAGE, Math.max(...this.allowedLeverages))),
      1,
      100
    );
    this.allowedLeverages = this.allowedLeverages.filter(value => value <= this.maxConfiguredLeverage);
    if (this.allowedLeverages.length === 0) this.allowedLeverages = [4];

    this.requireAIApproval = truthy(process.env.REQUIRE_AI_LEVERAGE_APPROVAL, true);
    this.allowDowngrade = truthy(process.env.ALLOW_AI_LEVERAGE_DOWNGRADE, true);
    this.requireEnsembleFor100x = truthy(process.env.REQUIRE_100X_ENSEMBLE_AGREEMENT, true);

    this.baseRiskFraction = clamp(finite(process.env.RISK_PER_TRADE_PCT, 0.6) / 100, 0.001, 0.05);
    this.maxRiskFraction = clamp(finite(process.env.MAX_RISK_PER_TRADE_PCT, 0.8) / 100, this.baseRiskFraction, 0.05);
    this.maxMarginFraction = clamp(finite(process.env.MAX_MARGIN_PER_TRADE_PCT, 15) / 100, 0.01, 0.95);
    this.feeRate = clamp(finite(process.env.TRADING_FEE_RATE, 0.001), 0, 0.01);

    this.tiers = {
      4: {
        minConfidence: clamp(finite(process.env.MIN_4X_CONFIDENCE, 55), 0, 100),
        minRiskReward: clamp(finite(process.env.MIN_4X_RISK_REWARD, 1.15), 0, 20),
        minAlignedTimeframes: clamp(Math.floor(finite(process.env.MIN_4X_ALIGNED_TIMEFRAMES, 1)), 0, 5),
        minTpProbability: clamp(finite(process.env.MIN_4X_TP_PROBABILITY_PCT, 15), 0, 100),
        minStopDistancePct: clamp(finite(process.env.MIN_4X_STOP_DISTANCE_PCT, 0.10), 0.01, 20),
        maxStopDistancePct: clamp(finite(process.env.MAX_4X_STOP_DISTANCE_PCT, 8), 0.05, 50)
      },
      5: {
        minConfidence: clamp(finite(process.env.MIN_5X_CONFIDENCE, 62), 0, 100),
        minRiskReward: clamp(finite(process.env.MIN_5X_RISK_REWARD, 1.25), 0, 20),
        minAlignedTimeframes: clamp(Math.floor(finite(process.env.MIN_5X_ALIGNED_TIMEFRAMES, 1)), 0, 5),
        minTpProbability: clamp(finite(process.env.MIN_5X_TP_PROBABILITY_PCT, 20), 0, 100),
        minStopDistancePct: clamp(finite(process.env.MIN_5X_STOP_DISTANCE_PCT, 0.10), 0.01, 20),
        maxStopDistancePct: clamp(finite(process.env.MAX_5X_STOP_DISTANCE_PCT, 6), 0.05, 50)
      },
      10: {
        minConfidence: clamp(finite(process.env.MIN_10X_CONFIDENCE, 72), 0, 100),
        minRiskReward: clamp(finite(process.env.MIN_10X_RISK_REWARD, 1.50), 0, 20),
        minAlignedTimeframes: clamp(Math.floor(finite(process.env.MIN_10X_ALIGNED_TIMEFRAMES, 2)), 0, 5),
        minTpProbability: clamp(finite(process.env.MIN_10X_TP_PROBABILITY_PCT, 25), 0, 100),
        minStopDistancePct: clamp(finite(process.env.MIN_10X_STOP_DISTANCE_PCT, 0.10), 0.01, 20),
        maxStopDistancePct: clamp(finite(process.env.MAX_10X_STOP_DISTANCE_PCT, 4), 0.05, 50)
      },
      100: {
        minConfidence: clamp(finite(process.env.MIN_100X_CONFIDENCE, 92), 0, 100),
        minRiskReward: clamp(finite(process.env.MIN_100X_RISK_REWARD, 2.20), 0, 20),
        minAlignedTimeframes: clamp(Math.floor(finite(process.env.MIN_100X_ALIGNED_TIMEFRAMES, 3)), 0, 5),
        minTpProbability: clamp(finite(process.env.MIN_100X_TP_PROBABILITY_PCT, 50), 0, 100),
        minStopDistancePct: clamp(finite(process.env.MIN_100X_STOP_DISTANCE_PCT, 0.05), 0.01, 20),
        maxStopDistancePct: clamp(finite(process.env.MAX_100X_STOP_DISTANCE_PCT, 0.70), 0.05, 50)
      }
    };
  }

  parseLeverageOptions(value) {
    const parsed = String(value || '')
      .split(',')
      .map(item => Math.floor(Number(item.trim())))
      .filter(item => Number.isFinite(item) && item >= 1 && item <= 100);
    return [...new Set(parsed.length ? parsed : [4, 5, 10, 100])].sort((a, b) => a - b);
  }

  normalizeLeverage(value, fallback = 4) {
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
    if (confidence >= 96 && this.allowedLeverages.includes(100)) return 100;
    if (confidence >= 80 && this.allowedLeverages.includes(10)) return 10;
    if (confidence >= 67 && this.allowedLeverages.includes(5)) return 5;
    return this.allowedLeverages[0];
  }

  countAlignedTimeframes(action, multiTF = {}) {
    const expected = action === 'BUY' ? 'BULLISH' : 'BEARISH';
    return Object.values(multiTF).filter(value => String(value).toUpperCase() === expected).length;
  }

  tierFor(leverage) {
    if (leverage >= 100) return this.tiers[100];
    if (leverage >= 10) return this.tiers[10];
    if (leverage >= 5) return this.tiers[5];
    return this.tiers[4];
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
    if (metrics.forecastConflicts && leverage >= 10) {
      reasons.push(`rough forecast conflicts with ${metrics.action}`);
    }
    if (metrics.completeEnsemble && metrics.ensembleDisagrees && leverage >= 10) {
      reasons.push('Claude and DeepSeek disagree with the final direction');
    }

    if (leverage >= 100) {
      if (this.requireEnsembleFor100x && !metrics.completeEnsemble) {
        reasons.push('100x requires complete Claude + DeepSeek technical reviews');
      }
      if (this.requireEnsembleFor100x && !metrics.ensembleAgreement) {
        reasons.push('100x requires Claude and DeepSeek to agree with the final action');
      }
      if (metrics.volatilityLevel !== 'LOW') {
        reasons.push(`100x requires LOW volatility, received ${metrics.volatilityLevel}`);
      }
      if (!['HIGH', 'MEDIUM'].includes(metrics.liquidity)) {
        reasons.push(`100x requires adequate liquidity, received ${metrics.liquidity}`);
      }
    }

    return { passed: reasons.length === 0, reasons, tier };
  }

  evaluateLeverage(aiAnalysis, context = {}) {
    const action = String(context.action || aiAnalysis?.action || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) {
      return { approved: false, leverage: 0, requestedLeverage: 0, reason: 'No leverage for HOLD.' };
    }

    const requestedLeverage = this.inferAILeverage(aiAnalysis);
    const explicitApproval = aiAnalysis?.approveLeverage === true ||
      aiAnalysis?.approve10x === true ||
      String(aiAnalysis?.leverageApproval || '').toUpperCase() === 'APPROVED' ||
      finite(aiAnalysis?.recommendedLeverage ?? aiAnalysis?.approvedLeverage, 0) > 0;

    if (this.requireAIApproval && !explicitApproval) {
      return {
        approved: false,
        leverage: 0,
        requestedLeverage,
        explicitAIApproval: false,
        reason: 'Final AI did not approve any leverage tier.'
      };
    }

    const confidence = finite(aiAnalysis?.confidence);
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
      Math.floor(finite(context.marketMaxLeverage, finite(process.env.BYBIT_FALLBACK_MAX_LEVERAGE, 10))),
      1,
      100
    );
    const configuredCandidates = this.allowedLeverages
      .filter(value => value <= requestedLeverage && value <= exchangeMax)
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
            ? `AI requested ${requestedLeverage}x; hard risk gate downgraded to ${leverage}x.`
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

  dynamicRiskFraction(confidence, volatilityLevel, consecutiveLosses = 0, leverage = 4) {
    let multiplier = 0.75;
    if (confidence >= 95) multiplier = 1.0;
    else if (confidence >= 85) multiplier = 0.9;
    else if (confidence >= 70) multiplier = 0.82;

    if (String(volatilityLevel).toUpperCase() === 'HIGH') multiplier *= 0.65;
    if (String(volatilityLevel).toUpperCase() === 'MEDIUM') multiplier *= 0.85;
    if (leverage >= 100) multiplier *= 0.20;
    else if (leverage >= 10) multiplier *= 0.55;
    else if (leverage >= 5) multiplier *= 0.80;

    multiplier *= Math.max(0.40, 1 - (Math.max(0, consecutiveLosses) * 0.20));
    return clamp(this.baseRiskFraction * multiplier, 0.0005, this.maxRiskFraction);
  }

  calculatePosition(params = {}) {
    const balance = Math.max(0, finite(params.balance));
    const entryPrice = finite(params.entryPrice);
    const stopLoss = finite(params.stopLoss);
    const leverage = clamp(Math.floor(finite(params.leverage, 4)), 1, 100);
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
    const leverageMarginCap = leverage >= 100
      ? Math.min(this.maxMarginFraction, 0.05)
      : leverage >= 10
        ? Math.min(this.maxMarginFraction, 0.10)
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
