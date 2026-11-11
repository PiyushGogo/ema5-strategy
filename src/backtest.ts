/**
 * npm run backtest -- --index SENSEX --from 2026-05-01 --to 2026-10-31 [--token-file path] [--sides PE,CE]
 *
 * Needs an Upstox access token: UPSTOX_ACCESS_TOKEN=... or --token-file <file>.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backtest, summarize, type BtConfig, type Trade } from "./engine.js";
import { fetchOneMinute, INDEX_KEYS, readToken } from "./history.js";
import type { OptionSide } from "./strategy.js";

interface FileConfig extends Omit<BtConfig, "quantity" | "sides"> {
  lots: number;
  lotSize: Record<string, number>;
}

const args = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const monthsAgo = (n: number) => {
  const d = new Date(Date.now() + 330 * 60_000);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

const cfgFile = JSON.parse(readFileSync(arg("config", "config.json")!, "utf8")) as FileConfig;
const index = (arg("index", "SENSEX") ?? "SENSEX").toUpperCase();
const key = INDEX_KEYS[index];
if (!key) {
  console.error(`--index must be one of ${Object.keys(INDEX_KEYS).join(", ")}`);
  process.exit(1);
}
const from = arg("from", monthsAgo(6))!;
const to = arg("to", istToday())!;
const sides = (arg("sides", "PE,CE")!.split(",").map((s) => s.trim().toUpperCase()) as OptionSide[]);
const lotSize = Number(arg("lot", String(cfgFile.lotSize[index])));
const cfg: BtConfig = { ...cfgFile, quantity: lotSize * cfgFile.lots, sides };

const token = readToken(arg("token-file"));
if (!token) {
  console.error("No Upstox token. Set UPSTOX_ACCESS_TOKEN=... or pass --token-file <path to a token JSON>.");
  process.exit(1);
}

const inr = (n: number) => (n < 0 ? "-₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const time = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

console.log(`\n5 EMA backtest · ${index} · ${from} → ${to}`);
console.log(`PE side: ${cfg.sellTimeframeMin}-min alert candles above the ${cfg.emaPeriod} EMA · CE side: ${cfg.buyTimeframeMin}-min alert candles below it · target 1:${cfg.rewardRisk}`);
console.log(`Option P&L estimate: index pts × delta ${cfg.optionDelta} × qty ${cfg.quantity} (${cfgFile.lots} lot × ${lotSize}) − ₹${cfg.chargesPerTrade} charges\n`);

const candles = await fetchOneMinute(key, from, to, token);
if (!candles.length) {
  console.error("No candles returned for that range.");
  process.exit(1);
}
const trades = backtest(candles, cfg);

const row = (label: string, ts: Trade[]) => {
  const s = summarize(ts);
  return {
    "": label, Trades: s.trades, "Win %": s.winRate, "Net P&L": inr(s.netRupees), "Avg win": inr(s.avgWin), "Avg loss": inr(s.avgLoss),
    "Profit factor": s.profitFactor === Infinity ? "∞" : s.profitFactor, "Max drawdown": inr(s.maxDrawdown), "Worst streak": s.worstLosingStreak,
    "Avg risk": inr(s.avgRiskRupees), "Max risk": inr(s.maxRiskRupees),
  };
};

console.table([row("All trades", trades), row("PE (sell side, 5m)", trades.filter((t) => t.side === "PE")), row("CE (buy side, 15m)", trades.filter((t) => t.side === "CE"))]);

const s = summarize(trades);
console.log(`Exits: ${Object.entries(s.byReason).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

const byMonth = new Map<string, Trade[]>();
for (const t of trades) byMonth.set(t.day.slice(0, 7), [...(byMonth.get(t.day.slice(0, 7)) ?? []), t]);
console.log("\nBy month:");
console.table([...byMonth].map(([m, ts]) => ({ Month: m, Trades: ts.length, "Win %": summarize(ts).winRate, "Net P&L": inr(summarize(ts).netRupees) })));

const days = new Set(candles.map((c) => new Date(c.ts + 330 * 60_000).toISOString().slice(0, 10))).size;
console.log(`\n${days} trading days · ${(trades.length / Math.max(days, 1)).toFixed(2)} trades/day on average`);

mkdirSync("reports", { recursive: true });
const csvPath = `reports/ema5-${index}-${from}-${to}.csv`;
writeFileSync(
  csvPath,
  "day,side,alert_ready,entry_time,entry,sl,target,risk_pts,exit_time,exit,reason,pts,est_option_pnl,est_risk_rupees\n" +
    trades.map((t) => [t.day, t.side, time(t.alertTime), time(t.entryTime), t.entry, t.sl, t.target, t.riskPts, time(t.exitTime), t.exit, t.reason, t.pts, t.rupees, t.riskRupees].join(",")).join("\n") +
    "\n",
);
console.log(`Every trade: ${csvPath}`);
console.log("\nReminder: option P&L is an estimate (fixed delta, no time decay or slippage). Real results for option buyers are usually WORSE.\n");
