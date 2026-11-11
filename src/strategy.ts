/**
 * The "5 EMA" strategy (as popularised by Subashish Pani / Power of Stocks), on the INDEX chart.
 *
 *   Sell side (you buy a PE) — 5-minute chart:
 *     alert candle  = a completed candle entirely ABOVE the 5 EMA (its low > EMA)
 *     entry         = a later candle trades BELOW the alert candle's low
 *     stop          = alert candle's high
 *   Buy side (you buy a CE) — 15-minute chart:
 *     alert candle  = a completed candle entirely BELOW the 5 EMA (its high < EMA)
 *     entry         = a later candle trades ABOVE the alert candle's high
 *     stop          = alert candle's low
 *   Target = 3 × risk (1:3). A newer qualifying candle replaces the alert candle.
 *
 * Pure functions only: easy to test, used by the backtester (and later the live alerts).
 */

export interface Candle {
  /** start time, epoch ms */
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type OptionSide = "CE" | "PE";

const IST = 330 * 60_000;
const SESSION_START_MIN = 9 * 60 + 15;

/** EMA seeded with the SMA of the first n values (TradingView-style). NaN until seeded. */
export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** IST minutes since midnight. */
export const istMin = (ms: number) => {
  const d = new Date(ms + IST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
/** IST YYYY-MM-DD. */
export const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

/**
 * Builds N-minute candles from 1-minute candles, aligned to the 09:15 session open
 * (09:15, 09:20, ... for 5-min; 09:15, 09:30, ... for 15-min), never crossing days.
 */
export function aggregate(oneMin: Candle[], minutes: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | undefined;
  let curKey = "";
  for (const m of oneMin) {
    const bucket = Math.floor((istMin(m.ts) - SESSION_START_MIN) / minutes);
    const key = `${istDay(m.ts)}#${bucket}`;
    if (key !== curKey) {
      if (cur) out.push(cur);
      const startMin = SESSION_START_MIN + bucket * minutes;
      const dayStart = m.ts - istMin(m.ts) * 60_000 - (new Date(m.ts + IST).getUTCSeconds() * 1000);
      cur = { ts: dayStart + startMin * 60_000, o: m.o, h: m.h, l: m.l, c: m.c };
      curKey = key;
    } else {
      cur!.h = Math.max(cur!.h, m.h);
      cur!.l = Math.min(cur!.l, m.l);
      cur!.c = m.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface Alert {
  side: OptionSide;
  candle: Candle;
  ema: number;
  /** time the alert candle closed (it is only usable after this) */
  readyAt: number;
}

/** Is this completed candle an alert candle? (PE: fully above EMA; CE: fully below.) */
export function alertFor(side: OptionSide, c: Candle, emaValue: number): boolean {
  if (!Number.isFinite(emaValue)) return false;
  return side === "PE" ? c.l > emaValue : c.h < emaValue;
}

export interface Entry {
  side: OptionSide;
  /** index price we got in at */
  entry: number;
  /** index stop (alert candle high for PE, low for CE) */
  sl: number;
  /** index target (1:R) */
  target: number;
  /** index points at risk */
  riskPts: number;
  alert: Alert;
}

/**
 * Does this 1-minute candle trigger the alert? Returns the entry, filled at the alert
 * level, or at the open if the candle gapped through it.
 */
export function trigger(a: Alert, m: Candle, rr: number): Entry | undefined {
  if (a.side === "PE") {
    if (!(m.l < a.candle.l)) return undefined;
    const entry = Math.min(m.o, a.candle.l);
    const sl = a.candle.h;
    const riskPts = sl - entry;
    return { side: "PE", entry, sl, target: entry - rr * riskPts, riskPts, alert: a };
  }
  if (!(m.h > a.candle.h)) return undefined;
  const entry = Math.max(m.o, a.candle.h);
  const sl = a.candle.l;
  const riskPts = entry - sl;
  return { side: "CE", entry, sl, target: entry + rr * riskPts, riskPts, alert: a };
}
