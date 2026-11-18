[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/hamkazhaa/makefun-btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/hamkazhaa/makefun-btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

# BTC trend bot — btc-race-24h-20261118-1444

A deterministic BTC trading bot for [make.fun's "Race a BTC trading bot live for 24 hours"](https://make.fun/bounty/btc-race-24h-20261118-1444). It trades Coinbase Wrapped BTC (CBBTC) against USDC on one-minute bars, long only, from $1,000 of paper money.

## Strategy

Slow trend with momentum confirmation and a trailing stop:

- **Trend:** SMA(60) above SMA(240) of the 1-minute closes (1h vs 4h trend). No trend, no trade — in a downtrend the bot sits in cash.
- **Entry:** only when the trend is up AND the 60-minute return is above +0.10%, so the move is real and fresh, not a dead-cat bounce.
- **Size:** the whole cash balance (one position, long only, 100% weight).
- **Exit:** a trailing stop 0.70% below the highest close since entry, or the trend flipping down.
- **Guard:** if equity ever falls 5% below its peak, liquidate and stay flat until the trend flips down and back up again.

Everything is a pure function of the closes seen so far: no wall clock, no environment, no randomness. Two runs on the same data give the same orders, byte for byte (the local grade's L1 regrade reproduced the action log byte for byte).

## Dev-window result

Local grade (`makefun grade-local --driver process`):

- **Net PnL: +$5.35** after every fee, slippage and price impact (even at 2× fees: +$3.75)
- 4 trades, win rate 50%, max drawdown 1.21%, 0 rejected orders
- Guardrails met (trades, symbols, drawdown)

For comparison on the same window, buy-and-hold loses $31.63, the house momentum bot loses $180.66 and the house EMA-cross bot loses $148.16. The window is a choppy downtrend (−2.79% start to end); the bot's profit comes from riding the one clean morning bounce (05:48–09:40, +$8.50) and giving back only $3.15 on a later false trend.

## Files

- `main.ts` — the bot (Node 22 stdlib only, erasable TS). Speaks `agent-fun/bars-replay/v1` via the kit SDK shim.
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied unchanged.
- `work/` — the offline research (Python simulator + strategy search rounds) that produced the strategy.
