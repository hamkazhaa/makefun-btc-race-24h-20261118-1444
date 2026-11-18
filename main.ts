// BTC trading bot for make.fun competition btc-race-24h-20261118-1444:
// it trades Coinbase Wrapped BTC (CBBTC) against USDC on one-minute bars,
// long only, from $1,000 of paper money.
//
// Strategy — slow trend with momentum confirmation and a trailing stop:
//   * Trend: SMA(60) above SMA(240) of the 1-minute closes (a 1h vs 4h trend).
//     No trend, no trade: in a downtrend the bot sits in cash.
//   * Entry: only when the trend is up AND the 60-minute return is above
//     +0.10% (the move is real and fresh, not a dead-cat bounce).
//   * Size: the whole cash balance (one position, long only, 100% weight).
//   * Exit: a trailing stop 0.70% below the highest close since entry, or
//     the trend flipping down (SMA(60) below SMA(240)).
//   * Guard: if equity ever falls 5% below its peak, liquidate and stay flat
//     until the trend flips down and back up again.
// Everything is a pure function of the closes seen so far: no wall clock,
// no environment, no randomness. Two runs on the same data give the same
// orders, byte for byte.
//
// On the dev window this makes +$5.35 net (4 trades, max drawdown 1.21%)
// after every fee, slippage and price impact; buy-and-hold loses $31.63
// there, and the house momentum and EMA-cross bots lose far more.
// Dev-window trades (local grade, byte-for-byte reproduced on regrade):
//   05:48 BUY  @ 64,034.50  ->  09:40 SELL @ 64,630.66  (+$8.50)
//   14:31 BUY  @ 64,609.16  ->  19:06 SELL @ 64,459.03  (-$3.15)
// The 0.70% trail is on a stable plateau: 0.7-1.0% all end positive on the
// dev window, while 0.5% whipsaws (-$8.29) and pure momentum exits re-enter
// too fast. The numbers are not the point — the mechanism is: ride a slow
// trend, demand fresh momentum before entering, and let a trailing stop
// take the bot out when the move dies.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST = 60; // 1-hour SMA
const SLOW = 240; // 4-hour SMA
const MOMENTUM_BARS = 60; // 60-minute return for entry confirmation
const ENTRY_MOMENTUM_BPS = 10; // +0.10%
const TRAIL_BPS = 70; // 0.70% trailing stop
const EQUITY_GUARD_BPS = 500; // 5% peak-to-current equity guard
const MAX_SLIPPAGE_BPS = 500; // 5% — far above any 1-minute move
const BARS_PER_DAY = 1440; // both the dev and the race windows are 24h of 1m bars
const NO_NEW_POSITION_BARS = 30; // do not open in the final 30 bars

// Closes in USDC (float). state.close returns the price at price_scale 5.
function toUsdc(price: bigint): number {
  return Number(price) / 100000;
}

// Bot state, kept between batches. All of it is derived from the bars seen.
const closes: number[] = [];
let lastBarT = -1;
let peakEquity: bigint | undefined;
let guardLocked = false;
let trailPeak = 0;

await runBars({
  onBatch(state) {
    if (state.warmingUp) return [];

    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = toUsdc(BigInt(bar.c));

    // Append this bar's close once (a batch with no CBBTC bar adds none).
    if (bar.t !== lastBarT) {
      closes.push(close);
      lastBarT = bar.t;
      if (closes.length > SLOW + 2) closes.splice(0, closes.length - (SLOW + 2));
    }
    const n = closes.length;
    if (n < SLOW) return [];

    // SMA(60) and SMA(240) over the closes seen so far.
    let fastSum = 0;
    for (let i = n - FAST; i < n; i++) fastSum += closes[i]!;
    let slowSum = 0;
    for (let i = n - SLOW; i < n; i++) slowSum += closes[i]!;
    const trendUp = fastSum / FAST > slowSum / SLOW;

    // 60-minute return, in bps.
    const momentumBps = Math.floor(((closes[n - 1]! / closes[n - 1 - MOMENTUM_BARS]!) - 1) * 10000);

    // Peak equity, for the guard.
    if (peakEquity === undefined || state.equity > peakEquity) peakEquity = state.equity;

    const pos = state.positions.get(SYMBOL);
    const heldQty = pos?.qty ?? 0n;

    // Equity guard: liquidate and lock out until the trend resets.
    if (heldQty > 0n && state.equity < (peakEquity * BigInt(10000 - EQUITY_GUARD_BPS)) / 10000n) {
      guardLocked = true;
      trailPeak = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (guardLocked) {
      if (!trendUp) guardLocked = false;
      return [];
    }

    if (heldQty > 0n) {
      // In a position: trail the highest close since entry.
      if (close > trailPeak) trailPeak = close;
      const stop = (trailPeak * (10000 - TRAIL_BPS)) / 10000;
      if (close < stop || !trendUp) {
        trailPeak = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: enter only on uptrend + fresh momentum, and not in the last bars.
    if (trendUp && momentumBps > ENTRY_MOMENTUM_BPS && state.seq < BARS_PER_DAY - NO_NEW_POSITION_BARS) {
      const room = state.weightRoom(SYMBOL);
      const notional = state.cash < room ? state.cash : room;
      if (notional >= 1000000n) {
        trailPeak = close;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
