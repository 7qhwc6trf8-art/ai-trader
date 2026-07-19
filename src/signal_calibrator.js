'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config, finite } = require('./core/config');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class SignalCalibrator {
  constructor() {
    this.file = process.env.CALIBRATION_FILE || path.join(config.app.dataDir, 'signal_calibration.json');
    this.state = this.load();
  }

  emptyState() {
    return { version: 2, buckets: {}, recordedTradeIds: {} };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version === 2 && parsed.buckets) return parsed;
      // V15 migration: the old file was directly a bucket object.
      return { version: 2, buckets: parsed || {}, recordedTradeIds: {} };
    } catch (_) {
      return this.emptyState();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.file);
  }

  key(signal = {}) {
    const confidence = clamp(finite(signal.confidence), 0, 100);
    const low = Math.min(90, Math.floor(confidence / 10) * 10);
    const action = String(signal.action || 'HOLD').toUpperCase();
    const regime = String(signal.marketCondition || signal.regime || 'UNKNOWN').toUpperCase();
    const timeframe = String(signal.timeframe || 'UNKNOWN').toUpperCase();
    const source = String(signal.source || 'AI').toUpperCase().slice(0, 24);
    return `${action}:${regime}:${timeframe}:${source}:${low}-${Math.min(100, low + 9)}`;
  }

  signalId(signal = {}) {
    if (signal.signalId) return String(signal.signalId);
    const raw = [
      signal.coin || signal.symbol || '',
      signal.action || '',
      signal.timeframe || '',
      signal.entryPrice || '',
      signal.stopLoss || '',
      signal.takeProfit || '',
      signal.timestamp || Date.now()
    ].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }

  getBucket(signal = {}) {
    return this.state.buckets[this.key(signal)] || {
      samples: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      totalNetPnlPct: 0,
      totalR: 0,
      avgNetPnlPct: 0,
      avgR: 0,
      lastUpdatedAt: null
    };
  }

  scoreDetailed(signal = {}) {
    const raw = clamp(finite(signal.confidence), 0, 100);
    const bucket = this.getBucket(signal);
    const samples = Math.max(0, finite(bucket.samples));
    const priorWins = config.calibration.priorWins;
    const priorLosses = config.calibration.priorLosses;
    const posteriorWinRate = (finite(bucket.wins) + priorWins) /
      Math.max(1, samples + priorWins + priorLosses) * 100;

    // Expectancy contributes only after enough evidence exists and is capped so
    // one outlier trade cannot dominate the execution score.
    const sampleWeight = clamp(samples / config.calibration.minSamples, 0, 1);
    const expectancyAdjustment = clamp(finite(bucket.avgR) * 8, -12, 12) * sampleWeight;
    const evidenceScore = clamp(posteriorWinRate + expectancyAdjustment, 0, 100);

    // Before calibration matures, distrust self-reported LLM confidence. Blend
    // toward a neutral prior rather than allowing a 95% model output to pass.
    const rawCap = samples < config.calibration.minSamples ? 68 : 82;
    const conservativeRaw = Math.min(raw, rawCap);
    const score = clamp(
      evidenceScore * (0.55 + 0.35 * sampleWeight) + conservativeRaw * (0.45 - 0.35 * sampleWeight),
      0,
      100
    );

    return {
      score: Math.round(score * 100) / 100,
      samples,
      wins: finite(bucket.wins),
      losses: finite(bucket.losses),
      posteriorWinRate: Math.round(posteriorWinRate * 100) / 100,
      avgNetPnlPct: finite(bucket.avgNetPnlPct),
      avgR: finite(bucket.avgR),
      mature: samples >= config.calibration.minSamples,
      bucketKey: this.key(signal)
    };
  }

  score(signal = {}) {
    return this.scoreDetailed(signal).score;
  }

  record(signal = {}, result = {}) {
    const tradeId = String(result.tradeId || result.orderId || result.id || this.signalId({ ...signal, timestamp: result.closedAt || Date.now() }));
    if (this.state.recordedTradeIds[tradeId]) {
      return { recorded: false, reason: 'duplicate', bucket: this.getBucket(signal) };
    }

    const netPnlPct = finite(result.netPnlPct ?? result.pnlPercent);
    const netPnl = finite(result.netPnl ?? result.pnl ?? result.closedPnl);
    const riskAmount = Math.abs(finite(result.riskAmount));
    const rMultiple = Number.isFinite(Number(result.rMultiple))
      ? finite(result.rMultiple)
      : (riskAmount > 0 ? netPnl / riskAmount : 0);

    const key = this.key(signal);
    const bucket = this.getBucket(signal);
    bucket.samples += 1;
    if (netPnl > 0 || netPnlPct > 0) bucket.wins += 1;
    else if (netPnl < 0 || netPnlPct < 0) bucket.losses += 1;
    else bucket.breakeven += 1;
    bucket.totalNetPnlPct += netPnlPct;
    bucket.totalR += rMultiple;
    bucket.avgNetPnlPct = bucket.totalNetPnlPct / bucket.samples;
    bucket.avgR = bucket.totalR / bucket.samples;
    bucket.lastUpdatedAt = new Date().toISOString();

    this.state.buckets[key] = bucket;
    this.state.recordedTradeIds[tradeId] = bucket.lastUpdatedAt;

    // Keep idempotency history bounded.
    const ids = Object.keys(this.state.recordedTradeIds);
    if (ids.length > 10000) {
      ids.sort((a, b) => String(this.state.recordedTradeIds[a]).localeCompare(String(this.state.recordedTradeIds[b])));
      for (const id of ids.slice(0, ids.length - 8000)) delete this.state.recordedTradeIds[id];
    }

    this.save();
    return { recorded: true, bucket, tradeId };
  }

  summary() {
    const buckets = Object.entries(this.state.buckets);
    const samples = buckets.reduce((sum, [, bucket]) => sum + finite(bucket.samples), 0);
    const wins = buckets.reduce((sum, [, bucket]) => sum + finite(bucket.wins), 0);
    return {
      buckets: buckets.length,
      samples,
      wins,
      winRate: samples > 0 ? wins / samples * 100 : 0,
      minSamples: config.calibration.minSamples
    };
  }
}

module.exports = new SignalCalibrator();
