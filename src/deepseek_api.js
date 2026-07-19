'use strict';

require('dotenv').config();

const aiValidator = require('./ai_validator');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class DeepSeekAPI {
  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.timeoutMs = Math.max(15000, Math.min(120000, Number(process.env.DEEPSEEK_TIMEOUT_MS) || 75000));
    this.maxAttempts = Math.max(1, Math.min(3, Number(process.env.DEEPSEEK_MAX_ATTEMPTS) || 3));
  }

  extractJSON(content) {
    let text = String(content || '').trim();
    if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
    else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('DeepSeek did not return a JSON object');
    return JSON.parse(text.slice(start, end + 1));
  }

  async request(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      const raw = await response.text();
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch (error) {
        throw new Error(`DeepSeek returned non-JSON HTTP data (${response.status})`);
      }
      if (!response.ok) {
        const apiError = new Error(payload?.error?.message || `DeepSeek HTTP ${response.status}`);
        apiError.status = response.status;
        throw apiError;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`DeepSeek request timed out after ${Math.round(this.timeoutMs / 1000)} seconds`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async analyze(coin, marketData, options = {}) {
    if (!this.apiKey) throw new Error('DEEPSEEK_API_KEY is missing');

    const system = `You are the quantitative reviewer in a production crypto risk system. Internally compare bullish and bearish cases, inspect contradictions, validate entry/stop/target geometry, and return only one compact JSON object. Never guarantee profit. Required keys: action, sentiment, confidence, entryPrice, stopLoss, takeProfit, riskReward, marketCondition, signals, warnings, evidenceFor, evidenceAgainst, invalidation, scenario, approveLeverage, recommendedLeverage, approvedLeverage, leverageApproval, leverageReason, tpEtaMinutes, forecastBias, reasoning.`;
    const prompt = `Instrument: ${coin}/USDT\nImmutable market packet:\n${JSON.stringify(marketData)}\nReturn BUY, SELL, or HOLD. HOLD when the edge is weak or contradictory.`;

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const payload = await this.request({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: attempt === 1 ? 3000 : 1800,
          response_format: { type: 'json_object' },
          stream: false
        });
        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new Error('DeepSeek returned empty final content');
        const parsed = this.extractJSON(content);
        const validation = aiValidator.validate(parsed, { marketPrice: marketData?.price });
        if (!validation.valid) throw new Error(`Invalid DeepSeek decision: ${validation.errors.join('; ')}`);
        return { ...validation.sanitized, source: 'deepseek' };
      } catch (error) {
        lastError = error;
        const retryable = !error?.status || error.status === 429 || error.status >= 500;
        if (!retryable || attempt >= this.maxAttempts) break;
        await sleep(500 * (2 ** (attempt - 1)));
      }
    }
    throw lastError || new Error('DeepSeek analysis failed');
  }
}

module.exports = new DeepSeekAPI();
module.exports.DeepSeekAPI = DeepSeekAPI;
