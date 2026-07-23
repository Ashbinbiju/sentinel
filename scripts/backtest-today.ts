import axios from "axios";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
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

async function runBacktest() {
  console.log("Fetching today's watchlist from IntradayScreener...");
  const url = "https://intradayscreener.com/api/trackStocks/cash";
  const res = await axios.get(url, { headers: { Accept: "application/json" } });

  const gainers = (res.data.intradayGainers || []).slice(0, 15).map((s: any) => ({ ...s, category: "GAINER" }));
  const losers = (res.data.intradayLosers || []).slice(0, 15).map((s: any) => ({ ...s, category: "LOSER" }));
  const combined = [...gainers, ...losers];
  const uniqueStocks = Array.from(new Map(combined.map(s => [s.symbol?.trim(), s])).values());

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

      const prevHigh = Math.max(...lastDayCandles.map((c: any) => c.h));
      const prevLow = Math.min(...lastDayCandles.map((c: any) => c.l));

      stockData.set(symbol, {
          category: s.category,
          prevHigh,
          prevLow,
          sessionCandles
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
  let totalRR = 0;

  const activeTrades = new Map<string, any>();
  let dailyTradesCount = 0;

  console.log(`Starting chronological simulation from ${getISTTimeStr(sortedSlots[0])} to ${getISTTimeStr(sortedSlots[sortedSlots.length-1])}...\n`);

  for (const t of sortedSlots) {
      const timeStr = getISTTimeStr(t);
      const minsOfDay = getISTMinuteOfDay(t);

      // 1. Auto Square-Off at 3:14 PM (15:14 = 914 mins)
      if (minsOfDay >= 15 * 60 + 14) {
          if (activeTrades.size > 0) {
              console.log(`\n[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:14 PM)`);
              for (const [symbol, trade] of Array.from(activeTrades.entries())) {
                  const data = stockData.get(symbol);
                  const currentCandle = data?.sessionCandles.find((c: any) => c.t === t);
                  const exitPrice = currentCandle ? currentCandle.o : trade.entryPrice;
                  
                  const pnl = trade.side === "BUY" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
                  const risk = Math.abs(trade.entryPrice - trade.sl);
                  const rr = risk > 0 ? pnl / risk : 0;
                  
                  console.log(`  [EXIT] ${symbol} Auto Squared-off at ${exitPrice} (Entry: ${trade.entryPrice}) RR: ${rr.toFixed(2)}R`);
                  totalSimulatedTrades++;
                  if (rr > 0) winningTrades++; else losingTrades++;
                  totalRR += rr;
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

          const risk = Math.abs(trade.entryPrice - trade.sl);
          const target = trade.side === "BUY" ? trade.entryPrice + (risk * 2) : trade.entryPrice - (risk * 2);
           
          if (trade.side === "BUY") {
              if (c.l <= trade.sl) {
                  console.log(`  [EXIT] ${symbol} SL hit at ${trade.sl} (Entry: ${trade.entryPrice}) -1R @ ${timeStr}`);
                  totalSimulatedTrades++; losingTrades++; totalRR -= 1;
                  activeTrades.delete(symbol);
              } else if (c.h >= target) {
                  console.log(`  [EXIT] ${symbol} Target hit at ${target} (Entry: ${trade.entryPrice}) +2R @ ${timeStr}`);
                  totalSimulatedTrades++; winningTrades++; totalRR += 2;
                  activeTrades.delete(symbol);
              }
          } else {
              if (c.h >= trade.sl) {
                  console.log(`  [EXIT] ${symbol} SL hit at ${trade.sl} (Entry: ${trade.entryPrice}) -1R @ ${timeStr}`);
                  totalSimulatedTrades++; losingTrades++; totalRR -= 1;
                  activeTrades.delete(symbol);
              } else if (c.l <= target) {
                  console.log(`  [EXIT] ${symbol} Target hit at ${target} (Entry: ${trade.entryPrice}) +2R @ ${timeStr}`);
                  totalSimulatedTrades++; winningTrades++; totalRR += 2;
                  activeTrades.delete(symbol);
              }
          }
      }

      // 3. Process Entries
      if (dailyTradesCount >= MAX_DAILY_TRADES) continue;

      for (const [symbol, data] of Array.from(stockData.entries())) {
          if (activeTrades.has(symbol)) continue;
          if (dailyTradesCount >= MAX_DAILY_TRADES) break;

          const sessionCandles = data.sessionCandles;
          const idx = sessionCandles.findIndex((c: any) => c.t === t);
          if (idx < 2) continue; // Need prev and prevPrev

          const c = sessionCandles[idx];
          const prevC = sessionCandles[idx - 1];
          const prevPrevC = sessionCandles[idx - 2];

          const prevHigh = data.prevHigh;
          const prevLow = data.prevLow;
          const zoneTopH = prevHigh * (1 + TOUCH_BUFFER_PCT);
          const zoneBotH = prevHigh * (1 - TOUCH_BUFFER_PCT);
          const zoneTopL = prevLow * (1 + TOUCH_BUFFER_PCT);
          const zoneBotL = prevLow * (1 - TOUCH_BUFFER_PCT);

          const freshHighBreakout = prevC.c <= prevHigh && c.c > prevHigh;
          const touchedHighZone = c.l <= zoneTopH && c.h >= prevHigh;
          const chasePctHigh = (c.c - prevHigh) / prevHigh;
          const chaseAllowedHigh = chasePctHigh >= 0 && chasePctHigh <= MAX_CHASE_PCT;

          const freshLowBreakdown = prevC.c >= prevLow && c.c < prevLow;
          const touchedLowZone = c.h >= prevLow * (1 - TOUCH_BUFFER_PCT) && c.l <= prevLow;
          const chasePctLow = (prevLow - c.c) / prevLow;
          const chaseAllowedLow = chasePctLow >= 0 && chasePctLow <= MAX_CHASE_PCT;

          const approachedHighFromBelow = prevPrevC.c < prevHigh && prevC.c < prevHigh;
          const touchedHighRejectionZone = c.h >= zoneBotH && c.h <= prevHigh * (1 + MAX_CHASE_PCT);
          const validHighRejection = approachedHighFromBelow && touchedHighRejectionZone && c.c < c.o && c.c <= prevHigh;

          const approachedLowFromAbove = prevPrevC.c > prevLow && prevC.c > prevLow;
          const touchedLowSupportZone = c.l <= zoneTopL && c.l >= prevLow * (1 - MAX_CHASE_PCT);
          const validLowSupport = approachedLowFromAbove && touchedLowSupportZone && c.c > c.o && c.c >= prevLow;

          let setup = "";
          let direction = "";
          let sl = 0;

          if (freshHighBreakout && chaseAllowedHigh && touchedHighZone) {
              setup = "HIGH BREAKOUT"; direction = "BUY";
              sl = Math.min(c.l, prevHigh * 0.99);
          } else if (freshLowBreakdown && chaseAllowedLow && touchedLowZone) {
              setup = "LOW BREAKDOWN"; direction = "SELL";
              sl = Math.max(c.h, prevLow * 1.01);
          } else if (validHighRejection) {
              setup = "HIGH REJECTION"; direction = "SELL";
              sl = Math.max(c.h, zoneTopH * 1.01);
          } else if (validLowSupport) {
              setup = "LOW SUPPORT"; direction = "BUY";
              sl = Math.min(c.l, zoneBotL * 0.99);
          }

          if (direction) {
              const mins = getISTMinuteOfDay(c.t + 300);
              if (mins >= 10 * 60 + 15 && mins <= 14 * 60 + 30) {
                  if ((direction === "BUY" && data.category === "GAINER") || (direction === "SELL" && data.category === "LOSER")) {
                      console.log(`[ENTRY ${dailyTradesCount + 1}/5] ${symbol} @ ${timeStr} | ${setup} | Entry: ${c.c} | SL: ${sl.toFixed(2)}`);
                      activeTrades.set(symbol, { side: direction, entryPrice: c.c, sl });
                      dailyTradesCount++;
                  }
              }
          }
      }
  }

  console.log(`\n=== CHRONOLOGICAL BACKTEST SUMMARY ===`);
  console.log(`Total Trades Taken: ${totalSimulatedTrades}`);
  console.log(`Wins: ${winningTrades} | Losses: ${losingTrades}`);
  console.log(`Net RR (R-Multiple): ${totalRR.toFixed(2)}R`);
}

runBacktest().catch(console.error);
