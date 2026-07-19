# V16 Test Report

Generated: 2026-07-19

## Automated verification

```text
Static source files checked: 43
Runtime test files passed: 16
```

Coverage includes՝

- strict AI fail-closed validation,
- Claude JSON-schema request contract,
- DeepSeek 429 retry/recovery contract,
- LONG/SHORT backtest,
- next-bar entry and worst-case intrabar TP/SL,
- configuration hard caps,
- database idempotency/upsert,
- execution score, RR, spread, drift, stale and exposure gates,
- per-symbol mutex,
- pre-scan threshold and one finalist per coin,
- leverage downgrade and stop-based sizing,
- order fill/protection retry,
- positions API outage safety,
- persistent pending-order late-fill recovery,
- persistent paper broker open/close/PnL,
- persistent cooldown and daily circuit breaker,
- intraday equity drawdown gate,
- startup dependency/path/security diagnostics,
- Telegram allowlist,
- journal signal/open/pending separation։

## Commands used

```bash
npm run check
npm test
npm run verify
```

## Clean-install reproducibility

Փորձարկվել է առանձին դատարկ պատճենում՝ առանց նախնական `node_modules`-ի կամ runtime data-ի.

```bash
npm ci --no-audit --no-fund
npm run verify
```

Արդյունք՝ 76 package տեղադրվել է, 43 source file-ի static verification-ը և բոլոր 16 runtime test-երը անցել են։ `--omit=optional` տարբերակը դիտավորյալ չի աջակցվում chart backend-ի platform binding-ի պատճառով։

## Not claimed as tested

Այս environment-ում չեն կատարվել՝

- իրական Claude API request,
- իրական DeepSeek API request,
- իրական Telegram network launch,
- իրական Bybit authentication,
- Bybit demo/live order submission,
- exchange-side TP/SL confirmation իրական account-ում,
- երկարաժամկետ profitability validation։

AI provider tests-ը mock contract tests են, իսկ order tests-ը deterministic mocked exchange integration tests են։ Live օգտագործումից առաջ պարտադիր կատարեք փոքր demo/isolated-account smoke test։
