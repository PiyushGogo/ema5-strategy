/**
 * npm run optimize -- --token-file data/analytics-token.txt [--train 2025-01-01:2025-12-31] [--test 2026-01-01:2026-10-31]
 *
 * Honest optimisation:
 *  1. Every combination of the improvement options is run on the TRAIN period only.
 *  2. Ranked by the WORSE of Sensex and Nifty profit factor (a real edge must work on both).
 *  3. The top configs are then run on the TEST period, which played no part in choosing them.
 *  If they stay profitable on TEST, the improvement is probably real. If they collapse, it was luck.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { backtest, summarize, type BtConfig, type Trade } from "./engine.js";
import { fetchOneMinute, INDEX_KEYS, readToken } from "./history.js";
import type { Candle, OptionSide } from "./strategy.js";

const args = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const [trainFrom, trainTo] = arg("train", "2025-01-01:2025-12-31")!.split(":");
const [testFrom, testTo] = arg("test", "2026-01-01:2026-10-31")!.split(":");
const token = readToken(arg("token-file"));
if (!token) {
  console.error("No Upstox token. Use --token-file data/analytics-token.txt (or UPSTOX_ACCESS_TOKEN).");
  process.exit(1);
}
const base = JSON.parse(readFileSync(arg("config", "config.json")!, "utf8")) as Omit<BtConfig, "quantity" | "sides"> & { lots: number; lotSize: Record<string, number> };
const indices = ["SENSEX", "NIFTY"];

interface Variant {
  label: string;
  opts: Partial<BtConfig>;
}

function grid(): Variant[] {
  const out: Variant[] = [];
  const sides: [string, OptionSide[]][] = [["PE", ["PE"]], ["PE+CE", ["PE", "CE"]]];
  const windows: [string, { start: string; end: string }][] = [["all day", { start: "09:15", end: "15:00" }], ["09:30-11:30", { start: "09:30", end: "11:30" }], ["09:30-14:00", { start: "09:30", end: "14:00" }]];
  const risks: [string, number | undefined][] = [["", undefined], ["risk≤1000", 1000], ["risk≤650", 650]];
  const trends: [string, BtConfig["trendFilter"]][] = [["", undefined], ["trend15m50", { minutes: 15, period: 50 }]];
  const rrs = [3, 2];
  const bes: [string, number | undefined][] = [["", undefined], ["BE@1R", 1]];
  const maxes: [string, number | undefined][] = [["", undefined], ["max2/day", 2]];
  for (const [sl, s] of sides) for (const [wl, w] of windows) for (const [rl, r] of risks) for (const [tl, t] of trends) for (const rr of rrs) for (const [bl, b] of bes) for (const [ml, mx] of maxes) {
    const label = [sl, wl, `1:${rr}`, rl, tl, bl, ml].filter(Boolean).join(" · ");
    out.push({ label, opts: { sides: s, entryWindow: w, maxRiskRupees: r, trendFilter: t, rewardRisk: rr, breakevenAtR: b, maxTradesPerDay: mx } });
  }
  return out;
}

const inr = (n: number) => (n < 0 ? "-₹" : "₹") + Math.abs(Math.round(n)).toLocaleString("en-IN");
const pf = (n: number) => (n === Infinity ? "∞" : n.toFixed(2));

function monthsProfitable(ts: Trade[]) {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t.day.slice(0, 7), (m.get(t.day.slice(0, 7)) ?? 0) + t.rupees);
  const vals = [...m.values()];
  return vals.length ? Math.round((vals.filter((v) => v > 0).length / vals.length) * 100) : 0;
}

console.log(`\n5 EMA optimiser · train ${trainFrom}→${trainTo} · test ${testFrom}→${testTo} · slippage ₹${base.slippagePerUnit ?? 0}/unit\n`);
const data: Record<string, { train: Candle[]; test: Candle[]; qty: number }> = {};
for (const ix of indices) {
  const all = await fetchOneMinute(INDEX_KEYS[ix], trainFrom, testTo, token);
  const cut = (f: string, t: string) => all.filter((c) => {
    const d = new Date(c.ts + 330 * 60_000).toISOString().slice(0, 10);
    return d >= f && d <= t;
  });
  data[ix] = { train: cut(trainFrom, trainTo), test: cut(testFrom, testTo), qty: base.lotSize[ix] * base.lots };
}

const run = (v: Variant, ix: string, period: "train" | "test") => {
  const cfg: BtConfig = { ...base, quantity: data[ix].qty, sides: ["PE", "CE"], ...v.opts };
  return backtest(data[ix][period], cfg);
};

const variants = grid();
const classic: Variant = { label: "CLASSIC (as taught)", opts: {} };
console.log(`Testing ${variants.length} combinations on both indices...`);

const scored = variants.map((v) => {
  const s = indices.map((ix) => summarize(run(v, ix, "train")));
  return { v, s, score: Math.min(...s.map((x) => x.profitFactor)), trades: Math.min(...s.map((x) => x.trades)) };
});
const ranked = scored.filter((x) => x.trades >= 60).sort((a, b) => b.score - a.score);
const top = ranked.slice(0, Number(arg("top", "10")));

const row = (label: string, v: Variant) => {
  const tr = indices.map((ix) => summarize(run(v, ix, "train")));
  const teTrades = indices.map((ix) => run(v, ix, "test"));
  const te = teTrades.map(summarize);
  return {
    Config: label,
    "Train PF S/N": `${pf(tr[0].profitFactor)} / ${pf(tr[1].profitFactor)}`,
    "Train net": inr(tr[0].netRupees + tr[1].netRupees),
    "TEST PF S/N": `${pf(te[0].profitFactor)} / ${pf(te[1].profitFactor)}`,
    "TEST net": inr(te[0].netRupees + te[1].netRupees),
    "TEST max DD S/N": `${inr(te[0].maxDrawdown)} / ${inr(te[1].maxDrawdown)}`,
    "TEST trades": te[0].trades + te[1].trades,
    "TEST green months S/N": `${monthsProfitable(teTrades[0])}% / ${monthsProfitable(teTrades[1])}%`,
  };
};

const table = [row(classic.label, classic), ...top.map((x, i) => row(`#${i + 1} ${x.v.label}`, x.v))];
console.log("\nTop configs chosen on TRAIN, then checked on TEST (S = Sensex, N = Nifty; PF = profit factor):");
console.table(table);

// Robustness: did the winners hold up on unseen data?
const testPFs = top.map((x) => Math.min(...indices.map((ix) => summarize(run(x.v, ix, "test")).profitFactor)));
const held = testPFs.filter((p) => p > 1.1).length;
console.log(`\nOf the top ${top.length} (chosen on ${trainFrom.slice(0, 4)}), ${held} kept a profit factor > 1.1 on BOTH indices in the test period.`);
console.log(held >= Math.ceil(top.length / 2)
  ? "→ Encouraging: the improvement looks real, not just luck. Next step: paper-trade it before any real money."
  : "→ The winners did not hold up on unseen data. The 'improvement' was mostly luck (overfitting). Don't trade it.");
console.log("Reminder: option P&L ignores time decay; real results for option buyers are usually worse.\n");

mkdirSync("reports", { recursive: true });
const out = `reports/optimize-${trainFrom}-${testTo}.json`;
writeFileSync(out, JSON.stringify(table, null, 2));
console.log(`Saved: ${out}`);
