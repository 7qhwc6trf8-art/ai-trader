# V16.1 Change Log

## Statistics

- Added `/statistics` and account-statistics keyboard entry.
- Added daily, weekly, monthly, yearly, and refresh inline buttons.
- Added `DD/MM/YYYY • ±X.XX%` history rows.
- Added period unlock countdowns: 7, 30, and 365 tracked days.
- Added Bybit closed-PnL synchronization and SQLite persistence.
- Added complete tracked-range aggregation for multi-year history.

## AI providers

- Added direct Claude Messages API transport without deprecated sampling parameters.
- Added readable provider-error extraction.
- Added strict complete-ensemble HOLD behavior.
- Updated DeepSeek defaults to `deepseek-v4-pro`.

## Execution and risk

- Limited automatic leverage to 1x/2x/3x/5x.
- Made explicit AI leverage rejection authoritative.
- Added fresh balance/position check immediately before execution.
- Added normalized symbol comparisons, exposure caps, and audit journal.
- Added a stale-safe local process lock to prevent duplicate Telegram polling instances.
- Connected closed trade outcomes to signal calibration.

## Market and backtest

- Fixed timeframe-aware 24-hour change.
- Added 1w analyzer support.
- Rebuilt backtest for LONG/SHORT, next-open execution, high/low TP/SL, gap fills, worst-case intrabar handling, fees, slippage, funding, and drawdown.

## Packaging

- Added missing `better-sqlite3` dependency declaration.
- Added deterministic self-tests and static audit.
- Cleaned Telegram text encoding.
