import fs from "fs";
import path from "path";
import { fetchCandles } from "./routes/stocks";
import { db, watchlistSnapshotsTable, eq } from "@workspace/db";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.015;
const STRUCTURAL_TRAIL_RR = 1.0;
const TARGET_RR = 2.0;

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

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function fetchCandlesWithRetry(sym: string, targetDate: string, retries = 3) {
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
    await delay(300);
  }
  return null;
}

async function runVolumeBacktest(volMultiplier: number) {
  const testDate = "2026-07-31";
  console.log(`\n======================================================`);
  console.log(`🚀 VOLUME FILTER BACKTEST (Multiplier: ${volMultiplier}x 20-candle MA)`);
  console.log(`======================================================\n`);

  const snapshots = await db
    .select({ symbol: watchlistSnapshotsTable.symbol })
    .from(watchlistSnapshotsTable)
    .where(eq(watchlistSnapshotsTable.date, testDate))
    .groupBy(watchlistSnapshotsTable.symbol);

  let symbols = snapshots.map(s => s.symbol.trim());
  if (symbols.length === 0) {
    symbols = ["ASHOKLEY", "BAJAJ-AUTO", "BAJFINANCE", "CHOLAFIN", "MARUTI", "MOTHERSON", "M&M", "SUNTV", "TIINDIA", "TVSMOTOR", "UNOMINDA", "VARROC", "ZFCVINDIA"];
  }

  const results: any[] = [];
  const rejectedByVol: any[] = [];

  for (const symbol of symbols) {
    if (symbol === "STLTECH" || symbol === "MTARTECH" || symbol === "CAMS" || symbol === "ACC") continue;

    const candleData = await fetchCandlesWithRetry(symbol, testDate, 3);
    if (!candleData || !candleData.historicalCandles || candleData.historicalCandles.length === 0) {
      continue;
    }

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

    const allChronological: Candle[] = candleData.historicalCandles.sort((a: any, b: any) => a.t - b.t);
    const targetDayStartIndex = allChronological.findIndex((c: any) => getCandleCloseDateIST(c) === testDate);

    if (targetDayStartIndex === -1) continue;

    let inTrade: any = null;

    for (let i = targetDayStartIndex; i < allChronological.length; i++) {
      const c = allChronological[i];
      const prevC = allChronological[i - 1];
      const mins = getISTMinuteOfDay(c.t + 300);
      const timeStr = getISTTimeStr(c.t + 300);

      // Exits logic
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
              volRatio: inTrade.volRatio
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
              volRatio: inTrade.volRatio
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
              volRatio: inTrade.volRatio
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
              volRatio: inTrade.volRatio
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
            volRatio: inTrade.volRatio
          });
          inTrade = null;
          break;
        }

        continue;
      }

      if (mins < 9 * 60 + 20 || mins > 15 * 60 + 15) continue;

      const candleRange = Math.max(c.h - c.l, 0.05);
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

      // Calculate 20-candle Volume Moving Average
      const last20Candles = allChronological.slice(Math.max(0, i - 20), i);
      const avgVol20 = last20Candles.length > 0
        ? last20Candles.reduce((sum, curr) => sum + (curr.v || 0), 0) / last20Candles.length
        : 0;

      const currentVol = c.v || 0;
      const volRatio = avgVol20 > 0 ? currentVol / avgVol20 : 0;
      const hasVolumeSpike = volMultiplier === 0 || volRatio >= volMultiplier;

      let setup = "";
      let side: "BUY" | "SELL" | null = null;
      let sl = 0;

      if (freshHighBreakout && chaseAllowedHigh && c.c > c.o && upperWick / candleRange <= 0.35 && touchedHighZone) {
        if (hasVolumeSpike) {
          setup = "HIGH BREAKOUT"; side = "BUY";
          sl = Math.min(c.l, brkH * (1 - SL_BUFFER_PCT));
        } else {
          rejectedByVol.push({ symbol, time: timeStr, volRatio: volRatio.toFixed(2), required: volMultiplier });
        }
      } else if (freshLowBreakdown && chaseAllowedLow && c.c < c.o && lowerWick / candleRange <= 0.35 && touchedLowZone) {
        if (hasVolumeSpike) {
          setup = "LOW BREAKDOWN"; side = "SELL";
          sl = Math.max(c.h, brkL * (1 + SL_BUFFER_PCT));
        } else {
          rejectedByVol.push({ symbol, time: timeStr, volRatio: volRatio.toFixed(2), required: volMultiplier });
        }
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
          trailApplied: false,
        };
      }
    }
  }

  const totalTrades = results.length;
  const wins = results.filter(r => r.rr > 0).length;
  const losses = results.filter(r => r.rr < 0).length;
  const netRR = results.reduce((acc, r) => acc + r.rr, 0);

  console.log(`Total Trades: ${totalTrades} | Wins: ${wins} | Losses: ${losses} | Net Return: ${netRR.toFixed(2)}R`);
  console.log(`Volume Filter Rejected Setups: ${rejectedByVol.length}`);

  const rootDir = path.resolve("../../artifacts");
  const mdPath = path.join(rootDir, `volume_surge_backtest_${volMultiplier}x_2026-07-31.md`);

  let md = `# Volume Surge Filter Backtest (${volMultiplier === 0 ? 'No Vol Filter' : volMultiplier + 'x 20-Candle MA Filter'})\n\n`;
  md += `**Condition**: Current 5m Candle Volume >= **${volMultiplier}x** average volume of last 20 candles.\n`;
  md += `**Total Trades**: ${totalTrades}\n`;
  md += `**Net Return**: **${netRR >= 0 ? '+' : ''}${netRR.toFixed(2)}R**\n\n`;

  md += `| Symbol | Setup | Side | Time | Price | Vol Surge Ratio | Exit Reason | Return (RR) |\n`;
  md += `|--------|-------|------|------|-------|-----------------|-------------|-------------|\n`;

  results.forEach(r => {
    md += `| **${r.symbol}** | \`${r.setup}\` | **${r.side}** | ${r.entryTime} | ₹${r.entryPrice} | **${r.volRatio}x** | \`${r.exitReason}\` | **${r.rr >= 0 ? '+' : ''}${r.rr.toFixed(2)}R** |\n`;
  });

  fs.writeFileSync(mdPath, md);
  console.log(`Saved report to: ${mdPath}`);
}

async function main() {
  await runVolumeBacktest(0);   // Baseline (Standard Cheat Sheet)
  await runVolumeBacktest(1.5); // 1.5x Volume Spike
  await runVolumeBacktest(2.0); // 2.0x Volume Spike (User requested)
  process.exit(0);
}

main();
