/**
 * Liquidity levels bot (read-only: never places orders).
 *
 *   npm run levels -- --token-file data/analytics-token.txt           run all day (morning message + sweep alerts)
 *   npm run levels -- --token-file data/analytics-token.txt --once    print + send today's levels once and exit
 *
 * 09:10 IST  → Telegram: today's levels for SENSEX and NIFTY
 * 09:31 IST  → Telegram: opening range (09:15–09:30)
 * 09:15–15:30 → polls today's 1-min candles every minute; alerts when a level is SWEPT and when it's RECLAIMED
 *
 * Telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in this project's .env (can be the same bot as Risk Guard;
 * this bot only sends, so it doesn't clash with Risk Guard reading your replies).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeLevels as compute, DEFAULT_LEVEL_OPTIONS, detectSweeps, type Level, type LevelOptions } from "./levels.js";
import { fetchOneMinute, INDEX_KEYS, readToken } from "./history.js";
import { istDay, istMin, type Candle } from "./strategy.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* optional */
}
const args = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const once = args.includes("--once");
const token = readToken(arg("token-file"));
if (!token) {
  console.error("No Upstox token. Use --token-file data/analytics-token.txt (or UPSTOX_ACCESS_TOKEN).");
  process.exit(1);
}
const tg = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
const indices = ["SENSEX", "NIFTY"];
const levelOpts: LevelOptions = { ...DEFAULT_LEVEL_OPTIONS, ...((JSON.parse(readFileSync(arg("config", "config.json")!, "utf8")) as { levels?: Partial<LevelOptions> }).levels ?? {}) };
const computeLevels = (cs: Candle[], day: string) => compute(cs, day, levelOpts);

const ist = (ms = Date.now()) => new Date(ms + 330 * 60_000);
const today = () => istDay(Date.now());
const hhmm = (ms: number) => ist(ms).toISOString().slice(11, 16);
const num = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const log = (m: string) => console.log(`${ist().toISOString().slice(0, 19).replace("T", " ")} IST  ${m}`);

async function send(text: string) {
  console.log(text + "\n");
  if (!tg.token || !tg.chat) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chat, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) log(`telegram HTTP ${r.status}`);
  } catch (e) {
    log(`telegram failed: ${(e as Error).message}`);
  }
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const j = (await r.json()) as { status?: string; data?: unknown; errors?: { message?: string }[] };
  if (!r.ok || j.status === "error") throw new Error(`HTTP ${r.status} ${j.errors?.[0]?.message ?? ""}`);
  return j.data;
}

/** GET /v3/historical-candle/intraday/{key}/minutes/1 → today's 1-min candles. */
async function intraday(key: string): Promise<Candle[]> {
  const d = (await getJson(`https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/1`)) as { candles?: unknown[][] };
  return (d?.candles ?? []).map((r) => ({ ts: Date.parse(String(r[0])), o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]! })).sort((a, b) => a.ts - b.ts);
}

/** Trading holiday for NSE/BSE today? (GET /v2/market/holidays/{date}). Weekend = always closed. */
const closedCache = new Map<string, boolean>();
async function marketClosed(day: string): Promise<boolean> {
  if (!closedCache.has(day)) closedCache.set(day, await isClosed(day));
  return closedCache.get(day)!;
}
async function isClosed(day: string): Promise<boolean> {
  const dow = new Date(day + "T00:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6) return true;
  try {
    const d = (await getJson(`https://api.upstox.com/v2/market/holidays/${day}`)) as { closed_exchanges?: string[] }[] | undefined;
    return (d ?? []).some((h) => (h.closed_exchanges ?? []).some((x) => x === "NSE" || x === "BSE"));
  } catch {
    return false; // can't tell: assume open
  }
}

/** Last ~3 weeks of history + today so far. */
async function candlesFor(ix: string): Promise<Candle[]> {
  const from = istDay(Date.now() - 21 * 86400_000);
  const to = istDay(Date.now() - 86400_000);
  const hist = await fetchOneMinute(INDEX_KEYS[ix], from, to, token, "data/candles", () => {});
  let live: Candle[] = [];
  try {
    live = await intraday(INDEX_KEYS[ix]);
  } catch (e) {
    log(`${ix} intraday: ${(e as Error).message}`);
  }
  const seen = new Set(hist.map((c) => c.ts));
  return [...hist, ...live.filter((c) => !seen.has(c.ts))].sort((a, b) => a.ts - b.ts);
}

function levelsMessage(ix: string, cs: Candle[], lv: Level[]): string {
  const last = cs.at(-1)!;
  const nearest = (side: "high" | "low") =>
    lv.filter((l) => l.side === side && (side === "high" ? l.price > last.c : l.price < last.c)).sort((a, b) => Math.abs(a.price - last.c) - Math.abs(b.price - last.c)).slice(0, 5);
  const fmt = (l: Level) => `• ${num(l.price)}  ${l.name}  (${l.price > last.c ? "+" : "−"}${num(Math.abs(l.price - last.c))})${l.strength >= 4 ? "  ★" : ""}`;
  return [
    `📍 ${ix} liquidity · ${today()}`,
    `Last price ${num(last.c)}`,
    "",
    "Above (buy-side liquidity, stops of shorts):",
    ...(nearest("high").map(fmt).length ? nearest("high").map(fmt) : ["• none unswept nearby"]),
    "",
    "Below (sell-side liquidity, stops of longs):",
    ...(nearest("low").map(fmt).length ? nearest("low").map(fmt) : ["• none unswept nearby"]),
    "",
    "PDH/PDL prev day · PWH/PWL prev week · ORH/ORL opening range · EQH/EQL equal highs/lows · SH/SL 15m swing · ★ strong",
  ].join("\n");
}

// ---- state so a restart doesn't repeat alerts
mkdirSync("data", { recursive: true });
const statePath = () => `data/levels-state-${today()}.json`;
const state: { sent: string[] } = existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : { sent: [] };
const already = (k: string) => state.sent.includes(k);
const mark = (k: string) => {
  state.sent.push(k);
  writeFileSync(statePath(), JSON.stringify(state));
};

/** Levels are fixed at the open (plus ORH/ORL once known), then watched for sweeps. */
const dayLevels: Record<string, Level[]> = {};

async function morning(force = false) {
  if (!force && already("morning")) return;
  for (const ix of indices) {
    const cs = await candlesFor(ix);
    if (!cs.length) continue;
    const lv = computeLevels(cs, today());
    dayLevels[ix] = lv;
    await send(levelsMessage(ix, cs, lv));
  }
  if (!force) mark("morning");
}

async function openingRange() {
  if (already("or")) return;
  for (const ix of indices) {
    const cs = await candlesFor(ix);
    const lv = computeLevels(cs, today()).filter((l) => l.name.includes("ORH") || l.name.includes("ORL"));
    if (!lv.length) continue;
    dayLevels[ix] = [...(dayLevels[ix] ?? []).filter((l) => !lv.some((x) => x.price === l.price)), ...lv];
    await send(`⏱ ${ix} opening range (09:15–09:30): high ${num(lv.find((l) => l.side === "high")?.price ?? NaN)} · low ${num(lv.find((l) => l.side === "low")?.price ?? NaN)}`);
  }
  mark("or");
}

async function watch() {
  for (const ix of indices) {
    if (!dayLevels[ix]) dayLevels[ix] = computeLevels(await candlesFor(ix), today());
    const live = await intraday(INDEX_KEYS[ix]).catch(() => [] as Candle[]);
    for (const e of detectSweeps(dayLevels[ix], live, Date.now())) {
      const key = `${ix}:${e.kind}:${e.level.name}:${e.level.price}`;
      if (already(key)) continue;
      mark(key);
      const dir = e.level.side === "high" ? "above" : "below";
      if (e.kind === "swept") await send(`⚡ ${ix} swept ${e.level.name} ${num(e.level.price)} at ${hhmm(e.at)} (traded ${dir} it, extreme ${num(e.price)})`);
      else await send(`↩️ ${ix} RECLAIMED ${e.level.name} ${num(e.level.price)}: 5-min close back ${e.level.side === "high" ? "below" : "above"} it at ${num(e.price)} (${hhmm(e.at)}). A liquidity grab: information, not a trade signal (unbacktested).`);
    }
  }
}

if (once) {
  await morning(true);
  process.exit(0);
}

log("levels bot running (read-only). Ctrl+C to stop.");
let lastDay = "";
for (;;) {
  const d = today();
  if (d !== lastDay) {
    lastDay = d;
    for (const k of Object.keys(dayLevels)) delete dayLevels[k];
    state.sent = existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")).sent : [];
  }
  const t = istMin(Date.now());
  try {
    if (t >= 9 * 60 + 10 && t < 15 * 60 + 30 && !(await marketClosed(d))) {
      await morning();
      if (t >= 9 * 60 + 31) await openingRange();
      if (t >= 9 * 60 + 16) await watch();
    }
  } catch (e) {
    log(`error: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
