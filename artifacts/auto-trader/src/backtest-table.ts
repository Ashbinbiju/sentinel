// @ts-nocheck
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { db } from '@workspace/db';
import { watchlistSnapshotsTable } from '@workspace/db/schema';
import { desc, eq } from 'drizzle-orm';
import axios from 'axios';

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
          const c = data?.sessionCandles.find((c: any) => c.t === t);
          if (!c) continue;

          if (trade.side === "BUY") {
            // +1.2% Trail to Breakeven
            if (c.h >= trade.entryPrice * 1.012) {
              if (trade.sl < trade.entryPrice) {
                trade.sl = trade.entryPrice;
                console.log(`  [TRAIL] ${symbol} hit +1.2%, moving SL to Breakeven (${trade.sl.toFixed(2)})`);
              }
            }
            // +2.0% continuous trail
            if (c.h >= trade.entryPrice * 1.020) {
              const proposedSL = c.h * (1 - 0.012); // trail by 1.2%
              if (proposedSL > trade.sl) {
                trade.sl = proposedSL;
                console.log(`  [TRAIL] ${symbol} hit +2.0%, trailing SL to ${trade.sl.toFixed(2)}`);
              }
            }

            if (c.l <= trade.sl) {
              const pnl = trade.sl - trade.entryPrice;
              const rr = pnl / (trade.entryPrice * 0.01);
              console.log(`  [EXIT] ${symbol} SL hit at ${trade.sl.toFixed(2)} (Entry: ${trade.entryPrice}) ${rr.toFixed(2)}R @ ${timeStr}`);
              totalSimulatedTrades++;
              if (pnl >= 0) winningTrades++; else losingTrades++;
              totalPNL += pnl;
              activeTrades.delete(symbol);
            }
          } else {
            // SELL Side Trailing
            if (c.l <= trade.entryPrice * 0.988) {
              if (trade.sl > trade.entryPrice) {
                trade.sl = trade.entryPrice;
                console.log(`  [TRAIL] ${symbol} hit +1.2%, moving SL to Breakeven (${trade.sl.toFixed(2)})`);
              }
            }
            if (c.l <= trade.entryPrice * 0.980) {
              const proposedSL = c.l * (1 + 0.012); 
              if (proposedSL < trade.sl) {
                trade.sl = proposedSL;
                console.log(`  [TRAIL] ${symbol} hit +2.0%, trailing SL to ${trade.sl.toFixed(2)}`);
              }
            }

            if (c.h >= trade.sl) {
              const pnl = trade.entryPrice - trade.sl;
              const rr = pnl / (trade.entryPrice * 0.01);
              console.log(`  [EXIT] ${symbol} SL hit at ${trade.sl.toFixed(2)} (Entry: ${trade.entryPrice}) ${rr.toFixed(2)}R @ ${timeStr}`);
              totalSimulatedTrades++;
              if (pnl >= 0) winningTrades++; else losingTrades++;
              totalPNL += pnl;
              activeTrades.delete(symbol);
            }
          }
      }

      // 3. Process Entries
      if (dailyTradesCount >= MAX_DAILY_TRADES) continue;

      for (const [symbol, data] of Array.from(stockData.entries())) {
          if (activeTrades.has(symbol)) continue;
          if ((tradesPerStock.get(symbol) || 0) >= MAX_PER_STOCK) continue;
          if (dailyTradesCount >= MAX_DAILY_TRADES) break;

          const sessionCandles = data.sessionCandles;
          const idx = sessionCandles.findIndex((c: any) => c.t === t);
          if (idx < 0) continue;

          const c = sessionCandles[idx];
          
          // Pine script says "No entries before 09:30 or after 14:45"
          // In 5-minute candles, the 09:25 candle closes at 09:30, so the first valid candle is the 09:25 open (t)
          const aggregateCandles = (candles: any[], timeframeSecs: number): any[] => {
            const timeframeMins = timeframeSecs / 60;
            const buckets = new Map<string, any>();
            const ENTRY_SIGNAL_START_MIN_IST = 9 * 60 + 15;
          
            for (const cd of [...candles].sort((a, b) => a.t - b.t)) {
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
            return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
          };

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

          const mins = getISTMinuteOfDay(c.t + 60);
          if (mins < 9 * 60 + 30 || mins > 14 * 60 + 45) continue;

          const historySoFar = data.allCandles.filter((hc: any) => hc.t <= c.t);
          if (historySoFar.length < 200) continue; // Needs enough bars for 200 EMA

          const c1 = historySoFar[historySoFar.length - 1];
          const prevDayCandles = data.allCandles.filter((hc: any) => getEpochDateStr(hc.t) < getEpochDateStr(c1.t));
          if (prevDayCandles.length === 0) continue;
          
          const pdh = Math.max(...prevDayCandles.map((hc: any) => hc.h));
          const pdl = Math.min(...prevDayCandles.map((hc: any) => hc.l));

          const agg15m = aggregateCandles(historySoFar, 900);
          const agg2m = aggregateCandles(historySoFar, 120);

          if (agg15m.length < 2 || agg2m.length < 200) continue;

          const past15m = agg15m.filter(xc => xc.t < agg2m[agg2m.length - 1].t);
          if (past15m.length < 1) continue;
          const last15m = past15m[past15m.length - 1];
          const current2m = agg2m[agg2m.length - 1];

          const bullBreak = last15m.c > pdh;
          const bearBreak = last15m.c < pdl;

          if (!bullBreak && !bearBreak) continue;

          const ema13 = calculateEMA(agg2m, 13);
          const ema48 = calculateEMA(agg2m, 48);
          const ema200 = calculateEMA(agg2m, 200);

          const bullAligned = ema13 > ema48 && ema48 > ema200;
          const bearAligned = ema13 < ema48 && ema48 < ema200;

          const bull_cross = bullBreak && bullAligned && current2m.l <= ema13 && current2m.c > ema13;
          const bear_cross = bearBreak && bearAligned && current2m.h >= ema13 && current2m.c < ema13;

          if (bull_cross || bear_cross) {
              const side = bull_cross ? "BUY" : "SELL";
              const sl = bull_cross ? ema48 * 0.999 : ema48 * 1.001;
              console.log(`[ENTRY ${dailyTradesCount + 1}/${MAX_DAILY_TRADES}] ${symbol} @ ${timeStr} | ${side} | Entry: ${current2m.c} | SL: ${sl.toFixed(2)}`);
              activeTrades.set(symbol, { side, entryPrice: current2m.c, sl });
              tradesPerStock.set(symbol, (tradesPerStock.get(symbol) || 0) + 1);
              dailyTradesCount++;
          }
      }
  }

  console.log(`\n=== CHRONOLOGICAL BACKTEST SUMMARY ===`);
  console.log(`Total Trades Taken: ${totalSimulatedTrades}`);
  console.log(`Wins: ${winningTrades} | Losses: ${losingTrades}`);
}

runBacktest().catch(console.error);
// @ts-nocheck
