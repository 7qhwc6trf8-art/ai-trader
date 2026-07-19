'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const trader = fs.readFileSync(path.join(root, 'src', 'ultimate_ai_trader.js'), 'utf8');
const analyzer = fs.readFileSync(path.join(root, 'src', 'analyzer.js'), 'utf8');
const bot = fs.readFileSync(path.join(root, 'src', 'bot.js'), 'utf8');

const claudeBuilder = trader.match(/buildClaudeRequest\([\s\S]*?return\s+\{([\s\S]*?)\n\s*\};\n\s*\}/);
assert(claudeBuilder, 'Claude request builder was not found');
const claudePayload = claudeBuilder[1];
assert(!/\btemperature\s*:/.test(claudePayload), 'Claude payload must not include temperature');
assert(!/\btop_p\s*:/.test(claudePayload), 'Claude payload must not include top_p');
assert(!/\btop_k\s*:/.test(claudePayload), 'Claude payload must not include top_k');
assert(trader.includes("https://api.anthropic.com/v1/messages"), 'Claude direct Messages endpoint is missing');
assert(trader.includes("REQUIRE_COMPLETE_ENSEMBLE"), 'Strict ensemble gate is missing');
assert(trader.includes("source: 'dual-ai-incomplete-hold'"), 'Incomplete ensemble HOLD behavior is missing');
assert(!trader.includes('one of 0, 4, 5, 10, 100'), 'Outdated leverage schema remains');
assert(analyzer.includes('"1w"'), '1w must be exported in TIMEFRAMES');
for (const callback of ['stats_daily', 'stats_week', 'stats_month', 'stats_year', 'stats_refresh', 'tf_1w']) {
  assert(bot.includes(callback), `Telegram callback ${callback} is missing`);
}

console.log('OK: provider payload, strict ensemble, leverage schema and Telegram callbacks passed.');
