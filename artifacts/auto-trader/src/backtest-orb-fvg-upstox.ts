// @ts-nocheck
/**
 * Runs the ORB+FVG strategy (see backtest-orb-fvg.ts) against Upstox 5-minute
 * history, so it can run anywhere the UPSTOX_ANALYTICS_TOKEN is available -
 * no dependency on the api-server.
 *
 * Universe comes from Supabase watchlist_snapshots (the symbols the bot
 * actually watches). Candles come from Upstox v3, which caps 5-minute history
 * at ~30 days per request, so longer windows are fetched in chunks and
 * cached on disk.
 *
 *   npx tsx --env-file=../../.env src/backtest-orb-fvg-upstox.ts
 *   npx tsx --env-file=../../.env src/backtest-orb-fvg-upstox.ts --months 6 --symbols 80
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pool } from "@workspace/db";
import { runSymbol } from "./backtest-orb-fvg.js";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : dflt;
};
const MONTHS = arg("months", 3);
const SYMBOL_CAP = arg("symbols", 50);
const CONCURRENCY = 4;
const EXIT_R = parseFloat(process.argv[process.argv.indexOf("--exit-r") + 1]) || 3;

const CACHE_DIR = path.join(os.tmpdir(), "sentinel-upstox-cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

const TOKEN = process.env.UPSTOX_ANALYTICS_TOKEN;
const HEADERS = { Accept: "application/json", Authorization: `Bearer ${TOKEN}` };
const fmt = (d: Date) => d.toISOString().slice(0, 10);

async function instrumentMap(): Promise<Map<string, string>> {
  const cache = path.join(CACHE_DIR, "nse-instruments.json");
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 24 * 3600 * 1000) {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(cache, "utf8"))));
  }
  const res = await fetch("https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz");
  const rows = JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString());
  const obj: Record<string, string> = {};
  for (const r of rows) {
    if (r.segment !== "NSE_EQ" || r.instrument_type !== "EQ") continue;
    const sym = (r.trading_symbol || r.tradingsymbol || "").toUpperCase().trim();
    if (sym) obj[sym] = r.instrument_key;
  }
  fs.writeFileSync(cache, JSON.stringify(obj));
  return new Map(Object.entries(obj));
}

/** Upstox caps 5-min history at ~30 days per call, so walk backwards in chunks. */
async function fetchCandles(symbol: string, key: string) {
  const cache = path.join(CACHE_DIR, `${symbol}-${MONTHS}m.json`);
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 12 * 3600 * 1000) {
    return JSON.parse(fs.readFileSync(cache, "utf8"));
  }

  const enc = encodeURIComponent(key);
  const out: any[] = [];
  let to = new Date();
  for (let chunk = 0; chunk < MONTHS; chunk++) {
    const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
    const url = `https://api.upstox.com/v3/historical-candle/${enc}/minutes/5/${fmt(to)}/${fmt(from)}`;
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) break;
      const j = await r.json();
      const rows = j?.data?.candles;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const t = Math.floor(Date.parse(row[0]) / 1000);
        if (!Number.isNaN(t)) out.push({ t, o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] });
      }
    } catch { break; }
    to = new Date(from.getTime() - 24 * 3600 * 1000);
  }

  const seen = new Set<number>();
  const bars = out.filter(b => !seen.has(b.t) && seen.add(b.t)).sort((a, b) => a.t - b.t);
  fs.writeFileSync(cache, JSON.stringify(bars));
  return bars;
}

function pct(arr: number[], p: number) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function main() {
  if (!TOKEN) { console.error("UPSTOX_ANALYTICS_TOKEN not set"); process.exit(1); }

  const map = await instrumentMap();
  const { rows } = await pool.query(
    `select symbol, count(distinct date) d from watchlist_snapshots
     where extract(dow from date::date) between 1 and 5
     group by symbol order by d desc, symbol limit $1`, [SYMBOL_CAP]
  );
  const universe = rows.map(r => r.symbol).filter(s => map.has(s.toUpperCase()));

  console.log(`\nORB(15m) + FVG(5m) backtest | Upstox 5-min history, ~${MONTHS} month(s)`);
  console.log(`Universe ${universe.length} symbols (of ${rows.length} watchlist names; rest unmapped)\n`);

  const all: any[] = [];
  let bars0 = 0, days = new Set<string>();
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(batch.map(async s => [s, await fetchCandles(s, map.get(s.toUpperCase())!)] as const));
    for (const [s, bars] of fetched) {
      if (!bars?.length) { bars0++; continue; }
      for (const b of bars) days.add(new Date((b.t + 19800) * 1000).toISOString().slice(0, 10));
      all.push(...runSymbol(s, bars, { exitR: EXIT_R }));
    }
    process.stdout.write(`\r  fetched ${Math.min(i + CONCURRENCY, universe.length)}/${universe.length}   `);
  }
  console.log("\n");

  all.sort((a, b) => a.date.localeCompare(b.date) || a.entryTime.localeCompare(b.entryTime));

  const wins = all.filter(t => t.points > 0), losses = all.filter(t => t.points < 0);
  const totalR = all.reduce((s, t) => s + t.rMultiple, 0);
  const byReason = all.reduce((m, t) => (m[t.reason] = (m[t.reason] || 0) + 1, m), {} as any);

  // ---- SL / target geometry: what this strategy actually risks per trade ----
  const riskPts = all.map(t => t.risk);
  const riskPctArr = all.map(t => (t.risk / t.entry) * 100);
  const t3PctArr = all.map(t => (Math.abs(t.t3 - t.entry) / t.entry) * 100);

  console.log("=".repeat(78));
  console.log("SL / TARGET GEOMETRY  (stop = opposite OR level, targets = 1R/2R/3R)");
  console.log("=".repeat(78));
  console.log(`Risk per trade (entry -> stop):`);
  console.log(`   points   min ${Math.min(...riskPts).toFixed(2)}  p25 ${pct(riskPts, 25).toFixed(2)}  median ${pct(riskPts, 50).toFixed(2)}  p75 ${pct(riskPts, 75).toFixed(2)}  max ${Math.max(...riskPts).toFixed(2)}`);
  console.log(`   % of px  min ${Math.min(...riskPctArr).toFixed(2)}  p25 ${pct(riskPctArr, 25).toFixed(2)}  median ${pct(riskPctArr, 50).toFixed(2)}  p75 ${pct(riskPctArr, 75).toFixed(2)}  max ${Math.max(...riskPctArr).toFixed(2)}`);
  console.log(`T3 distance from entry (3R):`);
  console.log(`   % of px  median ${pct(t3PctArr, 50).toFixed(2)}  max ${Math.max(...t3PctArr).toFixed(2)}`);

  console.log("\n" + "=".repeat(78));
  console.log("RESULTS");
  console.log("=".repeat(78));
  console.log(`Sessions covered ${days.size} | Trades ${all.length} | Longs ${all.filter(t => t.side === "BUY").length} Shorts ${all.filter(t => t.side === "SELL").length}`);
  console.log(`Wins ${wins.length}  Losses ${losses.length}  Hit rate ${all.length ? ((wins.length / all.length) * 100).toFixed(1) : 0}%`);
  console.log(`Total ${totalR >= 0 ? "+" : ""}${totalR.toFixed(1)}R  |  Expectancy ${all.length ? (totalR / all.length).toFixed(3) : 0}R per trade`);
  console.log(`Reached T1 ${all.filter(t => t.hit1).length}  T2 ${all.filter(t => t.hit2).length}  T3 ${all.filter(t => t.hit3).length}`);
  console.log(`Exits: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  const amb = all.filter(t => t.ambiguous).length;
  if (amb) console.log(`Ambiguous bars (stop AND T3 same bar, scored as stop): ${amb}`);
  if (bars0) console.log(`Symbols with no candle data: ${bars0}`);

  const byMonth = all.reduce((m, t) => { const k = t.date.slice(0, 7); (m[k] ||= []).push(t.rMultiple); return m; }, {} as any);
  console.log(`\nBy month:`);
  for (const [mth, rs] of Object.entries<any>(byMonth)) {
    const sum = rs.reduce((a, b) => a + b, 0);
    console.log(`  ${mth}  ${String(rs.length).padStart(4)} trades  ${sum >= 0 ? "+" : ""}${sum.toFixed(1)}R  (${((rs.filter(r => r > 0).length / rs.length) * 100).toFixed(0)}% win)`);
  }

  console.log(`\nWorst 5:`);
  [...all].sort((a, b) => a.rMultiple - b.rMultiple).slice(0, 5)
    .forEach(t => console.log(`  ${t.date} ${t.side} ${t.symbol.padEnd(12)} ${t.rMultiple.toFixed(2)}R  risk ${((t.risk / t.entry) * 100).toFixed(2)}% [${t.reason}]`));

  await pool.end();
}

main().catch(async e => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
