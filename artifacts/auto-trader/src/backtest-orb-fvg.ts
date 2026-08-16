// @ts-nocheck
/**
 * Backtest: 15-min Opening Range breakout + 5-min FVG confirmation.
 *
 * Port of the "NSE ORB 15m + FVG 5m" Pine indicator, using its defaults:
 *   - Opening range = high/low of 09:15-09:30, locked at 09:30.
 *   - BUY  when a 5-min bar CLOSES above the OR high (having closed at/below it
 *     on the previous bar) AND an unmitigated bullish FVG is live.
 *   - SELL is the mirror image against the OR low.
 *   - FVG (5-min): bullish when low > high[2], bearish when high < low[2];
 *     must be >= FVG_MIN_PCT of price, expires after FVG_LOOKBACK bars, and is
 *     dropped once mitigated.
 *   - Signals only inside 09:30-15:00, max one per side per day.
 *   - Stop = opposite OR level. Targets = 1R / 2R / 3R off that risk.
 *   - Exit on T3, stop, or 15:15 square-off.
 *
 * MUST run where the api-server is reachable (it sources the candles).
 *   npx tsx --env-file=../../.env src/backtest-orb-fvg.ts
 *   npx tsx --env-file=../../.env src/backtest-orb-fvg.ts --symbols 40
 */
import axios from "axios";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { aggregateCandles } from "./nine-ema-vwap.js";

const FVG_LOOKBACK = 12;
const FVG_MIN_PCT = 0.03;
const FVG_UNMITIGATED_ONLY = true;
const REQUIRE_FVG = true;
const R1 = 1.0, R2 = 2.0, R3 = 3.0;

const OR_START = 9 * 60 + 15;
const OR_END = 9 * 60 + 30;
const SIG_END = 15 * 60;
const EOD = 15 * 60 + 15;

const CAPITAL = parseFloat(process.env.BACKTEST_CAPITAL || "50000");
const LEVERAGE = 5;
const API_BASE = process.env.API_URL || "http://localhost:3000";

const argIdx = process.argv.indexOf("--symbols");
const SYMBOL_CAP = argIdx > -1 ? parseInt(process.argv[argIdx + 1], 10) : 60;

const istMin = (t: number) => { const d = new Date(t * 1000); d.setUTCMinutes(d.getUTCMinutes() + 330); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDate = (t: number) => { const d = new Date(t * 1000); d.setUTCMinutes(d.getUTCMinutes() + 330); return d.toISOString().slice(0, 10); };
const istTime = (t: number) => { const d = new Date(t * 1000); d.setUTCMinutes(d.getUTCMinutes() + 330); return d.toISOString().substring(11, 16); };

async function getBars(symbol: string) {
  try {
    const res = await axios.get(`${API_BASE}/api/stocks/${symbol}/candles`, { timeout: 15000 });
    const raw = [...(res.data?.historicalCandles || []), ...(res.data?.sessionCandles || [])].sort((a, b) => a.t - b.t);
    const agg = raw.length ? aggregateCandles(raw, 300) : [];
    return agg.length ? agg : null;
  } catch {
    return null;
  }
}

/** Walks one symbol's full 5-min series, Pine-style: FVG state is continuous, OR/signal state resets daily. */
export function runSymbol(symbol: string, bars: any[]) {
  const trades: any[] = [];
  const bull: any[] = [], bear: any[] = [];

  let curDate = "", orH = NaN, orL = NaN, orLocked = false, tookL = false, tookS = false;
  let open: any = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const date = istDate(b.t);
    const min = istMin(b.t);

    if (date !== curDate) {
      // Pine squares off at 15:15, so nothing should survive the boundary. If a
      // day's bars simply ran out, close it on the last bar we did see.
      if (open) { closeTrade(open, open.lastClose, open.lastTime, "EOD (data ended)"); open = null; }
      curDate = date; orH = NaN; orL = NaN; orLocked = false; tookL = false; tookS = false;
    }

    const inOR = min >= OR_START && min < OR_END;
    if (inOR) {
      orH = Number.isNaN(orH) ? b.h : Math.max(orH, b.h);
      orL = Number.isNaN(orL) ? b.l : Math.min(orL, b.l);
    }
    if (!inOR && !Number.isNaN(orH) && !orLocked) orLocked = true;

    // ---- manage an open position (never on its own entry bar, matching Pine) ----
    if (open && i > open.idx) {
      open.lastClose = b.c; open.lastTime = istTime(b.t);
      const long = open.side === "BUY";

      // Conservative on intrabar ordering: 5-min OHLC cannot say whether the
      // high or the low came first, so a bar touching BOTH stop and target is
      // scored as the stop. The Pine indicator resolves it the other way
      // (targets first), which is why it will look rosier than this.
      const stopHit = long ? b.l <= open.sl : b.h >= open.sl;
      const t3Hit = long ? b.h >= open.t3 : b.l <= open.t3;
      if (stopHit && t3Hit) open.ambiguous = true;

      if (!open.hit1 && (long ? b.h >= open.t1 : b.l <= open.t1)) open.hit1 = true;
      if (!open.hit2 && (long ? b.h >= open.t2 : b.l <= open.t2)) open.hit2 = true;

      if (stopHit) { closeTrade(open, open.sl, istTime(b.t), "STOP"); open = null; }
      else if (t3Hit) { open.hit3 = true; closeTrade(open, open.t3, istTime(b.t), "T3"); open = null; }
      else if (min >= EOD) { closeTrade(open, b.c, istTime(b.t), "SQUARE-OFF 15:15"); open = null; }
    }

    // ---- FVG bookkeeping ----
    if (i >= 2) {
      const minGap = (b.c * FVG_MIN_PCT) / 100;
      if (b.l > bars[i - 2].h && b.l - bars[i - 2].h >= minGap) bull.push({ top: b.l, bot: bars[i - 2].h, bar: i });
      if (b.h < bars[i - 2].l && bars[i - 2].l - b.h >= minGap) bear.push({ top: bars[i - 2].l, bot: b.h, bar: i });
    }
    for (let k = bull.length - 1; k >= 0; k--) {
      const f = bull[k];
      if ((FVG_UNMITIGATED_ONLY && i > f.bar && b.l <= f.bot) || i - f.bar > FVG_LOOKBACK) bull.splice(k, 1);
    }
    for (let k = bear.length - 1; k >= 0; k--) {
      const f = bear[k];
      if ((FVG_UNMITIGATED_ONLY && i > f.bar && b.h >= f.top) || i - f.bar > FVG_LOOKBACK) bear.splice(k, 1);
    }

    // ---- breakout signal ----
    const ready = orLocked && !Number.isNaN(orH) && !Number.isNaN(orL) && orH - orL > 0 && min >= OR_END && min < SIG_END;
    if (!ready || open || i === 0) continue;

    const prev = bars[i - 1];
    const upTrig = b.c > orH && prev.c <= orH;
    const dnTrig = b.c < orL && prev.c >= orL;

    if (upTrig && !tookL && (!REQUIRE_FVG || bull.length > 0)) {
      const entry = b.c, sl = orL, risk = entry - sl;
      if (risk > 0) {
        tookL = true;
        open = mkTrade(symbol, date, "BUY", entry, sl, risk, i, istTime(b.t), bull.length, bear.length);
      }
    } else if (dnTrig && !tookS && (!REQUIRE_FVG || bear.length > 0)) {
      const entry = b.c, sl = orH, risk = sl - entry;
      if (risk > 0) {
        tookS = true;
        open = mkTrade(symbol, date, "SELL", entry, sl, risk, i, istTime(b.t), bull.length, bear.length);
      }
    }
  }

  if (open) closeTrade(open, open.lastClose ?? open.entry, open.lastTime ?? open.entryTime, "EOD (data ended)");
  return trades;

  function mkTrade(sym, date, side, entry, sl, risk, idx, entryTime, nb, ns) {
    const sign = side === "BUY" ? 1 : -1;
    return {
      symbol: sym, date, side, entry, sl, risk, idx, entryTime,
      t1: entry + sign * risk * R1, t2: entry + sign * risk * R2, t3: entry + sign * risk * R3,
      hit1: false, hit2: false, hit3: false, ambiguous: false,
      bullFvgs: nb, bearFvgs: ns, lastClose: entry, lastTime: entryTime,
    };
  }

  function closeTrade(tr, exit, exitTime, reason) {
    const sign = tr.side === "BUY" ? 1 : -1;
    const points = (exit - tr.entry) * sign;
    const qty = Math.floor((CAPITAL * LEVERAGE) / tr.entry);
    trades.push({ ...tr, exit, exitTime, reason, points, rMultiple: points / tr.risk, qty, pnl: points * qty });
  }
}

async function main() {
  console.log(`\nBACKTEST: 15m Opening Range breakout + 5m FVG`);
  console.log(`Stop = opposite OR level | Targets 1R/2R/3R | exit on T3, stop, or 15:15`);
  console.log(`FVG: >=${FVG_MIN_PCT}% of price, ${FVG_LOOKBACK}-bar life, unmitigated only | Capital Rs.${CAPITAL} @ ${LEVERAGE}x\n`);

  const { rows } = await pool.query(
    `select symbol, count(distinct date) d from watchlist_snapshots
     where extract(dow from date::date) between 1 and 5
     group by symbol order by d desc, symbol limit $1`, [SYMBOL_CAP]
  );
  const symbols = rows.map(r => r.symbol);
  console.log(`Universe: ${symbols.length} symbols from watchlist history\n`);

  const all: any[] = [];
  let noData = 0;
  for (const s of symbols) {
    const bars = await getBars(s);
    if (!bars) { noData++; continue; }
    all.push(...runSymbol(s, bars));
  }

  all.sort((a, b) => a.date.localeCompare(b.date) || a.entryTime.localeCompare(b.entryTime));

  console.log("".padEnd(118, "-"));
  for (const t of all) {
    const tag = t.points > 0 ? "WIN " : t.points < 0 ? "LOSS" : "FLAT";
    console.log(
      `${t.date} ${tag} ${t.side.padEnd(4)} ${t.symbol.padEnd(12)} ` +
      `in ${t.entry.toFixed(2).padStart(8)}@${t.entryTime} sl ${t.sl.toFixed(2).padStart(8)} ` +
      `out ${t.exit.toFixed(2).padStart(8)}@${t.exitTime} ` +
      `${t.rMultiple >= 0 ? "+" : ""}${t.rMultiple.toFixed(2).padStart(6)}R  Rs.${t.pnl.toFixed(0).padStart(8)} ` +
      `[${t.reason}]${t.ambiguous ? " *" : ""}`
    );
  }
  console.log("".padEnd(118, "-"));

  const wins = all.filter(t => t.points > 0), losses = all.filter(t => t.points < 0);
  const totalR = all.reduce((s, t) => s + t.rMultiple, 0);
  const totalPnl = all.reduce((s, t) => s + t.pnl, 0);
  const byReason = all.reduce((m, t) => (m[t.reason] = (m[t.reason] || 0) + 1, m), {});

  console.log(`\nTrades ${all.length} | Wins ${wins.length} Losses ${losses.length} | ` +
    `Hit rate ${all.length ? ((wins.length / all.length) * 100).toFixed(1) : "0"}%`);
  console.log(`Total ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R | Rs.${totalPnl.toFixed(2)} | ` +
    `Expectancy ${all.length ? (totalR / all.length).toFixed(3) : "0"}R/trade`);
  console.log(`Reached T1 ${all.filter(t => t.hit1).length} | T2 ${all.filter(t => t.hit2).length} | T3 ${all.filter(t => t.hit3).length}`);
  console.log(`Exits: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`Longs ${all.filter(t => t.side === "BUY").length} | Shorts ${all.filter(t => t.side === "SELL").length}`);
  const amb = all.filter(t => t.ambiguous).length;
  if (amb) console.log(`* ${amb} trade(s) hit stop AND T3 in the same bar - scored as the stop. TradingView scores these as wins, so it will look better there.`);
  if (noData) console.log(`Symbols with no candle data: ${noData}`);
  console.log(`\nPnL assumes the full Rs.${CAPITAL} at ${LEVERAGE}x on EVERY signal, which is not survivable`);
  console.log(`with concurrent trades - read the R figures, not the rupees.\n`);

  await pool.end();
}

// Only run the (DB + API hitting) driver when invoked directly, so runSymbol
// can be imported and unit-tested without touching the network.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch(async e => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
}
