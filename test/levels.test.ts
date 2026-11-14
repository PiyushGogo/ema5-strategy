import { describe, expect, it } from "vitest";
import { computeLevels, detectSweeps, pivots } from "../src/levels.js";
import type { Candle } from "../src/strategy.js";

const at = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000;
};
const pad = (n: number) => String(n).padStart(2, "0");
const time = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** One 15-min bar as 15 one-minute candles: first minute carries the high/low. */
function bar15(day: string, idx: number, h: number, l: number): Candle[] {
  const start = 9 * 60 + 15 + idx * 15;
  const mid = (h + l) / 2;
  return Array.from({ length: 15 }, (_, i) => ({ ts: at(day, time(start + i)), o: mid, h: i === 0 ? h : mid, l: i === 0 ? l : mid, c: mid }));
}
/** A whole quiet day around px with given high/low, made of 25 bars (09:15–15:30). */
function day(d: string, hiBar: number, h: number, l: number, px = 100): Candle[] {
  return Array.from({ length: 25 }, (_, i) => bar15(d, i, i === hiBar ? h : px + 0.5, i === hiBar + 5 ? l : px - 0.5)).flat();
}

describe("liquidity levels", () => {
  // previous week: Mon 3 – Fri 7 Nov; this week: Mon 10; today Tue 11
  const prevWeek = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].flatMap((d, i) => day(d, 3, 104 + i * 0.1, 96 - i * 0.1));
  const monday = day("2026-11-10", 4, 102, 98);

  it("previous day and previous week highs/lows", () => {
    const lv = computeLevels([...prevWeek, ...monday], "2026-11-11");
    const by = (n: string) => lv.find((l) => l.name.split("+").includes(n));
    expect(by("PDH")?.price).toBe(102);
    expect(by("PDL")?.price).toBe(98);
    expect(by("PWH")?.price).toBeCloseTo(104.4);
    expect(by("PWL")?.price).toBeCloseTo(95.6);
  });

  it("a level that price has already traded through is no longer liquidity", () => {
    const today = bar15("2026-11-11", 0, 102.5, 99.5); // takes out PDH 102
    const lv = computeLevels([...prevWeek, ...monday, ...today], "2026-11-11");
    expect(lv.some((l) => l.name.includes("PDH"))).toBe(false);
    expect(lv.some((l) => l.name.includes("PDL"))).toBe(true);
  });

  it("opening range appears once 09:30 has passed", () => {
    const today = [...bar15("2026-11-11", 0, 100.9, 99.2), ...bar15("2026-11-11", 1, 100.5, 99.5)];
    const lv = computeLevels([...prevWeek, ...monday, ...today], "2026-11-11");
    expect(lv.find((l) => l.name.includes("ORH"))?.price).toBe(100.9);
    expect(lv.find((l) => l.name.includes("ORL"))?.price).toBe(99.2);
  });

  it("pivots: a bar higher than k bars each side is a swing high", () => {
    const bars = [1, 2, 5, 2, 1].map((h, i) => ({ ts: i, o: h, h, l: h - 1, c: h }));
    expect(pivots(bars, 2).filter((p) => p.side === "high").map((p) => p.idx)).toEqual([2]);
  });

  it("two swing highs at almost the same price become one stronger EQH level", () => {
    const d = "2026-11-10";
    const bars = [100.5, 101, 103, 101, 100.5, 101, 103.02, 101, 100.5, 100.5].map((h, i) => bar15(d, i, h, 99.5)).flat();
    const lv = computeLevels([...prevWeek, ...bars], "2026-11-11");
    const eqh = lv.find((l) => l.name.includes("EQH×2"));
    expect(eqh?.price).toBe(103.02);
    expect(eqh!.strength).toBeGreaterThan(3);
  });
});

describe("sweeps", () => {
  const level = { name: "PDH", price: 102, side: "high" as const, strength: 3, formedAt: 0 };
  const m = (hhmm: string, o: number, h: number, l: number, c: number): Candle => ({ ts: at("2026-11-11", hhmm), o, h, l, c });

  it("swept, then reclaimed when a 5-min candle closes back below", () => {
    const cs = [m("10:00", 101.5, 101.8, 101.4, 101.7), m("10:01", 101.7, 102.4, 101.6, 102.2), m("10:02", 102.2, 102.3, 101.5, 101.6), m("10:03", 101.6, 101.7, 101.4, 101.5), m("10:04", 101.5, 101.6, 101.3, 101.4)];
    const ev = detectSweeps([level], cs, at("2026-11-11", "10:05"));
    expect(ev.map((e) => e.kind)).toEqual(["swept", "reclaimed"]);
    expect(ev[0].price).toBe(102.4);
    expect(ev[1].price).toBe(101.4);
  });

  it("swept and holding above → no reclaim", () => {
    const cs = ["10:00", "10:01", "10:02", "10:03", "10:04"].map((t) => m(t, 102.3, 102.6, 102.2, 102.5));
    const ev = detectSweeps([level], cs, at("2026-11-11", "10:05"));
    expect(ev.map((e) => e.kind)).toEqual(["swept"]);
  });

  it("the 5-min candle must be complete before a reclaim counts", () => {
    const cs = [m("10:00", 101.7, 102.4, 101.6, 101.6)];
    expect(detectSweeps([level], cs, at("2026-11-11", "10:02")).map((e) => e.kind)).toEqual(["swept"]);
  });
});
