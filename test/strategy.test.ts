import { describe, expect, it } from "vitest";
import { aggregate, alertFor, ema, trigger, type Candle } from "../src/strategy.js";
import { backtest, summarize, type BtConfig } from "../src/engine.js";

const DAY = "2026-11-02";
/** epoch ms for an IST time on DAY */
const at = (hhmm: string, day = DAY) => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000;
};
const c = (hhmm: string, o: number, h: number, l: number, cl: number, day = DAY): Candle => ({ ts: at(hhmm, day), o, h, l, c: cl });
/** flat 1-minute candles at `px` from start (inclusive) to end (exclusive) */
function flat(start: string, end: string, px: number, day = DAY): Candle[] {
  const out: Candle[] = [];
  for (let t = at(start, day); t < at(end, day); t += 60_000) out.push({ ts: t, o: px, h: px, l: px, c: px });
  return out;
}

const cfg: BtConfig = {
  emaPeriod: 5, sellTimeframeMin: 5, buyTimeframeMin: 15, rewardRisk: 3,
  entryWindow: { start: "09:15", end: "15:00" }, exitTime: "15:15",
  optionDelta: 0.5, chargesPerTrade: 50, quantity: 20, sides: ["PE", "CE"],
};

describe("building blocks", () => {
  it("EMA seeds with the SMA, then smooths with k = 2/(n+1)", () => {
    const e = ema([1, 2, 3, 4, 5, 11], 5);
    expect(e.slice(0, 4).every(Number.isNaN)).toBe(true);
    expect(e[4]).toBe(3);
    expect(e[5]).toBeCloseTo(11 / 3 + 2, 10); // 11·⅓ + 3·⅔ = 5.666…
  });

  it("aggregates 1-min candles into 09:15-aligned 5- and 15-min candles", () => {
    const m = [c("09:15", 10, 12, 9, 11), c("09:16", 11, 15, 10, 14), c("09:19", 14, 14, 8, 9), c("09:20", 9, 9, 9, 9)];
    const five = aggregate(m, 5);
    expect(five).toHaveLength(2);
    expect(five[0]).toEqual({ ts: at("09:15"), o: 10, h: 15, l: 8, c: 9 });
    expect(five[1].ts).toBe(at("09:20"));
    expect(aggregate(m, 15)).toHaveLength(1);
  });

  it("alert candles: PE = fully above the EMA, CE = fully below", () => {
    const k = c("10:00", 105, 107, 105, 106);
    expect(alertFor("PE", k, 104.9)).toBe(true);
    expect(alertFor("PE", k, 105)).toBe(false); // touching the EMA doesn't count
    expect(alertFor("CE", c("10:00", 95, 96, 94, 95), 96.1)).toBe(true);
    expect(alertFor("CE", c("10:00", 95, 96, 94, 95), Number.NaN)).toBe(false);
  });

  it("trigger fills at the alert level, or at the open on a gap", () => {
    const alert = { side: "PE" as const, candle: c("09:45", 106, 107, 105, 106), ema: 102, readyAt: at("09:50") };
    expect(trigger(alert, c("09:50", 106, 106, 104, 104), 3)).toMatchObject({ entry: 105, sl: 107, riskPts: 2, target: 99 });
    expect(trigger(alert, c("09:50", 104, 104, 103, 103), 3)).toMatchObject({ entry: 104, sl: 107, riskPts: 3, target: 95 });
    expect(trigger(alert, c("09:50", 106, 106, 105, 105), 3)).toBeUndefined(); // must trade BELOW the low
  });
});

describe("backtest", () => {
  // 09:15–09:45 flat at 100, 09:45–09:50 jumps to 105–107 (a 5-min candle fully above the EMA)
  const setupPE = () => [...flat("09:15", "09:45", 100), ...Array.from({ length: 5 }, (_, i) => c(`09:${45 + i}`, 106, 107, 105, 106))];

  it("PE: alert above the EMA, break of its low, target 1:3 hit", () => {
    const trades = backtest([...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 104, 104, 100, 100), c("09:52", 100, 100, 98, 98)], cfg);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: "PE", entry: 105, sl: 107, target: 99, exit: 99, reason: "TARGET", pts: 6 });
    expect(trades[0].rupees).toBe(10); // 6 × 0.5 × 20 − 50
    expect(trades[0].riskRupees).toBe(70); // 2 × 0.5 × 20 + 50
  });

  it("PE: stop hit; a gap through the stop fills at the worse open", () => {
    const trades = backtest([...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 108, 109, 108, 109)], cfg);
    expect(trades[0]).toMatchObject({ reason: "SL", exit: 108, pts: -3 });
  });

  it("stop and target in the same minute → assume the stop (conservative)", () => {
    const trades = backtest([...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 104, 108, 98, 100)], cfg);
    expect(trades[0].reason).toBe("SL");
  });

  it("open trades are closed at exitTime", () => {
    const trades = backtest([...setupPE(), c("09:50", 106, 106, 104, 104), ...flat("09:51", "15:20", 103)], cfg);
    expect(trades[0]).toMatchObject({ reason: "TIME", exit: 103, pts: 2 });
    expect(new Date(trades[0].exitTime + 330 * 60_000).toISOString().slice(11, 16)).toBe("15:15");
  });

  it("no entries outside the entry window, and alerts don't carry over to the next day", () => {
    const late = { ...cfg, entryWindow: { start: "09:15", end: "09:50" } };
    expect(backtest([...setupPE(), c("09:50", 106, 106, 104, 104)], late)).toHaveLength(0);
    const nextDay = backtest([...setupPE(), c("09:15", 104, 104, 100, 100, "2026-11-03")], cfg);
    expect(nextDay).toHaveLength(0);
  });

  it("CE: 15-min alert candle below the EMA, break of its high", () => {
    // 5×15-min flat bars at 100 (EMA seeded), then a 15-min bar fully below (93–95)
    const m = [...flat("09:15", "10:30", 100), ...flat("10:30", "10:45", 94).map((k) => ({ ...k, h: 95, l: 93 }))];
    const trades = backtest([...m, c("10:45", 95, 96, 95, 96), c("10:46", 96, 102, 96, 102)], { ...cfg, sides: ["CE"] });
    // entry 95 (open = alert high), stop 93, risk 2, target 101
    expect(trades[0]).toMatchObject({ side: "CE", entry: 95, sl: 93, target: 101, reason: "TARGET", exit: 101, pts: 6 });
  });

  it("slippage is charged per unit", () => {
    const trades = backtest([...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 104, 104, 100, 100), c("09:52", 100, 100, 98, 98)], { ...cfg, slippagePerUnit: 1 });
    expect(trades[0].rupees).toBe(-10); // 10 − 20 (₹1 × 20 units)
  });

  it("maxRiskRupees skips signals with a big stop", () => {
    const m = [...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 104, 104, 100, 100), c("09:52", 100, 100, 98, 98)];
    expect(backtest(m, { ...cfg, maxRiskRupees: 69 })).toHaveLength(0); // risk is ₹70
    expect(backtest(m, { ...cfg, maxRiskRupees: 70 })).toHaveLength(1);
  });

  it("breakeven at 1R: after +1R the stop moves to entry (from the next minute)", () => {
    // entry 105, risk 2 → +1R at 103; then price comes back up through 105
    const m = [...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 104, 104, 102.5, 103), c("09:52", 103, 106, 103, 106)];
    expect(backtest(m, { ...cfg, breakevenAtR: 1 })[0]).toMatchObject({ reason: "BE", exit: 105, pts: 0 });
    expect(backtest(m, cfg)).toHaveLength(1); // without it: still open, closed at the end at 106
  });

  it("trend filter: PE only when the trend chart is below its EMA", () => {
    const m = [...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 104, 104, 100, 100), c("09:52", 100, 100, 98, 98)];
    // 5-min trend EMA(3): after the 09:45 bar closes at 106 the trend close is ABOVE its EMA → PE blocked
    expect(backtest(m, { ...cfg, trendFilter: { minutes: 5, period: 3 } })).toHaveLength(0);
  });

  it("maxTradesPerDay caps entries", () => {
    const one = [...setupPE(), c("09:50", 106, 106, 104, 104), c("09:51", 108, 109, 108, 109)]; // stopped out
    const again = Array.from({ length: 5 }, (_, i) => c(`09:${55 + i}`, 110, 112, 110, 111)); // new alert 09:55–10:00
    const m = [...one, ...flat("09:52", "09:55", 109), ...again, c("10:00", 110, 110, 108, 108)];
    expect(backtest(m, cfg).length).toBe(2);
    expect(backtest(m, { ...cfg, maxTradesPerDay: 1 }).length).toBe(1);
  });

  it("summary maths", () => {
    const s = summarize([
      { rupees: 300, riskRupees: 100, reason: "TARGET" },
      { rupees: -100, riskRupees: 100, reason: "SL" },
      { rupees: -100, riskRupees: 100, reason: "SL" },
      { rupees: 300, riskRupees: 100, reason: "TARGET" },
    ] as never);
    expect(s).toMatchObject({ trades: 4, wins: 2, winRate: 50, netRupees: 400, profitFactor: 3, maxDrawdown: 200, worstLosingStreak: 2 });
  });
});
