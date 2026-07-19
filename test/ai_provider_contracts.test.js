'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-ai-contract-'));
process.env.EXECUTION_MODE = 'analysis';
process.env.AI_PROVIDER = 'claude';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.TRADING_DB_PATH = path.join(temp, 'trading.db');
process.env.DATA_DIR = path.join(temp, 'data');
process.env.LOGS_DIR = path.join(temp, 'logs');

const trader = require('../src/ultimate_ai_trader');

const holdDecision = {
  sentiment: 'NEUTRAL', confidence: 0, action: 'HOLD',
  entryPrice: 0, stopLoss: 0, takeProfit: 0,
  positionSizePercent: 0, riskReward: 0,
  marketCondition: 'RANGING', signals: [], warnings: [],
  approveLeverage: false, recommendedLeverage: 0, approvedLeverage: 0,
  leverageApproval: 'REJECTED', leverageReason: 'No trade.',
  tpEtaMinutes: 0, forecastBias: 'NEUTRAL', reasoning: 'No valid setup.'
};

(async () => {
  let claudePayload;
  trader.anthropic = {
    messages: {
      create: async payload => {
        claudePayload = payload;
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(holdDecision) }]
        };
      }
    }
  };

  const claude = await trader.requestClaudeAnalysis('market packet', 'system rules');
  assert.strictEqual(claude.action, 'HOLD');
  assert.strictEqual(claudePayload.output_config.format.type, 'json_schema');
  assert.strictEqual(claudePayload.output_config.format.schema.additionalProperties, false);
  assert.ok(claudePayload.output_config.format.schema.required.includes('stopLoss'));

  const originalFetch = global.fetch;
  const bodies = [];
  let calls = 0;
  trader.sleep = async () => {};
  global.fetch = async (_url, options) => {
    calls += 1;
    bodies.push(JSON.parse(options.body));
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: name => name.toLowerCase() === 'retry-after' ? '0' : null },
        text: async () => JSON.stringify({ error: { message: 'rate limited' } })
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(holdDecision) } }]
      })
    };
  };

  try {
    const deepseek = await trader.requestDeepSeekAnalysis('market packet', 'system rules');
    assert.strictEqual(deepseek.action, 'HOLD');
    assert.strictEqual(calls, 2);
    assert.strictEqual(bodies[0].thinking.type, 'enabled');
    assert.strictEqual(bodies[1].thinking.type, 'disabled');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('Claude structured output and DeepSeek transient retry contracts verified');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
