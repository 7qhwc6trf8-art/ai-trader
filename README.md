# AI Trader V16 Autonomous Full

V16-ը autonomous crypto-futures research, paper-trading և guarded live-execution համակարգ է՝ Claude + DeepSeek ensemble-ով, Bybit/CCXT ինտեգրմամբ, persistent risk state-ով և restart recovery-ով։

**Կարևոր․** օրական 2% կամ 5% շահույթը երաշխավորված չէ։ `2%`-ը soft profit-lock է, իսկ `5%`-ը hard daily pause։ Համակարգը երբեք չի մեծացնում leverage-ը կամ չի բացում թույլ trade միայն թիրախը լրացնելու համար։

## Ինչ է ինքնուրույն անում

1. Սկանավորում է coin universe-ը և `15m,1h,4h` փակ candle-ները։
2. Թույլ candidate-ները հեռացնում է `MIN_PRESCAN_SCORE` շեմով։
3. Յուրաքանչյուր coin-ից առավելագույնը մեկ finalist է ուղարկում թանկ AI review-ի։
4. Claude-ը և DeepSeek-ը անկախ տալիս են strict JSON որոշումներ։
5. Ensemble judge-ը վերահաստատում է BUY/SELL/HOLD-ը։
6. Execution score-ը միավորում է calibrated history, multi-timeframe context, liquidity, forecast և technical agreement-ը։
7. Risk engine-ը ստուգում է daily/weekly circuit breaker-ները, exposure-ը, margin-ը և duplicate position-ը։
8. Position size-ը հաշվարկվում է stop-loss distance-ից՝ fees/slippage-ի գնահատմամբ։
9. Live order-ից առաջ նորից ստացվում են balance, portfolio և ticker տվյալները։
10. Order fill-ից հետո Bybit position-level TP/SL-ը դրվում և հաստատվում է։
11. Եթե protection-ը չի հաստատվում, bot-ը փորձում է փակել դիրքը և կանգնեցնում է նոր execution-ը։
12. Restart-ից հետո pending orders, positions, cooldown, daily PnL և calibration state-ը վերականգնվում են։

## Պահանջներ

- Node.js `22.5+`։ Production-ի համար նախընտրելի է ընթացիկ LTS տարբերակը։
- npm
- Telegram bot token
- Ձեր Telegram user ID-ն allowlist-ում
- Claude և/կամ DeepSeek API key
- Bybit API keys՝ միայն live mode-ի համար

## Տեղադրում

```bash
npm ci
cp .env.example .env
npm run doctor
npm run verify
npm start
```

> **Կարևոր.** Օգտագործեք սովորական `npm ci` կամ `npm install`։ `npm ci --omit=optional` մի օգտագործեք, որովհետև `@napi-rs/canvas`-ի platform-specific native binding-ը npm-ում տեղադրվում է optional dependency-ի միջոցով, իսկ chart generator-ը առանց դրա չի մեկնարկի։

Windows PowerShell-ում՝

```powershell
Copy-Item .env.example .env
npm ci
npm run doctor
npm run verify
npm start
```

## Telegram պաշտպանություն

`.env`-ում պարտադիր գրեք միայն թույլատրված user ID-ները։

```env
AUTHORIZED_TELEGRAM_USER_IDS=8182558373
CHAT_ID=8182558373
```

`CHAT_ID`-ի դրական private-chat արժեքը նույնպես ընդունվում է որպես authorized user։ Բացասական group ID-ն երբեք ամբողջ խմբին access չի տալիս։

## Execution modes

### 1. Analysis — անվտանգ default

```env
EXECUTION_MODE=analysis
AUTO_START_TRADING=false
```

AI signal-ները հաշվարկվում են, բայց ոչ paper և ոչ իրական order չի բացվում։

### 2. Paper — ամբողջ autonomous rehearsal

```env
EXECUTION_MODE=paper
PAPER_INITIAL_BALANCE=200
AUTO_START_TRADING=true
CHAT_ID=8182558373
```

Paper broker-ը persistent է․ բացում է LONG/SHORT դիրքեր, ստուգում է TP/SL-ը փակ candle-ներով, հաշվարկում fees/funding-ը և calibration-ին փոխանցում փակ trade-երը։

### 3. Live — միայն երկար paper validation-ից հետո

```env
EXECUTION_MODE=live
BYBIT_MODE=rw
BYBIT_MARKET_TYPE=swap
BYBIT_API_KEY_RW=...
BYBIT_API_SECRET_RW=...
LIVE_TRADING_ACK=I_ACCEPT_REAL_LOSS
AUTO_START_TRADING=false
```

Սկզբում `AUTO_START_TRADING=false` պահեք և օգտագործեք փոքր, առանձնացված balance։ Live mode-ը fail-closed է, եթե չկա balance, positions, daily PnL, ticker, AI ensemble կամ verified TP/SL։

## Daily target behavior

Default՝

```env
DAILY_SOFT_TARGET_PCT=2
DAILY_HARD_TARGET_PCT=5
SOFT_TARGET_RISK_MULTIPLIER=0.50
SOFT_TARGET_MAX_LEVERAGE=2
```

- Մինչև +2%՝ սովորական risk gate-երը։
- +2%-ից +5%՝ risk budget-ը կիսվում է, leverage-ը սահմանափակվում է առավելագույնը 2x։
- +5%-ից հետո՝ նոր position չի բացվում մինչև `Asia/Yerevan`-ի հաջորդ օրը։
- Օրական loss limit-ի կամ weekly drawdown-ի դեպքում՝ նոր position-ները block են լինում։
- Թիրախները հաշվվում են realized closed PnL-ից։ Բաց դիրքերը կարող են փոխել equity-ն, ուստի intraday equity drawdown-ը նույնպես առանձին gate է։

## Default risk profile

```env
RISK_PER_TRADE_PCT=0.30
MAX_RISK_PER_TRADE_PCT=0.50
MAX_DAILY_LOSS_PCT=2
MAX_DAILY_GROSS_LOSS_PCT=3
MAX_WEEKLY_DRAWDOWN_PCT=6
MAX_CONSECUTIVE_LOSSES=2
MAX_TRADES_PER_DAY=4
MAX_OPEN_POSITIONS=2
MAX_PORTFOLIO_EXPOSURE_PCT=30
MAX_SYMBOL_EXPOSURE_PCT=12
MAX_MARGIN_PER_TRADE_PCT=8
AI_LEVERAGE_OPTIONS=1,2,3,5
MAX_AI_LEVERAGE=5
```

Leverage-ը position risk չէ․ risk-ը սահմանվում է entry–SL distance-ով և position size-ով։ AI-ն չի կարող hard cap-ից բարձրացնել leverage-ը։

## Profitability validation

Միացրեք live mode միայն այն դեպքում, երբ paper/walk-forward արդյունքները բավարար են, օրինակ՝

- առնվազն 300–500 փակ trade,
- net expectancy > 0 fees/funding-ից հետո,
- profit factor > 1,
- ընդունելի maximum drawdown,
- bull/bear/range պայմաններում առանձին դրական կամ հասկանալի արդյունքներ,
- confidence bucket-ների իրական calibration,
- որևէ մեկ coin կամ կարճ շրջան ընդհանուր PnL-ի մեծ մասը չի ստեղծում։

Այս թվերը ապացույցի շեմեր են, ոչ շահույթի երաշխիք։

## Հիմնական ֆայլեր

- `src/ultimate_ai_trader.js` — AI ensemble և decision pipeline
- `src/execution_guard.js` — վերջին deterministic preflight
- `src/risk_manager.js` — persistent circuit breakers
- `src/money_manager.js` — stop-based sizing և leverage downgrade
- `src/order_manager.js` — live fill/protection/recovery lifecycle
- `src/paper_broker.js` — persistent paper execution
- `src/trade_journal.js` — signal/pending/open/closed audit state
- `src/signal_calibrator.js` — historical confidence calibration
- `src/backtest.js` — LONG/SHORT, next-bar, intrabar worst-case engine
- `src/telegram_auth.js` — Telegram user allowlist
- `src/startup_diagnostics.js` — startup doctor

## Օգտակար հրամաններ

```bash
npm run doctor   # config/dependency/path/security diagnostics
npm run check    # static source checks
npm test         # isolated runtime tests
npm run verify   # check + tests
npm start        # Telegram bot
```

Մանրամասները՝ `V16_ARCHITECTURE.md`, `V15_AUDIT.md`, `MIGRATION_V15_TO_V16.md`, `SECURITY.md`, `TEST_REPORT.md`։
