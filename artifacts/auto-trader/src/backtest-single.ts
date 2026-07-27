import axios from "axios";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.01;

async function backtestSymbol(symbol: string, forceSide: "BUY" | "SELL") {
  console.log(`\n=== BACKTESTING ${symbol} (${forceSide} ONLY) ===\n`);

  const histRes = await axios.get(`http://localhost:3000/api/stocks/${symbol}/candles`);
  const historicalCandles = histRes.data?.historicalCandles || [];
  const sessionCandles = histRes.data?.sessionCandles || [];

  if (historicalCandles.length === 0) { console.log("No historical candles found."); return; }
  if (sessionCandles.length < 3) { console.log("Not enough session candles."); return; }

  // PDH/PDL
  const todaySlot = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const prevCandles = historicalCandles.filter((c: any) => {
    const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000));
    return dtStr !== todaySlot;
  });
  const dates = [...new Set(prevCandles.map((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000))))].sort() as string[];
  const lastDate = dates[dates.length - 1];
  const lastDayCandles = prevCandles.filter((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000)) === lastDate);

  const prevHigh = Math.max(...lastDayCandles.map((c: any) => c.h));
  const prevLow = Math.min(...lastDayCandles.map((c: any) => c.l));
  console.log(`PDH: ${prevHigh} | PDL: ${prevLow}\n`);

  // Print all session candles
  console.log("TIME     O        H        L        C");
  console.log("-----    -------  -------  -------  -------");
  for (const c of sessionCandles) {
    const d = new Date(c.t * 1000);
    d.setUTCHours(d.getUTCHours() + 5); d.setUTCMinutes(d.getUTCMinutes() + 30);
    const t = d.toISOString().substring(11, 16);
    console.log(`${t}    ${c.o.toFixed(2).padStart(8)}  ${c.h.toFixed(2).padStart(8)}  ${c.l.toFixed(2).padStart(8)}  ${c.c.toFixed(2).padStart(8)}`);
  }

  const zoneTopH = prevHigh * (1 + TOUCH_BUFFER_PCT);
  const zoneBotH = prevHigh * (1 - TOUCH_BUFFER_PCT);
  const zoneTopL = prevLow * (1 + TOUCH_BUFFER_PCT);
  const zoneBotL = prevLow * (1 - TOUCH_BUFFER_PCT);

  let activeTrade: any = null;
  let tradesTaken = 0;

  console.log("\n--- SIGNAL SCAN ---\n");

  for (let i = 2; i < sessionCandles.length; i++) {
    const prevPrevC = sessionCandles[i - 2];
    const prevC = sessionCandles[i - 1];
    const c = sessionCandles[i];
    const d = new Date(c.t * 1000);
    d.setUTCHours(d.getUTCHours() + 5); d.setUTCMinutes(d.getUTCMinutes() + 30);
    const timeStr = d.toISOString().substring(11, 16);

    // Time filter: 10:15 to 14:30
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes() + 5; // +5 for candle close
    const inWindow = mins >= 10 * 60 + 15 && mins <= 14 * 60 + 30;

    // Manage active trade
    if (activeTrade) {
      const risk = Math.abs(activeTrade.entryPrice - activeTrade.sl);
      const target = activeTrade.side === "BUY" ? activeTrade.entryPrice + (risk * 2) : activeTrade.entryPrice - (risk * 2);

      if (activeTrade.side === "BUY") {
        if (c.l <= activeTrade.sl) {
          console.log(`  [EXIT] SL HIT @ ${activeTrade.sl.toFixed(2)} at ${timeStr} | -1R`);
          activeTrade = null;
        } else if (c.h >= target) {
          console.log(`  [EXIT] TARGET HIT @ ${target.toFixed(2)} at ${timeStr} | +2R`);
          activeTrade = null;
        }
      } else {
        if (c.h >= activeTrade.sl) {
          console.log(`  [EXIT] SL HIT @ ${activeTrade.sl.toFixed(2)} at ${timeStr} | -1R`);
          activeTrade = null;
        } else if (c.l <= target) {
          console.log(`  [EXIT] TARGET HIT @ ${target.toFixed(2)} at ${timeStr} | +2R`);
          activeTrade = null;
        }
      }
    }

    // 3:14 PM auto square-off
    if (mins >= 15 * 60 + 14 && activeTrade) {
      const exitPrice = c.o;
      const risk = Math.abs(activeTrade.entryPrice - activeTrade.sl);
      const pnl = activeTrade.side === "BUY" ? exitPrice - activeTrade.entryPrice : activeTrade.entryPrice - exitPrice;
      const rr = pnl / risk;
      console.log(`  [EXIT] AUTO SQUARE-OFF @ ${exitPrice.toFixed(2)} at ${timeStr} | ${rr.toFixed(2)}R`);
      activeTrade = null;
      break;
    }

    // Evaluate setups (only if no active trade and in time window)
    if (!activeTrade && inWindow) {
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
      let direction: "BUY" | "SELL" | "" = "";
      let sl = 0;

      if (freshHighBreakout && chaseAllowedHigh && touchedHighZone) {
        setup = "HIGH BREAKOUT"; direction = "BUY";
        sl = Math.min(c.l, prevHigh * (1 - SL_BUFFER_PCT));
      } else if (freshLowBreakdown && chaseAllowedLow && touchedLowZone) {
        setup = "LOW BREAKDOWN"; direction = "SELL";
        sl = Math.max(c.h, prevLow * (1 + SL_BUFFER_PCT));
      } else if (validHighRejection) {
        setup = "HIGH REJECTION"; direction = "SELL";
        sl = Math.max(c.h, zoneTopH * (1 + SL_BUFFER_PCT));
      } else if (validLowSupport) {
        setup = "LOW SUPPORT"; direction = "BUY";
        sl = Math.min(c.l, zoneBotL * (1 - SL_BUFFER_PCT));
      }

      if (direction) {
        if (direction === forceSide) {
          const risk = Math.abs(c.c - sl);
          const target = direction === "BUY" ? c.c + risk * 2 : c.c - risk * 2;
          console.log(`[ENTRY] ${setup} @ ${timeStr} | Entry: ${c.c.toFixed(2)} | SL: ${sl.toFixed(2)} | Target: ${target.toFixed(2)} | Risk: ${risk.toFixed(2)}`);
          activeTrade = { side: direction, entryPrice: c.c, sl };
          tradesTaken++;
        } else {
          console.log(`[SKIP] ${setup} (${direction}) @ ${timeStr} — forced ${forceSide} only`);
        }
      }
    }
  }

  // EOD close
  if (activeTrade) {
    const lastC = sessionCandles[sessionCandles.length - 1];
    const risk = Math.abs(activeTrade.entryPrice - activeTrade.sl);
    const pnl = activeTrade.side === "BUY" ? lastC.c - activeTrade.entryPrice : activeTrade.entryPrice - lastC.c;
    const rr = pnl / risk;
    console.log(`  [EXIT] EOD CLOSE @ ${lastC.c.toFixed(2)} | ${rr.toFixed(2)}R`);
  }

  if (tradesTaken === 0) {
    console.log("\nNo valid setups found for forced direction today.");
  }
}

backtestSymbol("GRAPHITE", "BUY").catch(console.error);
