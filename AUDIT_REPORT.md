# V16.1 Audit Report

This report documents errors and omissions found in the uploaded source and in the earlier V14/V15 packaging work.

## Critical runtime and provider fixes

1. **Claude HTTP 400** — the old Claude payload included a non-default `temperature`. V16.1 direct mode sends only model, max tokens, system, and messages.
2. **Unsafe partial ensemble** — when Claude failed, the old flow could continue from DeepSeek alone. Strict ensemble now returns `HOLD` unless explicitly configured otherwise.
3. **Raw provider JSON in Telegram** — nested provider errors are now reduced to a readable message.
4. **Missing dependency** — `database.js` required `better-sqlite3`, but the previous package did not declare it.
5. **Old DeepSeek default** — legacy `deepseek-chat` defaults were replaced with `deepseek-v4-pro`.

## Risk and execution fixes

6. **100x/legacy leverage schema** — AI prompts and validators disagreed with the hard risk layer. All automatic leverage tiers are now 1x/2x/3x/5x, capped at 5x.
7. **Explicit leverage rejection could be overridden** — a numeric recommendation could previously beat `REJECTED`. Explicit rejection now always wins.
8. **Nonexistent method call** — `bot.js` called `riskManager.checkDailyLoss()`, which did not exist. It now uses the real daily-loss-limit calculation.
9. **Stale portfolio before execution** — AI calls can take a long time. Balance and positions are re-fetched immediately before placing an order.
10. **Symbol mismatch** — BTC, BTCUSDT, BTC/USDT, and BTC/USDT:USDT comparisons now use a shared normalizer.
11. **Duplicate order display** — overlapping Bybit open/closed/canceled results are deduplicated by order ID.
12. **Duplicate local Telegram pollers** — a process lock now blocks a second local instance before it reaches `getUpdates`; stale locks recover automatically.
13. **AI confidence treated as probability** — execution now uses a separate calibrated score and minimum sample requirement.
14. **Calibration never learned from closes** — order signal context is stored and linked to synchronized closed PnL so calibration receives actual outcomes.
15. **Targets used tradable balance instead of equity** — target and loss controls now use account equity/opening equity where appropriate.

## Market-analysis fixes

16. **Incorrect 24-hour change** — the old code always looked back 24 candles. On 15m this represented 6 hours; on 4h it represented 4 days. Lookback now depends on timeframe duration.
17. **1w Telegram button without analyzer support** — `1w` is now exported and its callback is registered.
18. **Provider-specific payloads mixed together** — Claude and DeepSeek now have separate request builders and recovery logic.

## Backtest fixes

19. **LONG-only behavior** — SELL previously closed LONG positions instead of opening SHORT positions. Both sides are now modeled.
20. **Close-only TP/SL checks** — candle high/low now trigger exits.
21. **Same-candle ambiguity** — if TP and SL are both touched, the default policy is conservative/worst-case.
22. **Look-ahead bias** — a signal calculated at candle close previously executed at that same close. It now executes at the next candle open.
23. **Gap handling** — stop/target fills account for the next candle opening beyond the level.
24. **Incomplete costs and drawdown** — fees, slippage, approximate funding, floating equity, expectancy, and maximum drawdown are included.

## Statistics fixes

25. **No daily/week/month/year account views** — added SQLite-backed Bybit realized-PnL statistics and Telegram buttons.
26. **Fake history unlock** — empty backfilled days previously could immediately unlock weekly/monthly views. Unlocking now starts from the first trustworthy observation or first real closed trade.
27. **Future Bybit range** — current-day queries clamp `endTime` to the current timestamp.
28. **400-day history cap** — yearly history now reads the complete tracked date range instead of only the latest 400 rows.
29. **Missing limitation disclosure** — the bot explains that deposits, withdrawals, transfers, or manual activity can distort reconstructed returns.

## Presentation and maintenance fixes

30. **Broken mojibake text** — double-encoded emoji and punctuation were cleaned across Telegram output.
31. **Empty compatibility modules** — `ai.js` and `ai_trader_advanced.js` now explicitly route legacy imports to the current engine.
32. **Outdated V13/V14/V15 documentation** — replaced with V16.1 installation, statistics, provider, and safety documentation.

## Known limitations

- No strategy can guarantee at least 2% profit every day or 5% on demand.
- The statistics engine reconstructs opening equity from current equity and closed PnL; external cash flows require a separate deposit/withdrawal ledger for exact time-weighted returns.
- The project was validated with syntax/static checks and mocked deterministic tests. Live Bybit order placement and real Claude/DeepSeek requests require the owner’s credentials and were not executed during packaging.
- Exchange behavior, symbol availability, fees, funding, minimum quantities, and provider model access can change; verify read-only mode before enabling RW mode.
