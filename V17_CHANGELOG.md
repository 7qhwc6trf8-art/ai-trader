# V17 Final Fixed

## Execution fixes

- Claude direct request contains no `temperature`, `top_p`, or `top_k`.
- Incomplete Claude + DeepSeek ensembles become HOLD before leverage evaluation.
- Provider disagreement can be resolved only by a successful final judge with configurable minimum confidence.
- Unresolved disagreement becomes HOLD, not an `AI leverage rejected` message.
- Judge-resolved disagreement is capped at 1x leverage.
- Stop distance up to 3% allows up to 5x; 4.5% up to 3x; 6% up to 2x; 6-10% only 1x.
- Stops above 10% remain blocked by the hard safety cap.
- Position size remains risk-based, so a wide stop automatically reduces quantity.

## New environment values

```env
ALLOW_JUDGE_RESOLUTION=true
MIN_JUDGE_RESOLUTION_CONFIDENCE=82
MAX_WIDE_STOP_DISTANCE_PCT=10
```

## Verified scenario

A 9.59% stop with an otherwise valid 5x request is downgraded to 1x instead of being rejected.
