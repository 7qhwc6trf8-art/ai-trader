# Migration from V15 to V16

## 1. Backup

Պահպանեք հին `.env`, database-ը և logs-ը առանձին։ ZIP-ի մեջ իրական secret մի դրեք։

## 2. Fresh install

```bash
npm install
cp .env.example .env
```

Հին `node_modules`-ը մի տեղափոխեք։

## 3. Configure Telegram allowlist

```env
TELEGRAM_TOKEN=...
AUTHORIZED_TELEGRAM_USER_IDS=YOUR_USER_ID
CHAT_ID=YOUR_PRIVATE_CHAT_ID
```

## 4. Start in analysis

```env
EXECUTION_MODE=analysis
AUTO_START_TRADING=false
```

```bash
npm run doctor
npm run verify
npm start
```

## 5. Paper mode

```env
EXECUTION_MODE=paper
PAPER_INITIAL_BALANCE=200
AUTO_START_TRADING=true
```

Paper test-ը շարունակեք այնքան, մինչև calibration buckets-ը բավարար sample ունենան և walk-forward արդյունքները դրական լինեն։

## 6. Live mode

V15-ի live env-ը կուրորեն մի copy արեք։ V16-ը պահանջում է՝

```env
EXECUTION_MODE=live
BYBIT_MODE=rw
BYBIT_MARKET_TYPE=swap
LIVE_TRADING_ACK=I_ACCEPT_REAL_LOSS
```

Առաջին live փուլում պահեք՝

```env
AUTO_START_TRADING=false
MAX_OPEN_POSITIONS=1
MAX_TRADES_PER_DAY=1
RISK_PER_TRADE_PCT=0.10
MAX_AI_LEVERAGE=1
```

Միայն իրական order lifecycle-ը, TP/SL-ը և reconciliation-ը ձեռքով հաստատելուց հետո բարձրացրեք default safe profile-ին։

## 7. Old state files

V16-ը որոշ state-եր migrate է անում, բայց ամենաապահով տարբերակը paper mode-ի համար clean `data/` directory-ից սկսելն է։ Live account-ի իրական positions-ը երբեք մի ջնջեք/անտեսեք․ նախ ստուգեք Bybit UI-ն։
