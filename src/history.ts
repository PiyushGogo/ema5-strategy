/**
 * Upstox historical candles (V3), verified against the official upstox-js-sdk HistoryV3Api:
 *   GET https://api.upstox.com/v3/historical-candle/{instrument_key}/minutes/1/{to_date}/{from_date}
 *   → { status, data: { candles: [[timestamp, open, high, low, close, volume, oi], ...] } } (newest first)
 * Fetched month by month and cached in data/candles/ (past months never change).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "./strategy.js";

export const INDEX_KEYS: Record<string, string> = {
  SENSEX: "BSE_INDEX|SENSEX",
  NIFTY: "NSE_INDEX|Nifty 50",
};

function months(from: string, to: string): { from: string; to: string; ym: string }[] {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const start = ym === from.slice(0, 7) ? from : `${ym}-01`;
    const end = ym === to.slice(0, 7) ? to : `${ym}-${last}`;
    out.push({ from: start, to: end, ym });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export async function fetchOneMinute(key: string, from: string, to: string, token: string, dir = "data/candles", log = console.log): Promise<Candle[]> {
  mkdirSync(dir, { recursive: true });
  const all: Candle[] = [];
  const thisMonth = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
  for (const chunk of months(from, to)) {
    const cache = join(dir, `${key.replace(/[^A-Za-z0-9]+/g, "_")}-1m-${chunk.from}-${chunk.to}.json`);
    let candles: Candle[];
    if (existsSync(cache) && chunk.ym !== thisMonth) {
      candles = JSON.parse(readFileSync(cache, "utf8"));
    } else {
      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/minutes/1/${chunk.to}/${chunk.from}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      const json = (await res.json()) as { status?: string; data?: { candles?: unknown[][] }; errors?: { message?: string; errorCode?: string }[] };
      if (!res.ok || json.status === "error") {
        const e = json.errors?.[0];
        throw new Error(`Upstox history ${chunk.from}..${chunk.to}: HTTP ${res.status} ${e?.errorCode ?? ""} ${e?.message ?? ""}`);
      }
      candles = (json.data?.candles ?? []).map((r) => ({ ts: Date.parse(String(r[0])), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
      writeFileSync(cache, JSON.stringify(candles));
      log(`  fetched ${chunk.from} → ${chunk.to}: ${candles.length} candles`);
      await new Promise((r) => setTimeout(r, 300)); // be gentle with rate limits
    }
    all.push(...candles);
  }
  return all.sort((a, b) => a.ts - b.ts);
}

/** Token: UPSTOX_ACCESS_TOKEN env var, or --token-file (JSON with accessToken, or a raw token). */
export function readToken(tokenFile?: string): string {
  if (process.env.UPSTOX_ACCESS_TOKEN) return process.env.UPSTOX_ACCESS_TOKEN;
  if (tokenFile && existsSync(tokenFile)) {
    const raw = readFileSync(tokenFile, "utf8").trim();
    try {
      const j = JSON.parse(raw) as { accessToken?: string; access_token?: string };
      return j.accessToken ?? j.access_token ?? "";
    } catch {
      return raw;
    }
  }
  return "";
}
