# V16 Architecture

```text
Closed Bybit candles
        ↓
Technical pre-scan + patterns
        ↓  minimum score / one finalist per coin
Claude review + DeepSeek review
        ↓
AI judge + strict schema validation
        ↓
Historical calibration + execution score
        ↓
Money manager (SL-based size, fees, margin, max 5x)
        ↓
Deterministic execution guard
        ↓
Fresh balance + positions + ticker + market rules
        ↓
Per-symbol mutex + idempotent client order ID
        ↓
ORDER_SUBMITTED persistent journal
        ↓
Fill confirmation / late-fill recovery
        ↓
Position-level TP/SL set + verify
        ↓
Bybit / persistent paper broker
        ↓
Closed-PnL reconciliation
        ↓
Risk state + calibration + DB + audit journal
```

## Sources of truth

- **Live positions/orders/PnL:** Bybit private API։
- **Paper positions/PnL:** `paper_broker` persistent state։
- **Execution intent/audit:** NDJSON + `trade_journal_state.json`։
- **Daily/weekly circuit state:** `risk_state.json`։
- **Calibration:** `signal_calibration.json`։
- **Reporting/query cache:** SQLite database։

SQLite-ը authoritative exchange state չէ։ API outage-ի դեպքում local DB-ից «position չկա» եզրակացություն չի արվում։

## Failure policy

- Missing/invalid AI output → HOLD։
- Incomplete required ensemble → block։
- Invalid SL/TP/RR → block։
- Missing balance/positions/ticker → live block։
- Stale signal or excessive spread/drift → block։
- Fill uncertain → critical state, no automatic duplicate retry։
- Protection not verified → emergency close attempt + critical stop։
- Restart with pending order → exchange reconciliation and late-fill recovery։
- Unmanaged unprotected external position → new entries blocked; position is not silently closed։

## Autonomy boundaries

V16 ինքնուրույն կարող է scan, analyze, size, execute, protect, reconcile և pause անել։ Այն չի կարող՝

- երաշխավորել շահույթ,
- որոշել, որ API outage-ի դատարկ պատասխանը իրական «no positions» է,
- գաղտնի կերպով բարձրացնել leverage-ը,
- թույլ trade բացել daily target-ը լրացնելու համար,
- անվտանգ հայտարարել live logic-ը առանց իրական API credentials-ով validation-ի։
