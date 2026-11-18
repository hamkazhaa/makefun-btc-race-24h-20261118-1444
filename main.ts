// BTC trading bot for make.fun competition btc-race-24h-20261118-1444:
// it trades Coinbase Wrapped BTC (CBBTC) against USDC on one-minute bars,
// long only, from $1,000 of paper money.
//
// Strategy — slow trend with momentum confirmation, a trailing stop, and
// a partial take-profit that banks most of a big run near its top:
//   * Trend: SMA(30) above SMA(240) of the 1-minute closes (a 30m vs 4h
//     trend). No trend, no trade: in a downtrend the bot sits in cash.
//   * Entry: only when the trend is up AND the 60-minute return is above
//     +0.10% (the move is real and fresh, not a dead-cat bounce).
//   * Size: the whole cash balance (one position, long only, 100% weight).
//   * Take-profit: once the unrealised gain from the entry close reaches
//     +1.80%, sell 75% of the position. The remaining 25% keeps trailing,
//     so the bot never re-enters while the trend is still up — a full exit
//     here would be re-bought at once on the same signals and bled away in
//     fees (measured: selling 100% at the take turns +$11.55 into +$0.73).
//   * Exit: a trailing stop 0.70% below the highest close since entry, or
//     the trend flipping down (SMA(30) below SMA(240)).
//   * Guard: if equity ever falls 5% below its peak, liquidate and stay flat
//     until the trend flips down and back up again.
// Everything is a pure function of the closes seen so far: no wall clock,
// no environment, no randomness. Two runs on the same data give the same
// orders, byte for byte.
//
// On the dev window this makes +$11.55 net (5 fills, max drawdown 0.75%)
// after every fee, slippage and price impact; the submitted v1 bot made
// +$5.35 there, and buy-and-hold loses $31.63. Dev-window trades (local
// grade, byte-for-byte reproduced on regrade):
//   05:41 BUY  @ 64,016.30  ->  08:28 SELL 75% @ 65,078.44 (take +1.80%)
//                          ->  09:40 SELL 25% @ 64,666.26 (trail)
//   14:35 BUY  @ 64,678.16  ->  18:53 SELL @ 64,559.38 (trend flip)
// Per-6h-block PnL: -1.68 / +15.92 / -0.67 / -2.02 — the money is the one
// clean morning rally; the afternoon trade still loses $2.66 and every
// entry filter tried (trend alignment, 4h-return, slope, flip-freshness,
// whipsaw cooldown, range, extension) either also blocked the good trade
// or only delayed the bad one, so it stays in. The take-profit level is
// the tuned part, reported honestly: +140bps -> +$8.01, +150 -> +$8.53,
// +160 -> +$9.82, +170 -> +$10.17, +180 -> +$11.55, +190 -> +$11.55,
// +200 -> +$6.13 (never fires — the rally peaked at +190bps from the
// entry close). The whole 140-190 band beats the no-take bot (+$6.13),
// so the mechanism (bank part of a big gain) is not a knife-edge fit,
// but the exact level is fitted to this window's peak and the race
// window's peak is unseen. Rejected by the same data: momentum-reversal
// exits (re-entry churn, -$26 to -$49), breakeven/time exits (same churn),
// fast-breakout entries (-$10 to -$20), V-bottom dip-buys (lose or block
// the trend entry through the single-position slot), tighter trails after
// the take (same re-entry churn), faster SMAs (F15/F20 lose $1-10).

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST = 30; // 30-minute SMA
const SLOW = 240; // 4-hour SMA
const MOMENTUM_BARS = 60; // 60-minute return for entry confirmation
const ENTRY_MOMENTUM_BPS = 10; // +0.10%
const TRAIL_BPS = 70; // 0.70% trailing stop
const TAKE_PROFIT_BPS = 180; // +1.80% unrealised gain from the entry close
const TAKE_FRACTION_NUM = 3n; // sell 3/4 of the position at the take-profit
const TAKE_FRACTION_DEN = 4n;
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
let entryClose = 0;
let tookProfit = false;

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

    // SMA(30) and SMA(240) over the closes seen so far.
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
      tookProfit = false;
      return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (guardLocked) {
      if (!trendUp) guardLocked = false;
      return [];
    }

    if (heldQty > 0n) {
      // In a position: trail the highest close since entry.
      if (close > trailPeak) trailPeak = close;
      // Take-profit first: bank 3/4 once the gain from the entry close
      // reaches +1.80%. The remainder keeps trailing from the same peak,
      // and the bot cannot re-enter while it still holds it.
      if (!tookProfit && entryClose > 0) {
        const gainBps = Math.floor((close / entryClose - 1) * 10000);
        if (gainBps >= TAKE_PROFIT_BPS) {
          tookProfit = true;
          const sellQty = (heldQty * TAKE_FRACTION_NUM) / TAKE_FRACTION_DEN;
          if (sellQty > 0n) {
            return [{ side: 'sell', symbol: SYMBOL, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      }
      const stop = (trailPeak * (10000 - TRAIL_BPS)) / 10000;
      if (close < stop || !trendUp) {
        trailPeak = 0;
        tookProfit = false;
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
        entryClose = close;
        tookProfit = false;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
