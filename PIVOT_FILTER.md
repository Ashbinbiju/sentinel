# Pivot confluence filter (R1 / S1)

Adds a second confirmation level to the two breakout setups. A breakout must now clear the
standard pivot as well as the previous day's extreme.

## Rule

Standard ("Traditional") floor pivots from the previous session's High/Low/Close:

```
P  = (PDH + PDL + PDC) / 3
R1 = 2P − PDL
S1 = 2P − PDH
```

| Setup | Was | Now also requires |
|---|---|---|
| HIGH BREAKOUT (long) | `close > PDH` | `close > R1` |
| LOW BREAKDOWN (short) | `close < PDL` | `close < S1` |

The two fade setups — HIGH REJECTION and LOW SUPPORT — are **untouched**. They enter *at* a level
rather than beyond it, so pivot confluence does not apply to them.

## Config

`USE_PIVOT_FILTER` (env). Defaults to **on**; set `USE_PIVOT_FILTER=false` to restore the previous
PDH/PDL-only behaviour without a code change.

## New reject reasons

| Code | Meaning |
|---|---|
| `BELOW_R1` | Breakout candle closed above PDH but not above R1 |
| `ABOVE_S1` | Breakdown candle closed below PDL but not below S1 |
| `PIVOT_UNAVAILABLE` | No previous close for the symbol — see "fail closed" below |

The `[ENGINE] EVALUATING` log line now prints `R1=` and `S1=` alongside `PDH=` / `PDL=`.

## Files changed

| File | Change |
|---|---|
| `artifacts/auto-trader/src/engine.ts` | `standardPivots()` helper, `USE_PIVOT_FILTER` flag, `prevClose` on `WatchlistContext`, the two filter checks, pivot values in the evaluation log |
| `artifacts/auto-trader/src/index.ts` | `getDailyWatchlist()` now derives `prevClose` from the last candle of the previous session and puts it on the context |
| `artifacts/api-server/src/backtest.ts` | Same filter mirrored so backtests stay comparable to live |

No database migration. `prevClose` lives only on the in-memory watchlist context; the
`watchlist_snapshots` table is unchanged, and `backtest.ts` recomputes pivots from candles.

## Fail-closed behaviour

If `prevClose` is missing or non-finite, the engine **rejects** the setup with `PIVOT_UNAVAILABLE`
rather than falling through to the old behaviour. Reasoning: a filter whose job is to remove trades
should not silently stop removing them when its input goes missing. The trade-off is that a data
outage means no breakout entries, which shows up loudly in the logs.

`getDailyWatchlist()` also warns at watchlist-build time if a symbol has no previous close, so the
problem surfaces before the first candle is evaluated.

## Verification

```bash
pnpm run typecheck
```

`auto-trader` and `api-server` both typecheck clean with these changes.

Before going live, run `backtest.ts` with `USE_PIVOT_FILTER=false` and `=true` over the same
`watchlist_snapshots` date and compare trade counts and P&L. The filter only ever removes trades,
so expect fewer entries — the question is whether the ones it removes were net losers.

## Not covered

These files carry their own **duplicated copies** of the entry rules and have *not* been updated:

- `artifacts/auto-trader/src/backtest-single.ts`
- `artifacts/auto-trader/src/backtest-today.ts`
- `scripts/backtest-today.ts`

They are ad-hoc analysis scripts, not the live path, but they will now disagree with the engine.
Worth consolidating the shared rule set into one module.
