# Security

- `.env`-ը երբեք մի commit արեք։
- Եթե key-ը հայտնվել է Git history-ում, միայն ֆայլից ջնջելը բավարար չէ․ revoke/rotate արեք key-ը և մաքրեք history-ն։
- Bybit live key-ին տվեք միայն անհրաժեշտ trade permission-ները։ Withdrawal permission մի տվեք։
- Օգտագործեք IP allowlist, եթե server IP-ն կայուն է։
- Telegram bot-ը սահմանափակեք `AUTHORIZED_TELEGRAM_USER_IDS`-ով։
- Production service-ը գործարկեք առանձին low-privilege OS user-ով։
- Պաշտպանեք `data/`, `logs/`, `trading.db` և backups-ը։ Դրանք պարունակում են account/trade metadata։
- `SHUTDOWN_ON_FATAL=true` պահեք և օգտագործեք systemd/PM2/Docker restart policy։
- Live account-ում manual և bot positions մի խառնեք։ Unmanaged unprotected position-ը V16-ը չի փակի լուռ, բայց block կանի նոր entries-ը։
- Demo/test account-ը նույնպես իրական secret է․ այն մի հրապարակեք։
