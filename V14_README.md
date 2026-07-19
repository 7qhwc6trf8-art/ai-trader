# Ultra AI Trader V14

This package contains the complete fixed `src` folder reconstructed from the supplied source export.

## Main architecture

1. Claude performs a skeptical risk review.
2. DeepSeek performs an independent quantitative and market-structure review.
3. The configured judge rechecks both reviews against the original immutable evidence packet.
4. The deterministic reasoning engine independently scores trend, momentum, volume, structure, patterns, volatility, data quality, and multi-timeframe alignment.
5. Confidence, entry, stop, target, risk/reward, and leverage are calibrated before the money-management and Bybit execution gates.

The deterministic engine never upgrades leverage. It can downgrade or reject it.

## Replaced or added AI files

- `src/ultra_ai_reasoning.js` — new deterministic evidence and calibration engine.
- `src/ultimate_ai_trader.js` — specialized dual-AI reviews, judge, compact prompt packet, parallel timeframes, analysis-only mode.
- `src/ai_validator.js` — explicit leverage approval, strict trade validation, robust schema sanitation.
- `src/ai_analyzer.js` — pure analysis entry point; never sends an order.
- `src/ai_trader.js` — compatibility wrapper around the production engine.
- `src/deepseek_api.js` — robust direct client with retry, timeout, JSON extraction, and validation.
- `src/ai.js` and `src/ai_trader_advanced.js` — repaired compatibility exports.
- `src/core/config.js` and `src/core/index.js` — repaired previously empty files.
- `src/bot.js` — displays evidence direction, data quality, confidence calibration, invalidation, and principal risk.

## Usage

Copy the complete `src` folder over the existing project source, then install dependencies and restart:

```bash
npm install
pm2 restart ai-trader --update-env
pm2 logs ai-trader --lines 100
```

For pure analysis without execution:

```js
const { analyzeUltra } = require('./src/ai_analyzer');

const result = await analyzeUltra('BTC', {
  timeframe: '1h',
  limit: 250
});

console.log(result.action, result.confidence, result.reasoningEvidence);
```

## Important behavior

- AI failures return zero-confidence HOLD; the bot does not invent a trade.
- Severe contradiction between an AI direction and deterministic market evidence becomes HOLD.
- Model-reported risk/reward is ignored in favor of actual entry/SL/TP mathematics.
- Entry prices too far from the live price are normalized.
- Invalid or unsafe stops and targets are repaired using ATR and structure.
- 100x remains exceptional and is still checked again by `money_manager.js` and Bybit's symbol limit.
- The `$10` daily target remains a stopping rule, not a guaranteed return.

## Validation

Run:

```bash
node ultra_ai_self_test.js
node ultimate_ai_integration_self_test.js
```
