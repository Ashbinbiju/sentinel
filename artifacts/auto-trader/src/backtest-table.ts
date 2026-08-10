// @ts-nocheck
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { db } from '@workspace/db';
import { watchlistSnapshotsTable } from '@workspace/db/schema';
import { desc, eq } from 'drizzle-orm';
import axios from 'axios';
import { computeEmaVwap, aggregateCandles } from './nine-ema-vwap.js';

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

async function runBacktest() {
  console.log(`Fetching NIFTY top gainers for today's backtest from Bottomstreet API...`);
  const isRes = await axios.get("https://api.bottomstreet.com/?index=NIFTY&type=gainers&limit=15");
  const data = isRes.data;
  const uniqueStocks = data.stocks.map((s: any) => ({ symbol: s.symbol?.trim() })).filter((s: any) => s.symbol);
  
  const targetDate = "2026-08-10";
  console.log(`Found ${uniqueStocks.length} unique stocks. Fetching data for ${targetDate}...`);

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
      const rawAllCandles = [...historicalCandles, ...sessionCandles].sort((a: any, b: any) => a.t - b.t);
      const allCandles = aggregateCandles(rawAllCandles, 300);

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
  const MAX_DAILY_TRADES = 2;

  if (sortedSlots.length === 0) {
      console.log(`\nNo candle data available for ${targetDate}. Backtest aborted.`);
      return;
  }
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
          const stateArray = computeEmaVwap(historySoFar);
          const currentState = stateArray[stateArray.length - 1];

          // Trailing
          const tradeBars = historySoFar.filter((h: any) => h.t >= trade.entryTime);
          let proposedSL = trade.sl;
          
          if (trade.side === "BUY") {
            const runMax = Math.max(...tradeBars.map((h: any) => h.h), trade.entryPrice);
            const mfe = runMax - trade.entryPrice;
            if (mfe >= currentState.atr * 0.5) {
              proposedSL = Math.max(trade.sl, runMax - 2.5 * currentState.atr);
            }
          } else {
            const runMin = Math.min(...tradeBars.map((h: any) => h.l), trade.entryPrice);
            const mfe = trade.entryPrice - runMin;
            if (mfe >= currentState.atr * 0.5) {
              proposedSL = Math.min(trade.sl, runMin + 2.5 * currentState.atr);
            }
          }
          
          const isBetter = trade.side === "BUY" ? proposedSL > trade.sl : proposedSL < trade.sl;
          if (isBetter) {
             trade.sl = proposedSL;
             console.log(`  [TRAIL] ${symbol} 9EMA VWAP Trailed SL to ${trade.sl.toFixed(2)}`);
          }

          const c = historySoFar[historySoFar.length - 1];

          if (trade.side === "BUY" && c.c <= trade.sl) {
              const pnl = trade.sl - trade.entryPrice;
              const rr = pnl / (trade.entryPrice * 0.01); // Approx R = 1%
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
          if (mins < 9 * 60 + 20 || mins > 15 * 60) continue; // 09:20 - 15:00

          const stateArray = computeEmaVwap(historySoFar);
          const currentState = stateArray[stateArray.length - 1];

          if (!currentState.setupLong && !currentState.setupShort) continue;

          const side = currentState.setupLong ? "BUY" : "SELL";
          const sl = currentState.setupLong ? currentState.rawLongSl : currentState.rawShortSl;

          console.log(`[ENTRY ${dailyTradesCount + 1}/${MAX_DAILY_TRADES}] ${symbol} @ ${timeStr} | ${side} | Entry: ${c.c} | SL: ${sl.toFixed(2)}`);
          activeTrades.set(symbol, { side, entryPrice: c.c, sl, entryTime: c.t });
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
