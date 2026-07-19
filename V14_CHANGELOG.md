# V14 changelog

## Added

- Independent deterministic evidence engine.
- Weighted bullish/bearish scoring.
- Data-quality scoring and confidence ceiling.
- Contradiction detection and automatic HOLD safety result.
- ATR/structure-based level repair.
- Evidence-based leverage ceiling.
- Specialized Claude risk-auditor role.
- Specialized DeepSeek quantitative role.
- Final portfolio judge role.
- Analysis-only API.
- Parallel multi-timeframe loading.
- Evidence and calibration details in Telegram analysis output.

## Fixed

- Empty `ai.js`, `ai_trader_advanced.js`, `core/config.js`, and `core/index.js`.
- Duplicate weak DeepSeek analysis path.
- Permissive leverage approval defaults.
- Model-reported risk/reward trust.
- Invalid JSON wrappers and code fences.
- Incorrect or missing BUY/SELL price geometry.
- Overconfident decisions during conflicting evidence.
- AI analyzer bypassing the production dual-AI pipeline.
