// @ts-nocheck
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { db } from '@workspace/db';
import { watchlistSnapshotsTable } from '@workspace/db/schema';
import { desc, eq } from 'drizzle-orm';
import axios from 'axios';
import { computeUTBot } from './ut-bot.js';

const MAX_DAILY_TRADES = 100;
const MAX_PER_STOCK = 1;

function getISTMinuteOfDay(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function getISTTimeStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().substring(11, 16);
}

function getEpochDateStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().slice(0, 10);
}

function aggregateCandles(candles: any[], timeframeSecs: number) {
  const timeframeMins = timeframeSecs / 60;
  const buckets = new Map<string, any>();
  const ENTRY_SIGNAL_START_MIN_IST = 9 * 60 + 15;

  for (const cd of candles) {
    const mins = getISTMinuteOfDay(cd.t);
    const relMins = Math.max(0, mins - ENTRY_SIGNAL_START_MIN_IST);
    const bucketIndex = Math.floor(relMins / timeframeMins);
    const key = `${getEpochDateStr(cd.t)}:${bucketIndex}`;
    const existing = buckets.get(key);

    if (!existing) {
      buckets.set(key, { ...cd, t: cd.t });
    } else {
      existing.h = Math.max(existing.h, cd.h);
      existing.l = Math.min(existing.l, cd.l);
      existing.c = cd.c;
      existing.v = (existing.v || 0) + (cd.v || 0);
    }
  }
  return Array.from(buckets.values()).sort((a: any, b: any) => a.t - b.t);
}

async function runBacktest() {
  const datesRes = await db.selectDistinct({ date: watchlistSnapshotsTable.date })
    .from(watchlistSnapshotsTable)
    .orderBy(desc(watchlistSnapshotsTable.date))
    .limit(2);

  if (datesRes.length === 0) {
    console.log("No dates found in watchlistSnapshotsTable.");
    return;
  }

  const targetDate = datesRes[1]?.date;
  console.log(`Running backtest for Thursday (2026-08-06): ${targetDate}`);

  const snapshotRows = await db.select()
    .from(watchlistSnapshotsTable)
    .where(eq(watchlistSnapshotsTable.date, targetDate));

  const uniqueStocksMap = new Map<string, any>();
  for (const row of snapshotRows) {
    // only keep the first occurrence to act as the primary filter for the day
    if (!uniqueStocksMap.has(row.symbol)) {
      uniqueStocksMap.set(row.symbol, row);
    }
  }

  const uniqueStocks = Array.from(uniqueStocksMap.values());
  console.log(`Found ${uniqueStocks.length} unique stocks on ${targetDate}. Fetching data...`);

  const stockData = new Map<string, any>();
  let allTimeSlots = new Set<number>();

  for (const s of uniqueStocks) {
    const symbol = s.symbol?.trim();
    if (!symbol) continue;

    try {
      const histRes = await axios.get(`http://localhost:3000/api/stocks/${symbol}/candles`);
      const historicalCandles = histRes.data?.historicalCandles || [];
      const sessionCandles = histRes.data?.sessionCandles || [];

      if (historicalCandles.length === 0 || sessionCandles.length < 3) continue;

      const prevCandles = historicalCandles.filter((c: any) => {
        const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000));
        return dtStr !== targetDate;
      });

      if (prevCandles.length === 0) continue;
      
      const dates = Array.from(new Set(prevCandles.map((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000))))).sort() as string[];
      const lastDate = dates[dates.length - 1];
      const lastDayCandles = prevCandles.filter((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000)) === lastDate);

      const prevClose = lastDayCandles[lastDayCandles.length - 1].c;
      const allCandles = [...historicalCandles, ...sessionCandles].sort((a: any, b: any) => a.t - b.t);

      // We need to filter for targetDate
      const actualSessionCandles = allCandles.filter((c: any) => {
         const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000));
         return dtStr === targetDate;
      });
      if (actualSessionCandles.length === 0) continue;

      stockData.set(symbol, {
          category: s.category,
          prevClose,
          sessionCandles: actualSessionCandles,
          allCandles
      });

      for (const c of actualSessionCandles) {
          allTimeSlots.add(c.t);
      }
    } catch (e) {
      // ignore
    }
  }

  const sortedSlots = Array.from(allTimeSlots).sort((a, b) => a - b);
  
  let totalSimulatedTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalPNL = 0;

  const activeTrades = new Map<string, any>();
  const tradesPerStock = new Map<string, number>();
  let dailyTradesCount = 0;

  console.log(`Starting chronological simulation from ${getISTTimeStr(sortedSlots[0])} to ${getISTTimeStr(sortedSlots[sortedSlots.length-1])}...\n`);

  for (const t of sortedSlots) {
      const timeStr = getISTTimeStr(t + 300);
      const minsOfDay = getISTMinuteOfDay(t + 300); // 5 min close

      // 1. Auto Square-Off at 3:15 PM
      if (minsOfDay >= 15 * 60 + 14) {
          if (activeTrades.size > 0) {
              console.log(`\n[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:15 PM)`);
              for (const [symbol, trade] of Array.from(activeTrades.entries())) {
                  const data = stockData.get(symbol);
                  const currentCandle = data?.sessionCandles.find((c: any) => c.t === t);
                  const exitPrice = currentCandle ? currentCandle.o : trade.entryPrice;
                  
                  const pnl = trade.side === "BUY" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
                  const risk = trade.entryPrice * 0.01;
                  const rr = risk > 0 ? pnl / risk : 0;
                  
                  console.log(`  [EXIT] ${symbol} Auto Squared-off at ${exitPrice} (Entry: ${trade.entryPrice}) RR: ${rr.toFixed(2)}R`);
                  totalSimulatedTrades++;
                  if (pnl > 0) winningTrades++; else losingTrades++;
                  totalPNL += pnl;
                  activeTrades.delete(symbol);
              }
          }
          break; // Stop evaluating further
      }

      // 2. Process Exits
      for (const [symbol, trade] of Array.from(activeTrades.entries())) {
          const data = stockData.get(symbol);
          const historySoFar = data.allCandles.filter((hc: any) => hc.t <= t);
          
          if (historySoFar.length < 50) continue;
          const utState = computeUTBot(historySoFar, 1, 10, 0.25, 6, 1);
          const currentState = utState[utState.length - 1];

          // Trailing
          const proposedSL = currentState.xATRTrailingStop;
          const isBetter = trade.side === "BUY" ? proposedSL > trade.sl : proposedSL < trade.sl;
          if (isBetter) {
             trade.sl = proposedSL;
             console.log(`  [TRAIL] ${symbol} UT Bot Trailed SL to ${trade.sl.toFixed(2)}`);
          }

          const c = historySoFar[historySoFar.length - 1];

          if (trade.side === "BUY" && c.c <= trade.sl) {
              const pnl = trade.sl - trade.entryPrice;
              const rr = pnl / (trade.entryPrice * 0.01);
              console.log(`  [EXIT] ${symbol} SL hit at ${trade.sl.toFixed(2)} (Entry: ${trade.entryPrice}) ${rr.toFixed(2)}R @ ${timeStr}`);
              totalSimulatedTrades++;
              if (pnl >= 0) winningTrades++; else losingTrades++;
              totalPNL += pnl;
              activeTrades.delete(symbol);
          } else if (trade.side === "SELL" && c.c >= trade.sl) {
              const pnl = trade.entryPrice - trade.sl;
              const rr = pnl / (trade.entryPrice * 0.01);
              console.log(`  [EXIT] ${symbol} SL hit at ${trade.sl.toFixed(2)} (Entry: ${trade.entryPrice}) ${rr.toFixed(2)}R @ ${timeStr}`);
              totalSimulatedTrades++;
              if (pnl >= 0) winningTrades++; else losingTrades++;
              totalPNL += pnl;
              activeTrades.delete(symbol);
          }
      }

      // 3. Process Entries
      if (dailyTradesCount >= MAX_DAILY_TRADES) continue;

      for (const [symbol, data] of Array.from(stockData.entries())) {
          if (activeTrades.has(symbol)) continue;
          if ((tradesPerStock.get(symbol) || 0) >= MAX_PER_STOCK) continue;
          if (dailyTradesCount >= MAX_DAILY_TRADES) break;

          const historySoFar = data.allCandles.filter((hc: any) => hc.t <= t);
          if (historySoFar.length < 50) continue;
          
          const c = historySoFar[historySoFar.length - 1];
          if (c.t !== t) continue;

          const mins = getISTMinuteOfDay(c.t + 300);
          if (mins < 9 * 60 + 30 || mins > 14 * 60 + 45) continue;

          const utState = computeUTBot(historySoFar, 1, 10, 0.25, 6, 1);
          const currentState = utState[utState.length - 1];

          if (!currentState.buy && !currentState.sell) continue;

          const calculateEMA = (candles: any[], period: number): number => {
            const closes = candles.map(c => c.c);
            let ema = 0;
            const k = 2 / (period + 1);
            for (let i = 0; i < closes.length; i++) {
              if (i === 0) ema = closes[i];
              else ema = (closes[i] - ema) * k + ema;
            }
            return ema;
          };

          const ema13 = calculateEMA(historySoFar, 13);
          const ema48 = calculateEMA(historySoFar, 48);
          const ema200 = calculateEMA(historySoFar, 200);

          let bullAligned = ema13 > ema48 && ema48 > ema200;
          let bearAligned = ema13 < ema48 && ema48 < ema200;

          let validBuy = currentState.buy && bullAligned;
          let validSell = currentState.sell && bearAligned;

          if (!validBuy && !validSell) continue;

          const side = validBuy ? "BUY" : "SELL";
          const sl = currentState.buy ? c.c - currentState.atr * 1.5 : c.c + currentState.atr * 1.5;

          console.log(`[ENTRY ${dailyTradesCount + 1}/${MAX_DAILY_TRADES}] ${symbol} @ ${timeStr} | ${side} | Entry: ${c.c} | SL: ${sl.toFixed(2)}`);
          activeTrades.set(symbol, { side, entryPrice: c.c, sl });
          tradesPerStock.set(symbol, (tradesPerStock.get(symbol) || 0) + 1);
          dailyTradesCount++;
      }
  }

  console.log(`\n=== CHRONOLOGICAL BACKTEST SUMMARY ===`);
  console.log(`Total Trades Taken: ${totalSimulatedTrades}`);
  console.log(`Wins: ${winningTrades} | Losses: ${losingTrades}`);
}

runBacktest().catch(console.error);
// @ts-nocheck
