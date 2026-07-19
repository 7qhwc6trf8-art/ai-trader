# V18 Full Fixed

- Fixed candlestick open-price index (`c[1]`, not timestamp `c[0]`).
- Clamped every pattern confidence/strength to 0..100.
- Clamped weighted internal pattern strengths to 0..100.
- Added Claude retry/backoff for network, timeout, 429 and 5xx failures.
- Added portfolio-capacity precheck before expensive AI calls.
- Added per-coin repeated HOLD deduplication and configurable cooldown.
- Added environment controls for retry, timeout, HOLD notifications and AI skip behavior.
