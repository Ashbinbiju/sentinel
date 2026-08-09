// @ts-nocheck
import axios from "axios";

const MAX_DAILY_TRADES = 5;

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
  console.log("Fetching today's watchlist from IntradayScreener...");
  const url = "https://intradayscreener.com/api/trackStocks/cash";
  const res = await axios.get(url, { headers: { Accept: "application/json" } });

  const gainers = (res.data.intradayGainers || []).slice(0, 15).map((s: any) => ({ ...s, category: "GAINER" }));
  const uniqueStocks = Array.from(new Map(gainers.map(s => [s.symbol?.trim(), s])).values());

  console.log(`Found ${uniqueStocks.length} unique stocks. Fetching data...`);

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

      const todaySlot = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const prevCandles = historicalCandles.filter((c: any) => {
        const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000));
        return dtStr !== todaySlot;
      });

      if (prevCandles.length === 0) continue;
      
      const dates = Array.from(new Set(prevCandles.map((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000))))).sort() as string[];
      const lastDate = dates[dates.length - 1];
      const lastDayCandles = prevCandles.filter((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000)) === lastDate);

      const prevClose = lastDayCandles[lastDayCandles.length - 1].c;
      const allCandles = [...historicalCandles, ...sessionCandles].sort((a: any, b: any) => a.t - b.t);

      stockData.set(symbol, {
          category: s.category,
          prevClose,
          sessionCandles,
          allCandles
      });

      for (const c of sessionCandles) {
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
  let dailyTradesCount = 0;

  console.log(`Starting chronological simulation from ${getISTTimeStr(sortedSlots[0])} to ${getISTTimeStr(sortedSlots[sortedSlots.length-1])}...\n`);

  for (const t of sortedSlots) {
      const timeStr = getISTTimeStr(t);
      const minsOfDay = getISTMinuteOfDay(t + 300); // 5 min close

      // 1. Auto Square-Off at 3:15 PM
      if (minsOfDay >= 15 * 60 + 14) {
          if (activeTrades.size > 0) {
              console.log(`\n[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:15 PM)`);
              for (const [symbol, trade] of Array.from(activeTrades.entries())) {
                  const data = stockData.get(symbol);
                  const currentCandle = data?.sessionCandles.find((c: any) => c.t === t);
                  const exitPrice = currentCandle ? currentCandle.o : trade.entryPrice;
                  
                  const pnl = exitPrice - trade.entryPrice;
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
      }

      // 3. Process Entries
      if (dailyTradesCount >= MAX_DAILY_TRADES) continue;
      if (minsOfDay < 9 * 60 + 30 || minsOfDay > 14 * 60 + 45) continue;

      for (const [symbol, data] of Array.from(stockData.entries())) {
          if (activeTrades.has(symbol)) continue;
          if (dailyTradesCount >= MAX_DAILY_TRADES) break;

          const sessionCandles = data.sessionCandles;
          const idx = sessionCandles.findIndex((c: any) => c.t === t);
          if (idx < 0) continue;

          const c = sessionCandles[idx];
          
          let cumPV = 0;
          let cumV = 0;
          for (let i = 0; i <= idx; i++) {
            const sc = sessionCandles[i];
            const hlc3 = (sc.h + sc.l + sc.c) / 3;
            cumPV += hlc3 * (sc.v || 0);
            cumV += (sc.v || 0);
          }
          const vwap = cumV > 0 ? cumPV / cumV : 0;

          const historySoFar = data.allCandles.filter((hc: any) => hc.t <= c.t);
          const agg15m = aggregateCandles(historySoFar, 900);
          
          const period = 20;
          let ema20 = 0;
          if (agg15m.length >= period) {
            const closes = agg15m.map((x: any) => x.c);
            const k = 2 / (period + 1);
            let ema = closes.slice(0, period).reduce((a: any, b: any) => a + b, 0) / period;
            for (let j = period; j < closes.length; j++) {
              ema = (closes[j] - ema) * k + ema;
            }
            ema20 = ema;
          }

          if (vwap === 0 || ema20 === 0) continue;

          const extPc = (c.c - ema20) / ema20;
          const dayChangePct = (c.c - data.prevClose) / data.prevClose;

          if (c.c > vwap && c.c > ema20 && extPc < 0.015 && dayChangePct > 0) {
              const sl = c.c * 0.99; // -1.0% hard stop
              console.log(`[ENTRY ${dailyTradesCount + 1}/5] ${symbol} @ ${timeStr} | SECTOR MOMENTUM | Entry: ${c.c} | SL: ${sl.toFixed(2)}`);
              activeTrades.set(symbol, { side: "BUY", entryPrice: c.c, sl });
              dailyTradesCount++;
          }
      }
  }

  console.log(`\n=== CHRONOLOGICAL BACKTEST SUMMARY ===`);
  console.log(`Total Trades Taken: ${totalSimulatedTrades}`);
  console.log(`Wins: ${winningTrades} | Losses: ${losingTrades}`);
}

runBacktest().catch(console.error);
