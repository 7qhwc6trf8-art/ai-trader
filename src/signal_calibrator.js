'use strict';

const fs = require('fs');
const path = require('path');

const finite = (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class SignalCalibrator {
  constructor() {
    this.file = process.env.CALIBRATION_FILE || path.join(__dirname, '../data/signal_calibration.json');
    this.minSamples = Math.max(20, Math.floor(finite(process.env.MIN_CALIBRATION_SAMPLES, 100)));
    this.buckets = this.load();
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (_) { return {}; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.buckets, null, 2));
  }

  key(signal) {
    const confidence = clamp(finite(signal?.confidence), 0, 100);
    const low = Math.floor(confidence / 10) * 10;
    const action = String(signal?.action || 'HOLD').toUpperCase();
    const regime = String(signal?.marketCondition || signal?.regime || 'UNKNOWN').toUpperCase();
    return `${action}:${regime}:${low}-${Math.min(100, low + 9)}`;
  }

  score(signal) {
    const raw = clamp(finite(signal?.confidence), 0, 100);
    const bucket = this.buckets[this.key(signal)];
    if (!bucket || bucket.samples < this.minSamples) {
      // Until enough evidence exists, cap LLM confidence aggressively.
      return Math.min(raw, 72);
    }
    const winRate = bucket.wins / Math.max(1, bucket.samples) * 100;
    const expectancyBoost = clamp(finite(bucket.avgNetPnlPct) * 8, -15, 15);
    return clamp(winRate + expectancyBoost, 0, 100);
  }

  record(signal, netPnlPct) {
    const key = this.key(signal);
    const b = this.buckets[key] || { samples: 0, wins: 0, totalNetPnlPct: 0, avgNetPnlPct: 0 };
    b.samples += 1;
    if (finite(netPnlPct) > 0) b.wins += 1;
    b.totalNetPnlPct += finite(netPnlPct);
    b.avgNetPnlPct = b.totalNetPnlPct / b.samples;
    this.buckets[key] = b;
    this.save();
    return b;
  }
}

module.exports = new SignalCalibrator();
