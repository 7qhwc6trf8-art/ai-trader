# Ինչ էի բաց թողել V15-ում

Սա V15-ի նկատմամբ ուղիղ և ամբողջական audit-ն է։ V15-ը օգտակար քայլ էր, բայց այն դեռ production/autonomous build չէր։

## 1. Artifact-ը ամբողջությամբ runnable չէր

`package.json`-ից բացակայում էին runtime dependency-ներ՝ `ccxt`, `ws`, canvas backend, SQLite backend, `node-cache`, Anthropic SDK։ `node --check`-ը դա չէր բացահայտում, որովհետև այն չի կատարում module resolution կամ native binding load։

## 2. Syntax check-ը սխալմամբ ներկայացվել էր որպես ամբողջական test

V15-ում իրական module-import, runtime և integration test-եր չկային։ Ավելի ուշ import test-ը բռնեց `startupDiagnostic is not defined` runtime bug-ը։ Logger-ը uncaught exception-ը log էր անում, բայց process-ը չէր կանգնեցնում, ինչի պատճառով test child-ը կարող էր կեղծ PASS տալ։

## 3. Հին 100x տրամաբանությունը դեռ մնացել էր

Թեև որոշ տեղերում leverage-ը սահմանափակվել էր, 100x-ի հին mapping/prompt/config fragment-ներ դեռ կային այլ ֆայլերում։ V16 static checker-ը ամբողջ source tree-ում արգելում է ավտոմատ `10x/100x` tier-երը։

## 4. `checkDailyLoss()` կանչ կար, մեթոդ չկար

`bot.js`-ը կարող էր runtime-ում կանչել գոյություն չունեցող մեթոդը և կանգնեցնել autonomous scan-ը։

## 5. Calibration-ը իրականում չէր սովորում

V15-ը calibration score էր կարդում, բայց փակ live/paper trade-երը reliably և idempotently չէին փոխանցվում calibrator-ին։ LLM-ի self-reported confidence-ը շարունակում էր չափազանց մեծ դեր ունենալ։

## 6. Journal-ը signal-ը և բաց position-ը խառնում էր

Նույն `openByCoin` state-ը պահում էր և՛ վերջին signal-ը, և՛ իրական position-ը։ Բաց position-ի ընթացքում նոր blocked signal-ը կարող էր overwrite անել trade-ի սկզբնական signal-ը և սխալ bucket-ի մեջ գրանցել outcome-ը։

## 7. AI invalid SL/TP-ն լուռ փոխարինվում էր

Սխալ կամ բացակայող SL/TP-ի դեպքում համակարգը կարող էր հորինել fixed 3%/6% plan։ Դա ստեղծում էր trade, որը AI-ն իրականում չէր հաստատել։ V16-ը invalid plan-ի դեպքում վերադարձնում է HOLD և block։

## 8. Signal freshness-ը հաշվվում էր candle open time-ից

15m/1h/4h candle timestamp-ը սովորաբար candle-ի բացման ժամանակն է։ Այն signal timestamp համարելու պատճառով նոր AI որոշումը կարող էր անմիջապես համարվել stale։ V16-ը օգտագործում է decision-generation time, իսկ source candle time-ը պահում է առանձին audit field-ում։

## 9. Չփակված candle և սխալ «24h change»

Վերջին դեռ ձևավորվող candle-ը կարող էր մտնել analysis-ի մեջ։ Բացի այդ, «24h change»-ը բոլոր timeframe-ներում հաշվվում էր 24 candle-ով, ինչը 15m-ում 6 ժամ էր, 4h-ում՝ 96 ժամ, 1d-ում՝ 24 օր։

## 10. Backtest/live parity չկար

Սկզբնական backtest-ը միայն LONG էր, SELL-ը position close էր, TP/SL-ը ստուգվում էր close price-ով, և next-bar execution չկար։ Դա ստեղծում էր lookahead/intrabar սխալներ և չէր ներկայացնում futures live logic-ը։

## 11. Paper mode-ը իրական paper broker չէր

Signal էր հաշվվում, բայց persistent position lifecycle, TP/SL close, fees/funding, daily PnL reconciliation և calibration update ամբողջությամբ չէին աշխատում։

## 12. Cooldown-ը restart-ից հետո կորչում էր

Per-coin cooldown-ը հիշողության մեջ էր։ Restart-ը կարող էր անմիջապես նույն coin-ի նոր trade թույլ տալ։

## 13. Closed trade idempotency-ն բավարար չէր

`tradeId`-ը database-ում unique չէր, և նույն exchange record-ը հնարավոր էր կրկնակի գրանցել՝ PnL/calibration/risk counters-ը կրկնապատկելով։

## 14. Bybit empty result-ը երբեմն համարվում էր «positions չկան»

Positions API failure-ը դատարկ array էր վերադարձնում։ Reconciliation-ը նույնիսկ կարող էր local բաց positions-ը փակված նշել կամ duplicate guard-ը շրջանցել։ V16-ը պահում է `lastPositionsError` և նման դեպքում ամբողջ execution-ը fail-closed է։

## 15. Fresh ticker/bid/ask-ի բացակայությունը hard block չէր

Live execution-ը կարող էր շարունակել առանց հաստատված current price կամ spread-ի։ V16 live preflight-ը պահանջում է fresh last/bid/ask։

## 16. Order accepted, fill uncertain վիճակը persistent չէր

Եթե Bybit-ը order-ը ընդուներ, բայց fill lookup-ը ուշանար, restart-ից հետո bot-ը չէր հիշի նախատեսված SL/TP-ն։ V16 journal-ը պահում է `ORDER_SUBMITTED` pending intent և կարող է late fill-ը գտնել, protect անել և վերականգնել։

## 17. Scheduled reconciliation-ը protection integrity չէր վերահաստատում

V15-ը հիմնականում DB–exchange presence էր համեմատում։ V16-ը նաև ստուգում/վերականգնում է expected TP/SL-ը և block է անում նոր entries-ը critical inconsistency-ի դեպքում։

## 18. Telegram access control չկար

Bot-ին հասնող ցանկացած user կարող էր command-ներ ուղարկել, account տվյալներ տեսնել կամ auto-trade control անել։ V16-ը պահանջում է explicit Telegram user allowlist։

## 19. Import side effects կային

`require('./bot')`-ը կարող էր startup diagnostics, network, cron կամ signal handlers ակտիվացնել։ Դա testability-ն և service composition-ը կոտրում էր։ V16-ը launch-ը կատարում է միայն main entrypoint-ում։

## 20. Fatal process errors-ը կարող էին swallow լինել

Uncaught exception-ից հետո process-ը շարունակելը trading service-ի համար անվտանգ չէ։ V16 default-ով log է անում և non-zero exit-ով կանգնում, որպեսզի process manager-ը clean restart անի։

## 21. AI rate-limit/backoff circuit չկար

Provider outage/429-ի դեպքում յուրաքանչյուր finalist կարող էր կրկին նույն թանկ call-ը կատարել։ V16-ն ունի bounded retries, `Retry-After` support և provider circuit breaker։

## 22. Scan budget-ը վատ էր օգտագործվում

Նույն coin-ը մեկ sweep-ում մի քանի timeframe-ով կարող էր մտնել AI finalists, իսկ շատ թույլ candidate-ներն էլ օգտագործում էին API budget-ը։ V16-ը default-ով ընտրում է մեկ finalist/coin և պահանջում է minimum pre-scan score։

## 23. Daily loss-ը միայն realized PnL-ով էր

Բաց position-ի մեծ unrealized loss-ը կարող էր չմտնել daily gate-ի մեջ։ V16-ը նաև համեմատում է current equity-ն day-start equity-ի հետ։

## 24. Daily hard target scheduler-ը կարող էր չվերականգնվել

Եթե scheduler-ը ամբողջությամբ կանգնեցվեր +5%-ից հետո, հաջորդ օրը bot-ը չէր վերսկսի առանց restart-ի։ V16 loop-ը կենդանի է պահում և նոր Yerevan օրը ավտոմատ reset/resume է անում։

## 25. Model output contract-ը բավարար խիստ չէր

Claude-ի համար schema-enforced structured output չկար, իսկ DeepSeek empty/invalid final content-ի recovery-ն սահմանափակ էր։ V16-ը Claude JSON schema և DeepSeek bounded recovery sequence է օգտագործում։

## 26. «2%-ից ոչ պակաս» ձևակերպումը չէր կարելի իրականացնել

Սա կոդային բացթողում չէ, այլ պահանջի սահմանափակում։ Ոչ մի bot չի կարող օրական minimum profit երաշխավորել առանց անսահման risk-ի։ V16-ը 2%-ը օգտագործում է որպես profit-lock threshold, ոչ trade forcing rule։
