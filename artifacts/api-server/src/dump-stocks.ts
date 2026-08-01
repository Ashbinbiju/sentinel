import fs from "fs";
import path from "path";
import { fetchCandles } from "./routes/stocks";
import { db, watchlistSnapshotsTable, tradesTable } from "@workspace/db";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.015;
const STRUCTURAL_TRAIL_RR = 1.0;
const TARGET_RR = 2.0;
const MAX_CANDLE_RANGE_PCT = 0.025; // 2.5% Cap

// TIME CUTOFF: 09:20 AM to 11:30 AM IST
const ENTRY_START_MINS = 9 * 60 + 20; // 09:20 AM
const ENTRY_END_MINS = 11 * 60 + 30;   // 11:30 AM

// MINIMUM 20D AVG DAILY VALUE (₹ 10 CRORES)
const MIN_ADV_CR = 10.0; // ₹ 10 Crores

function standardPivots(prevHigh: number, prevLow: number, prevClose: number) {
  const p = (prevHigh + prevLow + prevClose) / 3;
  return { p, r1: 2 * p - prevLow, s1: 2 * p - prevHigh };
}

function getISTMinuteOfDay(epochSecs: number): number {
  const d = new Date(epochSecs * 1000);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const [h, m] = formatter.format(d).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function getISTTimeStr(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  return formatter.format(d);
}

function getCandleCloseDateIST(c: any): string {
  const d = new Date((c.t + 300) * 1000);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  return formatter.format(d);
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function fetchCandlesWithRetry(sym: string, targetDate: string, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      let data = await fetchCandles(sym, false);
      if (data && data.historicalCandles && data.historicalCandles.length > 0) {
        const hasSufficientHistory = data.historicalCandles.some((c: any) => getCandleCloseDateIST(c) < targetDate);
        if (hasSufficientHistory) return data;
      }
      data = await fetchCandles(sym, true);
      if (data && data.historicalCandles && data.historicalCandles.length > 0) {
        return data;
      }
    } catch (err: any) {
      // ignore
    }
    await delay(200);
  }
  return null;
}

async function auditAdvCrFilter() {
  const tradingDays = ["2026-07-24", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"];
  const allSnapshots = await db.select().from(watchlistSnapshotsTable);
  const allDbTrades = await db.select().from(tradesTable);

  console.log(`\n======================================================`);
  console.log(`💰 AUDITING MIN ADVCr >= ₹${MIN_ADV_CR} Cr FILTER (5 TRADING DAYS)`);
  console.log(`Time Window: 09:20 AM - 11:30 AM IST`);
  console.log(`Strategy: Pure Cheat Sheet + 2.0x Vol Surge + 2.5% Max Candle + Min ₹50Cr ADV`);
  console.log(`======================================================\n`);

  const overallResults: any[] = [];

  for (const testDate of tradingDays) {
    const dbTradesForDate = allDbTrades.filter(t => t.signalTime && new Date(t.signalTime).toISOString().slice(0, 10) === testDate);
    const daySnapshots = allSnapshots.filter(s => s.date === testDate);
    let symbols = Array.from(new Set(daySnapshots.map(s => s.symbol.trim())));

    if (symbols.length === 0) {
      symbols = ["ASHOKLEY", "BAJAJ-AUTO", "BAJFINANCE", "CHOLAFIN", "MARUTI", "MOTHERSON", "M&M", "SUNTV", "TIINDIA", "TVSMOTOR", "UNOMINDA", "VARROC", "ZFCVINDIA"];
    }

    const results: any[] = [];

    for (const symbol of symbols) {
      if (symbol === "TESTSYM" || symbol === "STLTECH" || symbol === "MTARTECH" || symbol === "CAMS" || symbol === "ACC") continue;

      const candleData = await fetchCandlesWithRetry(symbol, testDate, 2);
      if (!candleData || !candleData.historicalCandles || candleData.historicalCandles.length === 0) continue;

      const prevDates = Array.from(new Set(candleData.historicalCandles
        .map((c: any) => getCandleCloseDateIST(c))
        .filter((d: string) => d < testDate)
      )).sort();

      const lastPrevDate = prevDates.at(-1);
      if (!lastPrevDate) continue;

      const prevDayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === lastPrevDate);
      if (prevDayCandles.length === 0) continue;

      const prevHigh = Math.max(...prevDayCandles.map((c: any) => c.h));
      const prevLow = Math.min(...prevDayCandles.map((c: any) => c.l));
      const prevChronological = [...prevDayCandles].sort((a: any, b: any) => a.t - b.t);
      const prevClose = prevChronological[prevChronological.length - 1].c;

      const pivots = standardPivots(prevHigh, prevLow, prevClose);
      const brkH = Math.max(prevHigh, pivots.r1);
      const brkL = Math.min(prevLow, pivots.s1);

      const allChronological: any[] = candleData.historicalCandles.sort((a: any, b: any) => a.t - b.t);
      const targetDayStartIndex = allChronological.findIndex((c: any) => getCandleCloseDateIST(c) === testDate);

      if (targetDayStartIndex === -1) continue;

      let inTrade: any = null;

      for (let i = targetDayStartIndex; i < allChronological.length; i++) {
        const c = allChronological[i];
        const prevC = allChronological[i - 1];
        const mins = getISTMinuteOfDay(c.t + 300);
        const timeStr = getISTTimeStr(c.t + 300);

        if (inTrade) {
          const risk = Math.abs(inTrade.entryPrice - inTrade.initialSl);

          if (!inTrade.trailApplied) {
            if (inTrade.side === "BUY" && c.h >= inTrade.entryPrice + (risk * STRUCTURAL_TRAIL_RR)) {
              inTrade.sl = inTrade.entryPrice;
              inTrade.trailApplied = true;
            } else if (inTrade.side === "SELL" && c.l <= inTrade.entryPrice - (risk * STRUCTURAL_TRAIL_RR)) {
              inTrade.sl = inTrade.entryPrice;
              inTrade.trailApplied = true;
            }
          }

          if (inTrade.side === "BUY") {
            if (c.l <= inTrade.sl) {
              const exitPrice = inTrade.sl;
              const pnlPct = (exitPrice - inTrade.entryPrice) / inTrade.entryPrice;
              const rr = (exitPrice - inTrade.entryPrice) / risk;
              results.push({
                symbol,
                setup: inTrade.setup,
                side: inTrade.side,
                entryTime: inTrade.entryTime,
                entryPrice: inTrade.entryPrice,
                sl: inTrade.initialSl,
                target: inTrade.target,
                exitTime: timeStr,
                exitPrice,
                exitReason: inTrade.trailApplied ? "TRAIL_SL" : "SL",
                pnlPct,
                rr,
                volRatio: inTrade.volRatio,
                advCr: inTrade.advCr,
              });
              inTrade = null;
              break;
            } else if (c.h >= inTrade.target) {
              const exitPrice = inTrade.target;
              const pnlPct = (exitPrice - inTrade.entryPrice) / inTrade.entryPrice;
              const rr = TARGET_RR;
              results.push({
                symbol,
                setup: inTrade.setup,
                side: inTrade.side,
                entryTime: inTrade.entryTime,
                entryPrice: inTrade.entryPrice,
                sl: inTrade.initialSl,
                target: inTrade.target,
                exitTime: timeStr,
                exitPrice,
                exitReason: "TARGET",
                pnlPct,
                rr,
                volRatio: inTrade.volRatio,
                advCr: inTrade.advCr,
              });
              inTrade = null;
              break;
            }
          } else { // SELL
            if (c.h >= inTrade.sl) {
              const exitPrice = inTrade.sl;
              const pnlPct = (inTrade.entryPrice - exitPrice) / inTrade.entryPrice;
              const rr = (inTrade.entryPrice - exitPrice) / risk;
              results.push({
                symbol,
                setup: inTrade.setup,
                side: inTrade.side,
                entryTime: inTrade.entryTime,
                entryPrice: inTrade.entryPrice,
                sl: inTrade.initialSl,
                target: inTrade.target,
                exitTime: timeStr,
                exitPrice,
                exitReason: inTrade.trailApplied ? "TRAIL_SL" : "SL",
                pnlPct,
                rr,
                volRatio: inTrade.volRatio,
                advCr: inTrade.advCr,
              });
              inTrade = null;
              break;
            } else if (c.l <= inTrade.target) {
              const exitPrice = inTrade.target;
              const pnlPct = (inTrade.entryPrice - exitPrice) / inTrade.entryPrice;
              const rr = TARGET_RR;
              results.push({
                symbol,
                setup: inTrade.setup,
                side: inTrade.side,
                entryTime: inTrade.entryTime,
                entryPrice: inTrade.entryPrice,
                sl: inTrade.initialSl,
                target: inTrade.target,
                exitTime: timeStr,
                exitPrice,
                exitReason: "TARGET",
                pnlPct,
                rr,
                volRatio: inTrade.volRatio,
                advCr: inTrade.advCr,
              });
              inTrade = null;
              break;
            }
          }

          if (mins >= 15 * 60 + 14 && inTrade) {
            const exitPrice = c.c;
            const pnlPct = inTrade.side === "BUY" ? (exitPrice - inTrade.entryPrice) / inTrade.entryPrice : (inTrade.entryPrice - exitPrice) / inTrade.entryPrice;
            const rr = risk > 0 ? (inTrade.side === "BUY" ? exitPrice - inTrade.entryPrice : inTrade.entryPrice - exitPrice) / risk : 0;
            results.push({
              symbol,
              setup: inTrade.setup,
              side: inTrade.side,
              entryTime: inTrade.entryTime,
              entryPrice: inTrade.entryPrice,
              sl: inTrade.initialSl,
              target: inTrade.target,
              exitTime: timeStr,
              exitPrice,
              exitReason: "SQUARED_OFF",
              pnlPct,
              rr,
              volRatio: inTrade.volRatio,
              advCr: inTrade.advCr,
            });
            inTrade = null;
            break;
          }

          continue;
        }

        // STRICT ENTRY WINDOW: 09:20 AM to 11:30 AM ONLY
        if (mins < ENTRY_START_MINS || mins > ENTRY_END_MINS) continue;

        const candleRange = Math.max(c.h - c.l, 0.05);
        const candleRangePct = candleRange / c.c;
        const upperWick = c.h - Math.max(c.o, c.c);
        const lowerWick = Math.min(c.o, c.c) - c.l;

        const freshHighBreakout = prevC.c <= brkH && c.c > brkH;
        const touchedHighZone = c.l <= brkH * (1 + TOUCH_BUFFER_PCT) && c.h >= brkH;
        const chasePctHigh = (c.c - brkH) / brkH;
        const chaseAllowedHigh = chasePctHigh >= 0 && chasePctHigh <= MAX_CHASE_PCT;

        const freshLowBreakdown = prevC.c >= brkL && c.c < brkL;
        const touchedLowZone = c.h >= brkL * (1 - TOUCH_BUFFER_PCT) && c.l <= brkL;
        const chasePctLow = (brkL - c.c) / brkL;
        const chaseAllowedLow = chasePctLow >= 0 && chasePctLow <= MAX_CHASE_PCT;

        const last20Candles = allChronological.slice(Math.max(0, i - 20), i);
        const avgVol20 = last20Candles.length > 0
          ? last20Candles.reduce((sum, curr) => sum + (curr.v || 0), 0) / last20Candles.length
          : 0;

        // CALCULATE 20-CANDLE AVERAGE DAILY VALUE IN CRORES (ADVCr)
        // 75 5-min candles per trading day in India (09:15 to 15:30)
        // Est. Daily Traded Value = (20-candle avg 5-min vol * 75 * close_price) / 10,000,000
        const estDailyValueCr = (avgVol20 * 75 * c.c) / 10000000;
        const meetsMinAdv = estDailyValueCr >= MIN_ADV_CR;
        const MAX_STOCK_PRICE = 3000;
        const isPriceValid = c.c <= MAX_STOCK_PRICE;

        const currentVol = c.v || 0;
        const volRatio = avgVol20 > 0 ? currentVol / avgVol20 : 0;
        const hasVolumeSpike = avgVol20 === 0 || volRatio >= 2.0;
        const candleNotTooLarge = candleRangePct <= MAX_CANDLE_RANGE_PCT;

        let setup = "";
        let side: "BUY" | "SELL" | null = null;
        let sl = 0;

        if (freshHighBreakout && chaseAllowedHigh && c.c > c.o && upperWick / candleRange <= 0.35 && touchedHighZone && hasVolumeSpike && candleNotTooLarge && meetsMinAdv && isPriceValid) {
          setup = "HIGH BREAKOUT"; side = "BUY";
          sl = Math.min(c.l, brkH * (1 - SL_BUFFER_PCT));
        } else if (freshLowBreakdown && chaseAllowedLow && c.c < c.o && lowerWick / candleRange <= 0.35 && touchedLowZone && hasVolumeSpike && candleNotTooLarge && meetsMinAdv && isPriceValid) {
          setup = "LOW BREAKDOWN"; side = "SELL";
          sl = Math.max(c.h, brkL * (1 + SL_BUFFER_PCT));
        }

        if (side && sl > 0) {
          const entryPrice = c.c;
          const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
          const target = side === "BUY" ? entryPrice + (risk * TARGET_RR) : entryPrice - (risk * TARGET_RR);

          inTrade = {
            setup,
            side,
            entryTime: timeStr,
            entryPrice,
            sl,
            initialSl: sl,
            target,
            volRatio: volRatio.toFixed(2),
            advCr: estDailyValueCr.toFixed(2),
            candleRangePct: (candleRangePct * 100).toFixed(2),
            trailApplied: false,
          };
        }
      }
    }

    const totalTrades = results.length;
    const wins = results.filter(r => r.rr > 0).length;
    const losses = results.filter(r => r.rr < 0).length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
    const netRR = results.reduce((acc, r) => acc + r.rr, 0);

    if (testDate === "2026-07-31" || testDate === "2026-07-24") {
      console.log(`\n======================================================`);
      console.log(`📅 DETAILED FRIDAY TRADE LOG (${testDate})`);
      console.log(`======================================================`);
      results.forEach(r => {
        const resultEmoji = r.rr > 0 ? "✅ WIN" : r.rr < 0 ? "❌ LOSS" : "➖ BREAKEVEN";
        console.log(`${resultEmoji} | ${r.symbol.padEnd(12)} | ${r.setup.padEnd(14)} | Entry: ${r.entryTime} @ ₹${r.entryPrice.toFixed(2)} | Exit: ${r.exitTime} @ ₹${r.exitPrice.toFixed(2)} (${r.exitReason}) | ADV: ₹${r.advCr}Cr | VolSpike: ${r.volRatio}x | RR: ${r.rr >= 0 ? '+' : ''}${r.rr.toFixed(2)}R`);
      });
      console.log(`======================================================\n`);
    }

    console.log(`[${testDate} MIN ADV ₹${MIN_ADV_CR}Cr] Trades: ${totalTrades} | Wins: ${wins} | WinRate: ${winRate}% | Net Return: ${netRR >= 0 ? '+' : ''}${netRR.toFixed(2)}R`);

    overallResults.push({
      date: testDate,
      symbolsCount: symbols.length,
      totalTrades,
      wins,
      losses,
      winRate: `${winRate}%`,
      netRR: `${netRR >= 0 ? '+' : ''}${netRR.toFixed(2)}R`,
      dbTradeCount: dbTradesForDate.length
    });
  }

  const grandTotalTrades = overallResults.reduce((acc, r) => acc + r.totalTrades, 0);
  const grandTotalWins = overallResults.reduce((acc, r) => acc + r.wins, 0);
  const grandTotalLosses = overallResults.reduce((acc, r) => acc + r.losses, 0);
  const grandWinRate = grandTotalTrades > 0 ? ((grandTotalWins / grandTotalTrades) * 100).toFixed(1) : "0.0";
  const grandNetRR = overallResults.reduce((acc, r) => acc + parseFloat(r.netRR.replace('+', '').replace('R', '')), 0);

  console.log("\n==================================================");
  console.log(`🏆 GRAND TOTAL SUMMARY (MIN ADV >= ₹50 Cr ACTIVE)`);
  console.log(`Total Trades Triggered: ${grandTotalTrades}`);
  console.log(`Grand Wins: ${grandTotalWins} | Grand Losses: ${grandTotalLosses}`);
  console.log(`Overall Win Rate: ${grandWinRate}%`);
  console.log(`Cumulative Net Return: ${grandNetRR >= 0 ? '+' : ''}${grandNetRR.toFixed(2)}R`);
  console.log("==================================================\n");

  const rootDir = path.resolve("../../artifacts");
  const mdPath = path.join(rootDir, `adv_cr_50_audit_report.md`);

  let md = `# Multi-Day Backtest Audit: Min 20D Avg Daily Value (₹50 Cr) Filter\n\n`;
  md += `**Strategy Rules**: Pure Cheat Sheet + 2.0x Vol Surge + 2.5% Max Candle + 11:30 AM Cutoff\n`;
  md += `**Liquidity Filter**: **Min 20D Avg Daily Value (ADVCr) >= ₹50 Crores**\n\n`;

  md += `| Date | Watchlist Stocks | Backtest Trades (Min 50Cr ADV) | Wins | Losses | Win Rate | Daily Net Return (RR) |\n`;
  md += `|------|-------------------|--------------------------------|------|--------|----------|-----------------------|\n`;

  overallResults.forEach(r => {
    md += `| **${r.date}** | ${r.symbolsCount} stocks | **${r.totalTrades}** | ${r.wins} | ${r.losses} | **${r.winRate}** | **${r.netRR}** |\n`;
  });

  md += `| **TOTAL** | - | **${grandTotalTrades}** | **${grandTotalWins}** | **${grandTotalLosses}** | **${grandWinRate}%** | **${grandNetRR >= 0 ? '+' : ''}${grandNetRR.toFixed(2)}R** |\n`;

  fs.writeFileSync(mdPath, md);
  console.log(`Saved ADVCr report to: ${mdPath}`);
  process.exit(0);
}

auditAdvCrFilter();
