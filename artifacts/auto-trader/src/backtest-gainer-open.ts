// @ts-nocheck
/**
 * Backtest: buy the top gainer at 09:20, no indicators.
 *
 * Rules (as specified):
 *   - Universe: the gainer watchlist as it actually stood near 09:20, read from
 *     the watchlist_snapshots table (real recorded history, not reconstructed).
 *   - Filter: reject anything already up more than MAX_GAP_PCT on the day.
 *   - Entry: open of the 09:20 five-minute bar.
 *   - Stop: fixed STOP_POINTS below entry.
 *   - Trail: the same staircase the live engine uses - every TARGET_POINTS of
 *     favourable movement locks in that much profit (at +5 the stop moves to
 *     entry+5, at +10 to entry+10, and so on). No fixed target; the trail is
 *     the only profitable exit.
 *   - Square off at 15:15 if still open.
 *
 * MUST run on the box where the api-server is reachable (it proxies the candle
 * data). Usage:  npx tsx src/backtest-gainer-open.ts
 */
import axios from "axios";
import { pool } from "@workspace/db";
import { aggregateCandles } from "./nine-ema-vwap.js";

const TARGET_POINTS = 5;      // staircase step / profit lock
const STOP_POINTS = 5;        // initial stop distance
const MAX_GAP_PCT = 3;        // reject if already up more than this at entry
const CAPITAL = parseFloat(process.env.BACKTEST_CAPITAL || "50000");
const LEVERAGE = 5;
const POSITIONS_PER_DAY = 1;

const ENTRY_MIN = 9 * 60 + 20;
const SQUAREOFF_MIN = 15 * 60 + 15;
const API_BASE = process.env.API_URL || "http://localhost:3000";

function istMinuteOfDay(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function istDateStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().slice(0, 10);
}

function istTimeStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().substring(11, 16);
}

const candleCache = new Map<string, any[] | null>();

async function getCandles(symbol: string): Promise<any[] | null> {
  if (candleCache.has(symbol)) return candleCache.get(symbol)!;
  try {
    const res = await axios.get(`${API_BASE}/api/stocks/${symbol}/candles`, { timeout: 15000 });
    const raw = [
      ...(res.data?.historicalCandles || []),
      ...(res.data?.sessionCandles || []),
    ].sort((a: any, b: any) => a.t - b.t);
    const agg = raw.length ? aggregateCandles(raw, 300) : [];
    candleCache.set(symbol, agg.length ? agg : null);
    return candleCache.get(symbol)!;
  } catch {
    candleCache.set(symbol, null);
    return null;
  }
}

/**
 * Walks one day's bars from entry. Deliberately pessimistic on ordering: within
 * a bar the stop is checked BEFORE the trail is raised, because 5-minute OHLC
 * cannot say whether the high or the low came first. A bar that ran up enough to
 * lock profit and then collapsed is scored as the loss, never the win.
 */
function simulate(bars: any[], entryIdx: number, entry: number) {
  let stop = entry - STOP_POINTS;
  let lockedMilestones = 0;

  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i];
    const closeMin = istMinuteOfDay(bar.t) + 5;

    if (bar.l <= stop) {
      return { exit: stop, exitTime: istTimeStr(bar.t), reason: lockedMilestones > 0 ? `TRAIL +${lockedMilestones * TARGET_POINTS}` : "STOP" };
    }

    const favourable = bar.h - entry;
    if (favourable >= TARGET_POINTS) {
      const milestones = Math.floor(favourable / TARGET_POINTS);
      if (milestones > lockedMilestones) {
        lockedMilestones = milestones;
        stop = Math.max(stop, entry + milestones * TARGET_POINTS);
      }
    }

    if (closeMin >= SQUAREOFF_MIN) {
      return { exit: bar.c, exitTime: istTimeStr(bar.t), reason: "SQUARE-OFF 15:15" };
    }
  }

  const last = bars[bars.length - 1];
  return { exit: last.c, exitTime: istTimeStr(last.t), reason: "EOD (no more bars)" };
}

async function run() {
  console.log(`\nBACKTEST: top gainer at 09:20 | stop -${STOP_POINTS} | staircase trail +${TARGET_POINTS} | gap filter <=${MAX_GAP_PCT}%`);
  console.log(`Capital Rs.${CAPITAL} at ${LEVERAGE}x | ${POSITIONS_PER_DAY} position/day\n`);
  console.log("".padEnd(100, "-"));

  // Earliest snapshot per date inside the 09:15-09:30 window. Weekend rows are
  // stale screener data (market shut) and are excluded.
  const { rows } = await pool.query(`
    with early as (
      select date, min(time) as t
      from watchlist_snapshots
      where time between '09:15' and '09:30'
        and extract(dow from date::date) between 1 and 5
      group by date
    )
    select w.date, w.time, w.symbol, w.ltp::float as ltp, w.price_change_pct::float as pct
    from watchlist_snapshots w
    join early e on e.date = w.date and e.t = w.time
    order by w.date, w.price_change_pct desc
  `);

  const byDate = new Map<string, any[]>();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }

  const results: any[] = [];
  let skippedNoCandles = 0;
  let skippedNoneQualified = 0;

  for (const [date, all] of byDate) {
    const qualified = all.filter(r => Number.isFinite(r.pct) && r.pct > 0 && r.pct <= MAX_GAP_PCT);
    const rejected = all.filter(r => Number.isFinite(r.pct) && r.pct > MAX_GAP_PCT);

    if (qualified.length === 0) {
      console.log(`${date}  no qualifying gainer (${all.length} in list, ${rejected.length} rejected >${MAX_GAP_PCT}%)`);
      skippedNoneQualified++;
      continue;
    }

    let taken = 0;
    for (const cand of qualified) {
      if (taken >= POSITIONS_PER_DAY) break;

      const bars = await getCandles(cand.symbol);
      if (!bars) { skippedNoCandles++; continue; }

      const dayBars = bars.filter(b => istDateStr(b.t) === date);
      const entryIdx = dayBars.findIndex(b => istMinuteOfDay(b.t) === ENTRY_MIN);
      if (entryIdx < 0) { skippedNoCandles++; continue; }

      const entry = dayBars[entryIdx].o;
      if (!Number.isFinite(entry) || entry <= 0) { skippedNoCandles++; continue; }

      const qty = Math.floor((CAPITAL * LEVERAGE) / entry);
      if (qty < 1) continue;

      const out = simulate(dayBars, entryIdx, entry);
      const points = out.exit - entry;
      const pnl = points * qty;
      results.push({ date, symbol: cand.symbol, gapPct: cand.pct, entry, ...out, points, qty, pnl });
      taken++;

      const flag = points > 0 ? "WIN " : points < 0 ? "LOSS" : "FLAT";
      console.log(
        `${date}  ${flag}  ${cand.symbol.padEnd(12)} gap ${cand.pct.toFixed(2).padStart(5)}%  ` +
        `entry ${entry.toFixed(2).padStart(8)} -> exit ${out.exit.toFixed(2).padStart(8)} @ ${out.exitTime}  ` +
        `${points >= 0 ? "+" : ""}${points.toFixed(2).padStart(7)} pts  Rs.${pnl.toFixed(0).padStart(8)}  [${out.reason}]`
      );
    }
    if (taken === 0) console.log(`${date}  qualified but no usable candle data`);
  }

  console.log("".padEnd(100, "-"));
  const wins = results.filter(r => r.points > 0);
  const losses = results.filter(r => r.points < 0);
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const totalPts = results.reduce((s, r) => s + r.points, 0);

  console.log(`\nTrades: ${results.length}  |  Wins: ${wins.length}  Losses: ${losses.length}  ` +
    `|  Hit rate: ${results.length ? ((wins.length / results.length) * 100).toFixed(1) : "0"}%`);
  console.log(`Total: ${totalPts >= 0 ? "+" : ""}${totalPts.toFixed(2)} pts  |  Rs.${totalPnl.toFixed(2)}  ` +
    `|  Return on Rs.${CAPITAL}: ${((totalPnl / CAPITAL) * 100).toFixed(2)}%`);
  if (wins.length) console.log(`Avg win:  +${(wins.reduce((s, r) => s + r.points, 0) / wins.length).toFixed(2)} pts`);
  if (losses.length) console.log(`Avg loss: ${(losses.reduce((s, r) => s + r.points, 0) / losses.length).toFixed(2)} pts`);
  if (skippedNoCandles) console.log(`Skipped (no candle data): ${skippedNoCandles}`);
  if (skippedNoneQualified) console.log(`Days with no qualifying gainer: ${skippedNoneQualified}`);

  console.log(
    `\nSample size is ${results.length} trades. That is far too small to conclude anything about edge -\n` +
    `treat this as a sanity check on the mechanics, not evidence the strategy works.\n`
  );

  await pool.end();
}

run().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
