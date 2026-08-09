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
  const prevDates = [...new Set(prevCandles.map((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000))))].sort() as string[];
  const lastDate = prevDates[prevDates.length - 1];
  const lastDayCandles = prevCandles.filter((c: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000)) === lastDate);

  const prevClose = lastDayCandles[lastDayCandles.length - 1].c;
  console.log(`Prev Close: ${prevClose}\n`);

  // Print all session candles
  console.log("TIME     O        H        L        C        VWAP     EMA20");
  console.log("-----    -------  -------  -------  -------  -------  -------");


  let activeTrade: any = null;
  let tradesTaken = 0;

  console.log("\n--- SIGNAL SCAN ---\n");

  const allCandles = [...historicalCandles, ...sessionCandles].sort((a: any, b: any) => a.t - b.t);

  const getISTMinuteOfDay = (epochSecs: number) => {
    const d = new Date(epochSecs * 1000);
    d.setUTCHours(d.getUTCHours() + 5);
    d.setUTCMinutes(d.getUTCMinutes() + 30);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };

  const getEpochDateStr = (epochSecs: number) => {
    const d = new Date(epochSecs * 1000);
    d.setUTCHours(d.getUTCHours() + 5);
    d.setUTCMinutes(d.getUTCMinutes() + 30);
    return d.toISOString().slice(0, 10);
  };

  const aggregateCandles = (candles: any[], timeframeSecs: number) => {
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
  };

  let cumPV = 0;
  let cumV = 0;

  for (let i = 0; i < sessionCandles.length; i++) {
    const c = sessionCandles[i];
    const d = new Date(c.t * 1000);
    d.setUTCHours(d.getUTCHours() + 5); d.setUTCMinutes(d.getUTCMinutes() + 30);
    const timeStr = d.toISOString().substring(11, 16);

    const hlc3 = (c.h + c.l + c.c) / 3;
    cumPV += hlc3 * (c.v || 0);
    cumV += (c.v || 0);
    const vwap = cumV > 0 ? cumPV / cumV : 0;

    const historySoFar = allCandles.filter((hc: any) => hc.t <= c.t);
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

    console.log(`${timeStr}    ${c.o.toFixed(2).padStart(8)}  ${c.h.toFixed(2).padStart(8)}  ${c.l.toFixed(2).padStart(8)}  ${c.c.toFixed(2).padStart(8)}  ${vwap.toFixed(2).padStart(8)}  ${ema20.toFixed(2).padStart(8)}`);

    // Time filter: 09:30 to 14:45
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes() + 5; // +5 for candle close
    const inWindow = mins >= 9 * 60 + 30 && mins <= 14 * 60 + 45;

    // Manage active trade
    if (activeTrade) {
      const risk = activeTrade.entryPrice * 0.01; // initial 1% risk

      // +1.2% Trail to Breakeven
      if (c.h >= activeTrade.entryPrice * 1.012) {
        if (activeTrade.sl < activeTrade.entryPrice) {
          activeTrade.sl = activeTrade.entryPrice;
          console.log(`  [TRAIL] Hit +1.2%, moving SL to Breakeven (${activeTrade.sl.toFixed(2)})`);
        }
      }
      // +2.0% continuous trail
      if (c.h >= activeTrade.entryPrice * 1.020) {
        const proposedSL = c.h * (1 - 0.012); // trail by 1.2%
        if (proposedSL > activeTrade.sl) {
          activeTrade.sl = proposedSL;
          console.log(`  [TRAIL] Hit +2.0%, trailing SL to ${activeTrade.sl.toFixed(2)}`);
        }
      }

      if (c.l <= activeTrade.sl) {
        const pnl = activeTrade.sl - activeTrade.entryPrice;
        console.log(`  [EXIT] SL HIT @ ${activeTrade.sl.toFixed(2)} at ${timeStr} | PNL: ${pnl.toFixed(2)}`);
        activeTrade = null;
      }
    }

    // 3:15 PM auto square-off
    if (mins >= 15 * 60 + 14 && activeTrade) {
      const exitPrice = c.o;
      const pnl = exitPrice - activeTrade.entryPrice;
      console.log(`  [EXIT] AUTO SQUARE-OFF @ ${exitPrice.toFixed(2)} at ${timeStr} | PNL: ${pnl.toFixed(2)}`);
      activeTrade = null;
      break;
    }

    // Evaluate setups (only if no active trade and in time window)
    if (!activeTrade && inWindow && forceSide === "BUY" && vwap > 0 && ema20 > 0) {
      const extPc = (c.c - ema20) / ema20;
      const dayChangePct = (c.c - prevClose) / prevClose;

      if (c.c > vwap && c.c > ema20 && extPc < 0.015 && dayChangePct > 0) {
        const sl = c.c * 0.99; // -1.0% hard stop
        console.log(`[ENTRY] SECTOR MOMENTUM @ ${timeStr} | Entry: ${c.c.toFixed(2)} | SL: ${sl.toFixed(2)}`);
        activeTrade = { side: "BUY", entryPrice: c.c, sl };
        tradesTaken++;
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
