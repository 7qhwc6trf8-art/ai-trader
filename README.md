# AI Trader V17 — Full Statistics & Provider Fixes

A CommonJS Node.js trading bot for Bybit perpetual futures with Telegram controls, Claude + DeepSeek analysis, strict risk gates, auditable execution, calibrated signals, LONG/SHORT backtesting, and account performance statistics.

## Important

The `2%` and `5%` values in `.env.example` are **daily target and stop controls**, not guaranteed returns. The bot must remain allowed to finish a day at 0% or a loss when no valid setup exists. Forcing a minimum profit causes overtrading and leverage escalation.

Start with `BYBIT_MODE=ro`, then paper testing or a very small isolated balance. Do not put the full account into an unverified strategy.

## Install

```bash
npm install
cp .env.example .env
npm test
npm start
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm test
npm start
```

Fill the Telegram, Bybit, Anthropic, and DeepSeek keys in `.env`. Never commit `.env` or API keys to Git. A `.gitignore` is included for secrets, SQLite files, logs, and the runtime instance lock.

## Claude 400 sampling-parameter fix

V17 uses `CLAUDE_API_MODE=direct` by default and sends an exact Claude request without `temperature`, `top_p`, or `top_k`. After replacing the old files, stop every previous Node process and restart the bot; otherwise the running server may continue sending the obsolete payload.

Strict ensemble behavior is enabled by default:

```env
REQUIRE_COMPLETE_ENSEMBLE=true
ALLOW_PARTIAL_ENSEMBLE=false
```

When Claude or DeepSeek fails, the ensemble returns `HOLD` rather than silently trading from one provider.

## Account statistics

Use `/statistics` or **📈 Account Statistics**.

Telegram buttons:

- Daily Statistics
- Week Statistics
- Monthly Statistics
- Year Statistics
- Refresh

Daily rows use this format:

```text
01/01/2026 • +5.00% • +$10.0000 • 3 trades
02/01/2026 • -2.10% • -$4.2000 • 2 trades
```

Weekly statistics unlock after 7 tracked calendar days, monthly after 30 days, and yearly after 365 days. Before that the bot displays exactly how many days remain.

Statistics are synchronized from Bybit closed-PnL records and stored in SQLite. Percent return is realized closed PnL divided by reconstructed opening equity. Deposits, withdrawals, internal transfers, and manual positions can distort reconstructed historical percentages; the Telegram message shows this limitation.

## Core safety defaults

```env
DAILY_SOFT_TARGET_PCT=2
DAILY_HARD_TARGET_PCT=5
MAX_DAILY_LOSS_PCT=2
RISK_PER_TRADE_PCT=0.35
MAX_RISK_PER_TRADE_PCT=0.50
MAX_OPEN_POSITIONS=2
MAX_TRADES_PER_DAY=4
MAX_CONSECUTIVE_LOSSES=2
AI_LEVERAGE_OPTIONS=1,2,3,5
MAX_AI_LEVERAGE=5
```

The hard daily profit target stops new entries after the configured level. It never makes the bot increase leverage to reach the target.

## Verification

`npm test` runs:

- JavaScript syntax and dependency declaration audit
- Telegram callback and provider-payload checks
- statistics aggregation/unlock tests
- mocked Bybit statistics synchronization
- LONG/SHORT next-candle backtest tests
- leverage rejection tests
- duplicate Bybit order deduplication tests
- duplicate local bot-instance lock tests

A local instance lock prevents a second Node process from starting with the same project and causing Telegram `409 getUpdates` conflicts. It cannot detect a duplicate process running on another server.

These tests do not replace live Bybit or AI-provider verification with your own API credentials.

## Files added or substantially rebuilt

- `src/account_statistics.js`
- `src/execution_guard.js`
- `src/signal_calibrator.js`
- `src/trade_journal.js`
- `src/order_utils.js`
- `src/backtest.js`
- `AUDIT_REPORT.md`
- `V16_CHANGELOG.md`


## V17 execution policy

- Missing provider: HOLD before leverage evaluation.
- Unresolved Claude/DeepSeek disagreement: HOLD.
- High-confidence final judge resolution: trade may proceed at maximum 1x.
- 6-10% stop distance: maximum 1x with risk-sized quantity.
- More than 10% stop distance: blocked.

After replacing an older deployment, delete and recreate the PM2 process so it cannot keep the old source path:

```bash
pm2 delete ai-trader
cd /root/ai-trader
npm install
pm2 start src/bot.js --name ai-trader --cwd /root/ai-trader --instances 1 --exec-mode fork --update-env
pm2 save
```
