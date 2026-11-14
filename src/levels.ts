/**
 * Liquidity levels on the INDEX chart: prices where stop-losses cluster.
 *
 *   PDH / PDL   previous trading day high / low
 *   PWH / PWL   previous trading week high / low
 *   ORH / ORL   today's opening range (09:15–09:30) high / low
 *   SH / SL     unswept 15-min swing highs / lows of the last few days (pivot with k bars each side)
 *   EQH / EQL   two or more swing highs / lows at (almost) the same price: the strongest pools
 *
 * "Unswept" = price has not traded beyond the level since it formed. Once swept, it's no longer liquidity.
 * Pure functions, unit-tested.
 */
import { aggregate, istDay, istMin, type Candle } from "./strategy.js";

export type LevelSide = "high" | "low";

export interface Level {
  name: string;
  price: number;
  side: LevelSide;
  /** higher = more stops likely resting there */
  strength: number;
  /** when the level formed (epoch ms) */
  formedAt: number;
}

export interface LevelOptions {
  swingDays: number;
  swingTimeframeMin: number;
  /** bars each side for a pivot */
  pivotK: number;
  /** equal-highs/lows tolerance as a fraction of price (0.0003 = 0.03%) */
  equalTolerance: number;
}

export const DEFAULT_LEVEL_OPTIONS: LevelOptions = { swingDays: 5, swingTimeframeMin: 15, pivotK: 2, equalTolerance: 0.0003 };

const byDay = (cs: Candle[]) => {
  const m = new Map<string, Candle[]>();
  for (const c of cs) {
    const d = istDay(c.ts);
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(c);
  }
  return m;
};
const hi = (cs: Candle[]) => Math.max(...cs.map((c) => c.h));
const lo = (cs: Candle[]) => Math.min(...cs.map((c) => c.l));

/** ISO week key (Monday date) for an IST day string. */
function weekKey(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Pivot highs/lows: bar i is a swing high if its high is strictly above the k bars on each side. */
export function pivots(bars: Candle[], k: number): { side: LevelSide; bar: Candle; idx: number }[] {
  const out: { side: LevelSide; bar: Candle; idx: number }[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const around = [...bars.slice(i - k, i), ...bars.slice(i + 1, i + k + 1)];
    if (around.every((b) => bars[i].h > b.h)) out.push({ side: "high", bar: bars[i], idx: i });
    if (around.every((b) => bars[i].l < b.l)) out.push({ side: "low", bar: bars[i], idx: i });
  }
  return out;
}

/** Was the level traded beyond by any candle after `from`? */
const sweptAfter = (cs: Candle[], side: LevelSide, price: number, from: number) =>
  cs.some((c) => c.ts > from && (side === "high" ? c.h > price : c.l < price));

/**
 * Levels for `today` from 1-minute history (must include previous days; may include today so far).
 * Only levels still unswept as of the latest candle are returned.
 */
export function computeLevels(oneMin: Candle[], today: string, o: LevelOptions = DEFAULT_LEVEL_OPTIONS): Level[] {
  const days = byDay(oneMin);
  const past = [...days.keys()].filter((d) => d < today).sort();
  const todayCs = days.get(today) ?? [];
  const levels: Level[] = [];
  const add = (name: string, price: number, side: LevelSide, strength: number, formedAt: number) => levels.push({ name, price, side, strength, formedAt });

  const prev = past.at(-1);
  if (prev) {
    const cs = days.get(prev)!;
    add("PDH", hi(cs), "high", 3, cs.at(-1)!.ts);
    add("PDL", lo(cs), "low", 3, cs.at(-1)!.ts);
  }
  const thisWeek = weekKey(today);
  const prevWeekDays = past.filter((d) => weekKey(d) < thisWeek);
  const pw = prevWeekDays.length ? weekKey(prevWeekDays.at(-1)!) : undefined;
  if (pw) {
    const cs = prevWeekDays.filter((d) => weekKey(d) === pw).flatMap((d) => days.get(d)!);
    add("PWH", hi(cs), "high", 4, cs.at(-1)!.ts);
    add("PWL", lo(cs), "low", 4, cs.at(-1)!.ts);
  }
  const or = todayCs.filter((c) => istMin(c.ts) < 9 * 60 + 30);
  if (or.length && todayCs.some((c) => istMin(c.ts) >= 9 * 60 + 30)) {
    add("ORH", hi(or), "high", 2, or.at(-1)!.ts);
    add("ORL", lo(or), "low", 2, or.at(-1)!.ts);
  }

  // Swing pivots over the last few days (+ today so far), on the swing timeframe.
  const swingDays = [...past.slice(-o.swingDays), ...(todayCs.length ? [today] : [])];
  const swingCs = swingDays.flatMap((d) => days.get(d)!);
  const bars = aggregate(swingCs, o.swingTimeframeMin);
  const pv = pivots(bars, o.pivotK).map((p) => ({ ...p, readyAt: bars[p.idx + o.pivotK].ts + o.swingTimeframeMin * 60_000 }));
  // Keep only unswept fixed levels (PDH/PDL/PWH/PWL/ORH/ORL).
  const all = [...days.values()].flat();
  const out: Level[] = levels.filter((l) => !sweptAfter(all, l.side, l.price, l.formedAt));

  // Swing pivots → cluster equal highs/lows FIRST (a second high 0.02 above the first is "equal",
  // not a sweep of it), then keep a cluster only if nothing has traded beyond it since its last pivot.
  for (const side of ["high", "low"] as LevelSide[]) {
    const pts = pv.filter((p) => p.side === side).map((p) => ({ price: side === "high" ? p.bar.h : p.bar.l, readyAt: p.readyAt })).sort((a, b) => a.price - b.price);
    const used = new Set<number>();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const group = pts.map((x, j) => ({ x, j })).filter(({ x, j }) => !used.has(j) && Math.abs(x.price - pts[i].price) <= pts[i].price * o.equalTolerance);
      group.forEach(({ j }) => used.add(j));
      const prices = group.map((g) => g.x.price);
      const price = side === "high" ? Math.max(...prices) : Math.min(...prices);
      const formedAt = Math.max(...group.map((g) => g.x.readyAt));
      if (sweptAfter(all, side, price, formedAt)) continue;
      const n = group.length;
      out.push(n >= 2
        ? { name: side === "high" ? `EQH×${n}` : `EQL×${n}`, price, side, strength: 2 + n, formedAt }
        : { name: side === "high" ? "SH" : "SL", price, side, strength: 1, formedAt });
    }
  }

  // Merge levels that sit on top of each other (keep the strongest, list both names).
  const merged: Level[] = [];
  for (const l of out.sort((a, b) => b.strength - a.strength)) {
    const near = merged.find((m) => m.side === l.side && Math.abs(m.price - l.price) <= l.price * o.equalTolerance);
    if (near) {
      if (!near.name.split("+").includes(l.name)) near.name += `+${l.name}`;
      near.strength += 1;
    } else merged.push({ ...l });
  }
  return merged.sort((a, b) => b.price - a.price);
}

export type SweepKind = "swept" | "reclaimed";

export interface SweepEvent {
  kind: SweepKind;
  level: Level;
  /** extreme price beyond the level (swept) or the closing price back inside (reclaimed) */
  price: number;
  at: number;
}

/**
 * Sweep detection on today's candles:
 *   swept     = price traded beyond the level
 *   reclaimed = after the sweep, a completed 5-min candle CLOSED back inside (the classic "liquidity grab")
 */
export function detectSweeps(levels: Level[], todayOneMin: Candle[], now: number): SweepEvent[] {
  const ev: SweepEvent[] = [];
  const five = aggregate(todayOneMin, 5).filter((b) => b.ts + 5 * 60_000 <= now);
  for (const l of levels) {
    const beyond = todayOneMin.find((c) => c.ts >= l.formedAt && (l.side === "high" ? c.h > l.price : c.l < l.price));
    if (!beyond) continue;
    const ext = l.side === "high" ? Math.max(...todayOneMin.filter((c) => c.ts >= beyond.ts).map((c) => c.h)) : Math.min(...todayOneMin.filter((c) => c.ts >= beyond.ts).map((c) => c.l));
    ev.push({ kind: "swept", level: l, price: ext, at: beyond.ts });
    // The sweep's own 5-min candle, or the next one, must CLOSE back inside the level.
    const i = five.findIndex((b) => b.ts <= beyond.ts && beyond.ts < b.ts + 5 * 60_000);
    const back = (i >= 0 ? five.slice(i, i + 2) : []).find((b) => (l.side === "high" ? b.c < l.price : b.c > l.price));
    if (back) ev.push({ kind: "reclaimed", level: l, price: back.c, at: back.ts + 5 * 60_000 });
  }
  return ev.sort((a, b) => a.at - b.at);
}
