/**
 * Backtest engine: replays 1-minute index candles, builds the 5-min (sell side) and
 * 15-min (buy side) charts from them, and trades the 5 EMA rules.
 *
 * Fill assumptions (deliberately conservative):
 *  - Entry at the alert level, or at the minute's open if it gapped through.
 *  - In the entry minute only the STOP is checked (we can't know if the target came first).
 *  - If a minute touches both stop and target, the STOP is assumed first.
 *  - A stop/target gapped through fills at the minute's open (worse price).
 *  - Open trades are closed at exitTime.
 *  - Option P&L ≈ index points × delta × quantity − charges (ignores time decay: optimistic for option buyers).
 */
import { aggregate, alertFor, ema, istDay, istMin, trigger, type Alert, type Candle, type OptionSide } from "./strategy.js";

export interface BtConfig {
  emaPeriod: number;
  sellTimeframeMin: number;
  buyTimeframeMin: number;
  rewardRisk: number;
  entryWindow: { start: string; end: string };
  exitTime: string;
  optionDelta: number;
  chargesPerTrade: number;
  quantity: number;
  /** Which sides to trade. */
  sides: OptionSide[];
  /** ₹ slippage per option unit, round trip (e.g. 1 = ₹0.50 worse on entry and on exit). */
  slippagePerUnit?: number;
  // ---- optional improvements (all off by default = the classic strategy)
  /** Skip signals whose estimated ₹ risk at the stop is above this. */
  maxRiskRupees?: number;
  /** Trend filter: PE only below, CE only above, the EMA(period) of the last completed `minutes` candle. */
  trendFilter?: { minutes: number; period: number };
  /** Move the stop to entry once price has moved this many R in your favour. */
  breakevenAtR?: number;
  /** Max entries per day. */
  maxTradesPerDay?: number;
}

export interface Trade {
  day: string;
  side: OptionSide;
  alertTime: number;
  entryTime: number;
  entry: number;
  sl: number;
  target: number;
  riskPts: number;
  exitTime: number;
  exit: number;
  reason: "TARGET" | "SL" | "BE" | "TIME";
  /** index points in your favour (negative = loss) */
  pts: number;
  /** estimated option P&L in ₹ incl. charges */
  rupees: number;
  /** estimated ₹ lost if the stop is hit */
  riskRupees: number;
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

interface TfBar {
  c: Candle;
  ema: number;
  readyAt: number;
}

const tfCache = new WeakMap<Candle[], Map<string, TfBar[]>>();

/** Signal-chart candles + EMA, memoised per input array (the optimiser runs hundreds of configs). */
function timeframe(oneMin: Candle[], minutes: number, period: number): TfBar[] {
  let byKey = tfCache.get(oneMin);
  if (!byKey) tfCache.set(oneMin, (byKey = new Map()));
  const key = `${minutes}/${period}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const bars = aggregate(oneMin, minutes);
  const e = ema(bars.map((b) => b.c), period);
  const out = bars.map((c, i) => ({ c, ema: e[i], readyAt: c.ts + minutes * 60_000 }));
  byKey.set(key, out);
  return out;
}

export function backtest(oneMin: Candle[], cfg: BtConfig): Trade[] {
  const sorted = oneMin.every((c, i) => i === 0 || oneMin[i - 1].ts <= c.ts);
  const m1 = sorted ? oneMin : [...oneMin].sort((a, b) => a.ts - b.ts);
  const unitCost = cfg.optionDelta * cfg.quantity;
  const slip = (cfg.slippagePerUnit ?? 0) * cfg.quantity;
  const trend = cfg.trendFilter ? { bars: timeframe(m1, cfg.trendFilter.minutes, cfg.trendFilter.period), p: 0, last: undefined as TfBar | undefined } : undefined;
  let tradesToday = 0;
  const tfs: { side: OptionSide; bars: TfBar[]; p: number }[] = [];
  if (cfg.sides.includes("PE")) tfs.push({ side: "PE", bars: timeframe(m1, cfg.sellTimeframeMin, cfg.emaPeriod), p: 0 });
  if (cfg.sides.includes("CE")) tfs.push({ side: "CE", bars: timeframe(m1, cfg.buyTimeframeMin, cfg.emaPeriod), p: 0 });

  const trades: Trade[] = [];
  const alerts: Partial<Record<OptionSide, Alert>> = {};
  let pos: (NonNullable<ReturnType<typeof trigger>> & { entryTime: number; day: string; atBreakeven?: boolean }) | undefined;
  let day = "";
  const [ws, we, xt] = [hm(cfg.entryWindow.start), hm(cfg.entryWindow.end), hm(cfg.exitTime)];

  const close = (m: Candle, exit: number, reason: Trade["reason"]) => {
    const p = pos!;
    const pts = p.side === "PE" ? p.entry - exit : exit - p.entry;
    trades.push({
      day: p.day, side: p.side, alertTime: p.alert.readyAt, entryTime: p.entryTime, entry: r2(p.entry), sl: r2(p.sl), target: r2(p.target),
      riskPts: r2(p.riskPts), exitTime: m.ts, exit: r2(exit), reason, pts: r2(pts),
      rupees: r2(pts * unitCost - cfg.chargesPerTrade - slip),
      riskRupees: r2(p.riskPts * unitCost + cfg.chargesPerTrade + slip),
    });
    pos = undefined;
  };

  /** Stop/target check on one minute. `entryMinute` = only the stop counts. */
  const checkExit = (m: Candle, entryMinute: boolean) => {
    const p = pos!;
    const stopReason = p.atBreakeven ? "BE" : "SL";
    if (p.side === "PE") {
      if (m.h >= p.sl) return close(m, entryMinute ? p.sl : Math.max(m.o, p.sl), stopReason);
      if (!entryMinute && m.l <= p.target) return close(m, Math.min(m.o, p.target), "TARGET");
    } else {
      if (m.l <= p.sl) return close(m, entryMinute ? p.sl : Math.min(m.o, p.sl), stopReason);
      if (!entryMinute && m.h >= p.target) return close(m, Math.max(m.o, p.target), "TARGET");
    }
    // Still open: breakeven applies from the NEXT minute (we can't know the order inside this one).
    if (cfg.breakevenAtR && !p.atBreakeven) {
      const fav = p.side === "PE" ? p.entry - m.l : m.h - p.entry;
      if (fav >= cfg.breakevenAtR * p.riskPts) {
        p.sl = p.entry;
        p.atBreakeven = true;
      }
    }
  };

  for (let i = 0; i < m1.length; i++) {
    const m = m1[i];
    const d = istDay(m.ts);
    if (d !== day) {
      // New day: an open trade from yesterday (data gap) is closed at its last price.
      if (pos) close(m1[i - 1], m1[i - 1].c, "TIME");
      day = d;
      tradesToday = 0;
      delete alerts.CE;
      delete alerts.PE;
    }
    // Completed signal candles up to this minute → update alerts (same day only).
    for (const tf of tfs) {
      while (tf.p < tf.bars.length && tf.bars[tf.p].readyAt <= m.ts) {
        const b = tf.bars[tf.p++];
        if (istDay(b.c.ts) === d && alertFor(tf.side, b.c, b.ema)) alerts[tf.side] = { side: tf.side, candle: b.c, ema: b.ema, readyAt: b.readyAt };
      }
    }
    if (trend) {
      while (trend.p < trend.bars.length && trend.bars[trend.p].readyAt <= m.ts) trend.last = trend.bars[trend.p++];
    }
    const t = istMin(m.ts);
    if (pos) {
      if (t >= xt) {
        close(m, m.o, "TIME");
        continue;
      }
      checkExit(m, false);
      continue;
    }
    if (t < ws || t >= we) continue;
    if (cfg.maxTradesPerDay !== undefined && tradesToday >= cfg.maxTradesPerDay) continue;
    for (const side of ["PE", "CE"] as OptionSide[]) {
      const a = alerts[side];
      if (!a) continue;
      const e = trigger(a, m, cfg.rewardRisk);
      if (!e) continue;
      delete alerts[side]; // a triggered alert is used up, taken or skipped
      if (cfg.maxRiskRupees !== undefined && e.riskPts * unitCost + cfg.chargesPerTrade + slip > cfg.maxRiskRupees) continue;
      if (trend) {
        const tb = trend.last;
        if (!tb || !Number.isFinite(tb.ema)) continue;
        if (side === "PE" ? !(tb.c.c < tb.ema) : !(tb.c.c > tb.ema)) continue;
      }
      tradesToday++;
      pos = { ...e, entryTime: m.ts, day: d };
      checkExit(m, true);
      break;
    }
  }
  if (pos) close(m1[m1.length - 1], m1[m1.length - 1].c, "TIME");
  return trades;
}

export interface Summary {
  trades: number;
  wins: number;
  winRate: number;
  netRupees: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  worstLosingStreak: number;
  avgRiskRupees: number;
  maxRiskRupees: number;
  byReason: Record<string, number>;
}

export function summarize(ts: Trade[]): Summary {
  const wins = ts.filter((t) => t.rupees > 0);
  const losses = ts.filter((t) => t.rupees <= 0);
  const gw = wins.reduce((a, t) => a + t.rupees, 0);
  const gl = -losses.reduce((a, t) => a + t.rupees, 0);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const t of ts) {
    eq += t.rupees;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    streak = t.rupees <= 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  const byReason: Record<string, number> = {};
  for (const t of ts) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
  return {
    trades: ts.length,
    wins: wins.length,
    winRate: ts.length ? r2((wins.length / ts.length) * 100) : 0,
    netRupees: r2(eq),
    avgWin: wins.length ? r2(gw / wins.length) : 0,
    avgLoss: losses.length ? r2(-gl / losses.length) : 0,
    profitFactor: gl ? r2(gw / gl) : gw ? Infinity : 0,
    maxDrawdown: r2(dd),
    worstLosingStreak: worst,
    avgRiskRupees: ts.length ? r2(ts.reduce((a, t) => a + t.riskRupees, 0) / ts.length) : 0,
    maxRiskRupees: ts.length ? Math.max(...ts.map((t) => t.riskRupees)) : 0,
    byReason,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
