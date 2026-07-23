import axios from "axios";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;

async function runBacktest() {
  console.log("Fetching today's watchlist from IntradayScreener...");
  const url = "https://intradayscreener.com/api/trackStocks/cash";
  const res = await axios.get(url, { headers: { Accept: "application/json" } });

  const gainers = (res.data.intradayGainers || []).slice(0, 15).map((s: any) => ({ ...s, category: "GAINER" }));
  const losers = (res.data.intradayLosers || []).slice(0, 15).map((s: any) => ({ ...s, category: "LOSER" }));
  const combined = [...gainers, ...losers];
  const uniqueStocks = Array.from(new Map(combined.map(s => [s.symbol?.trim(), s])).values());

  console.log(`Found ${uniqueStocks.length} unique stocks. Fetching data...`);

  let totalSimulatedTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalRR = 0;

  for (const s of uniqueStocks) {
    const symbol = s.symbol?.trim();
    if (!symbol) continue;

    try {
      const histRes = await axios.get(`http://localhost:3000/api/stocks/${symbol}/candles`);
      const historicalCandles = histRes.data?.historicalCandles || [];
      const sessionCandles = histRes.data?.sessionCandles || [];

      if (historicalCandles.length === 0 || sessionCandles.length < 3) continue;

      // Calculate PDH/PDL from yesterday
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

      const zoneTopH = prevHigh * (1 + TOUCH_BUFFER_PCT);
      const zoneBotH = prevHigh * (1 - TOUCH_BUFFER_PCT);
      const zoneTopL = prevLow * (1 + TOUCH_BUFFER_PCT);
      const zoneBotL = prevLow * (1 - TOUCH_BUFFER_PCT);

      let activeTrade = null;

      // Simulate step by step through today's session
      for (let i = 2; i < sessionCandles.length; i++) {
        const prevPrevC = sessionCandles[i - 2];
        const prevC = sessionCandles[i - 1];
        const c = sessionCandles[i];
        const timeStr = new Date(c.t * 1000).toISOString().substring(11, 16);

        // Trade Management for active trade
        if (activeTrade) {
           const risk = Math.abs(activeTrade.entryPrice - activeTrade.sl);
           const target = activeTrade.side === "BUY" ? activeTrade.entryPrice + (risk * 2) : activeTrade.entryPrice - (risk * 2);
           
           if (activeTrade.side === "BUY") {
              if (c.l <= activeTrade.sl) {
                  // SL Hit
                  console.log(`  [EXIT] ${symbol} SL hit at ${activeTrade.sl} (Entry: ${activeTrade.entryPrice}) -1R`);
                  totalSimulatedTrades++; losingTrades++; totalRR -= 1;
                  activeTrade = null;
              } else if (c.h >= target) {
                  // Target Hit
                  console.log(`  [EXIT] ${symbol} Target hit at ${target} (Entry: ${activeTrade.entryPrice}) +2R`);
                  totalSimulatedTrades++; winningTrades++; totalRR += 2;
                  activeTrade = null;
              }
           } else {
              if (c.h >= activeTrade.sl) {
                  // SL Hit
                  console.log(`  [EXIT] ${symbol} SL hit at ${activeTrade.sl} (Entry: ${activeTrade.entryPrice}) -1R`);
                  totalSimulatedTrades++; losingTrades++; totalRR -= 1;
                  activeTrade = null;
              } else if (c.l <= target) {
                  // Target Hit
                  console.log(`  [EXIT] ${symbol} Target hit at ${target} (Entry: ${activeTrade.entryPrice}) +2R`);
                  totalSimulatedTrades++; winningTrades++; totalRR += 2;
                  activeTrade = null;
              }
           }
        }

        // Setup Evaluation
        if (!activeTrade) {
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
                if ((direction === "BUY" && s.category === "GAINER") || (direction === "SELL" && s.category === "LOSER")) {
                    console.log(`[ENTRY] ${symbol} @ ${timeStr} | ${setup} | Entry: ${c.c} | SL: ${sl.toFixed(2)}`);
                    activeTrade = { side: direction, entryPrice: c.c, sl };
                }
            }
        }
      }

      if (activeTrade) {
          console.log(`  [EXIT] ${symbol} closed at EOD ${sessionCandles[sessionCandles.length-1].c}`);
          const pnl = activeTrade.side === "BUY" ? sessionCandles[sessionCandles.length-1].c - activeTrade.entryPrice : activeTrade.entryPrice - sessionCandles[sessionCandles.length-1].c;
          const risk = Math.abs(activeTrade.entryPrice - activeTrade.sl);
          const rr = pnl / risk;
          totalRR += rr;
          totalSimulatedTrades++;
          if (rr > 0) winningTrades++; else losingTrades++;
      }

    } catch (e: any) {
      // ignore
    }
  }

  console.log(`\n=== BACKTEST SUMMARY ===`);
  console.log(`Total Trades: ${totalSimulatedTrades}`);
  console.log(`Wins: ${winningTrades} | Losses: ${losingTrades}`);
  console.log(`Net RR (R-Multiple): ${totalRR.toFixed(2)}R`);
}

runBacktest().catch(console.error);
