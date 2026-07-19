'use strict';

const signalCalibrator = require('./signal_calibrator');
const { config, finite } = require('./core/config');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class ExecutionScore {
  evaluate(signal = {}, context = {}) {
    const rawConfidence = clamp(finite(signal.confidence, 0), 0, 100);
    const calibration = signalCalibrator.scoreDetailed(signal);
    const rr = Math.max(0, finite(signal.riskReward));
    const aligned = Math.max(0, Math.trunc(finite(context.alignedTimeframes)));
    const volumeSpike = Math.max(0, finite(context.volumeSpike, 1));
    const spreadPct = Math.max(0, finite(context.spreadPct));
    const entryDriftPct = Math.max(0, finite(context.entryDriftPct));
    const tpProbability = clamp(finite(context.tpProbability), 0, 100);
    const volatility = String(context.volatilityLevel || 'MEDIUM').toUpperCase();
    const liquidity = String(context.liquidity || 'MEDIUM').toUpperCase();
    const forecastAligned = context.forecastAligned === true;
    const ensembleComplete = context.ensembleComplete === true;
    const ensembleAgreement = context.ensembleAgreement === true;
    const technicalDirectionAgreement = context.technicalDirectionAgreement !== false;

    let score = 0;
    const components = {};

    components.calibration = calibration.score * 0.34;
    components.rawConfidence = Math.min(rawConfidence, 82) * 0.12;
    components.riskReward = clamp((rr - 1) / 2.5, 0, 1) * 16;
    components.timeframes = clamp(aligned / 3, 0, 1) * 10;
    components.tpProbability = clamp(tpProbability / 70, 0, 1) * 8;
    components.volume = clamp((volumeSpike - 0.8) / 1.2, 0, 1) * 5;
    components.forecast = forecastAligned ? 4 : 0;
    components.ensemble = ensembleComplete ? (ensembleAgreement ? 7 : 2) : 0;
    components.technical = technicalDirectionAgreement ? 4 : -8;
    components.liquidity = liquidity === 'HIGH' ? 4 : liquidity === 'MEDIUM' ? 2 : -8;
    components.volatility = volatility === 'HIGH' ? -5 : volatility === 'LOW' ? 2 : 0;
    components.spreadPenalty = -clamp(spreadPct / Math.max(0.001, config.bybit.maxSpreadPct), 0, 2) * 5;
    components.driftPenalty = -clamp(entryDriftPct / Math.max(0.001, config.bybit.maxEntryDriftPct), 0, 2) * 6;

    for (const value of Object.values(components)) score += finite(value);
    score = clamp(score, 0, 100);

    return {
      score: Math.round(score * 100) / 100,
      rawConfidence,
      calibration,
      components,
      sufficientCalibration: calibration.samples >= config.calibration.minimumLiveSamples,
      passed: score >= config.risk.minExecutionScore
    };
  }
}

module.exports = new ExecutionScore();
