import dotenv from "dotenv";
dotenv.config({ path: "f:/sentinel/.env" });
import axios from "axios";

const MORNING_LIST = [
  "ABDL", "ACE", "BLISSGVS", "CGCL", "CONCORDBIO", "CPPLUS", "CUB", "EPIGRAL",
  "FSL", "GAEL", "GMDCLTD", "GODREJAGRO", "GUJALKALI", "HFCL", "INOXINDIA",
  "JINDALSTEL", "JWL", "KPITTECH", "LALPATHLAB", "LTF", "MAPMYINDIA", "MOTHERSON",
  "NAVNETEDUL", "NEWGEN", "NILKAMAL", "PARADEEP", "PHOENIXLTD", "PINELABS",
  "SAIL", "SHARDACROP", "SONATSOFTW", "SUMICHEM", "SUNTV", "SWIGGY", "TEJASNET",
  "THERMAX", "TRIVENI", "VMART"
];

function formatIST(epochSecs: number): { timeStr: string; mins: number; dateStr: string } {
  const d = new Date((epochSecs + 19800) * 1000);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
  const timeStr = formatter.format(d);
  const [h, m] = timeStr.split(":").map(Number);
  const mins = (h ?? 0) * 60 + (m ?? 0);

  const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  const dateStr = dateFormatter.format(d);

  return { timeStr, mins, dateStr };
}

function calculateVWAP(candles: any[]): number {
  let tpvSum = 0;
  let volSum = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    tpvSum += tp * (c.v || 1);
    volSum += (c.v || 1);
  }
  return volSum > 0 ? tpvSum / volSum : candles[candles.length - 1].c;
}

function standardPivots(prevHigh: number, prevLow: number, prevClose: number) {
  const p = (prevHigh + prevLow + prevClose) / 3;
  return { p, r1: 2 * p - prevLow, s1: 2 * p - prevHigh };
}

const MC_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.moneycontrol.com/",
  Origin: "https://www.moneycontrol.com",
};

async function fetchMoneycontrol(symbol: string) {
  const to = Math.floor(Date.now() / 1000) + 86400; // up to tomorrow
  const from = to - (15 * 24 * 3600); // 15 days of data

  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&countback=3500&currencyCode=INR`;

  try {
    const res = await axios.get(url, { headers: MC_HEADERS });
    if (res.data && res.data.s === "ok" && Array.isArray(res.data.t)) {
      const candles: any[] = [];
      const times = res.data.t;
      const opens = res.data.o;
      const highs = res.data.h;
      const lows = res.data.l;
      const closes = res.data.c;
      const volumes = res.data.v;

      for (let i = 0; i < times.length; i++) {
        candles.push({ t: times[i], o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] });
      }
      return candles.sort((a, b) => a.t - b.t);
    }
  } catch (err) {}
  return null;
}

async function runBacktest() {
  console.log(`========================================================================`);
  console.log(`SINGLE DAY BACKTEST: JULY 29, 2026`);
  console.log(`Universe: 38 Stocks from Morning Watchlist Snapshot (09:45 - 10:00 AM)`);
  console.log(`Strategy: Latest Engine (PIVOT_FILTER + VWAP)`);
  console.log(`Time Filter: Entries from 09:45 AM to 11:30 AM`);
  console.log(`========================================================================\n`);

  const stockCandlesMap = new Map<string, any[]>();
  for (const sym of MORNING_LIST) {
    const candles = await fetchMoneycontrol(sym);
    if (candles) stockCandlesMap.set(sym, candles);
  }

  const targetDate = "2026-07-29";
  const dailySignals: any[] = [];

  for (const sym of MORNING_LIST) {
    const candles = stockCandlesMap.get(sym);
    if (!candles) continue;

    const candlesByDate = new Map<string, any[]>();
    for (const c of candles) {
      const { dateStr } = formatIST(c.t);
      if (!candlesByDate.has(dateStr)) candlesByDate.set(dateStr, []);
      candlesByDate.get(dateStr)!.push(c);
    }

    const sortedDates = Array.from(candlesByDate.keys()).sort();
    const dIdx = sortedDates.indexOf(targetDate);
    if (dIdx <= 0) continue;

    const prevDate = sortedDates[dIdx - 1];
    const prevCandles = candlesByDate.get(prevDate)!;
    const sessionCandles = candlesByDate.get(targetDate);
    if (!sessionCandles || sessionCandles.length < 3) continue;

    const prevHigh = Math.max(...prevCandles.map(c => c.h));
    const prevLow = Math.min(...prevCandles.map(c => c.l));
    
    const prevChronological = [...prevCandles].sort((a, b) => a.t - b.t);
    const prevClose = prevChronological[prevChronological.length - 1].c;
    const pivots = standardPivots(prevHigh, prevLow, prevClose);

    const TOUCH_BUFFER_PCT = 0.0015;
    const MAX_CHASE_PCT = 0.008;
    const SL_BUFFER_PCT = 0.015;
    const STRUCTURAL_TRAIL_RR = 1.0;
    const STRUCTURAL_TRAIL_RISK_BUFFER = 0.10;

    const zoneTopH = prevHigh * (1 + TOUCH_BUFFER_PCT);
    const zoneTopL = prevLow * (1 + TOUCH_BUFFER_PCT);

    for (let i = 2; i < sessionCandles.length; i++) {
      const c = sessionCandles[i];
      const prevC = sessionCandles[i - 1];
      const { timeStr, mins } = formatIST(c.t);

      if (mins >= 585 && mins <= 690) { // 09:45 to 11:30
        const candleRange = Math.max(c.h - c.l, 0.05);
        const upperWick = c.h - Math.max(c.o, c.c);
        const lowerWick = Math.min(c.o, c.c) - c.l;
        const currentVWAP = calculateVWAP(sessionCandles.slice(0, i + 1));

        const freshHighBreakout = prevC.c <= prevHigh && c.c > prevHigh;
        const touchedHighZone = c.l <= zoneTopH && c.h >= prevHigh;
        const chasePctHigh = (c.c - prevHigh) / prevHigh;
        const chaseAllowedHigh = chasePctHigh >= 0 && chasePctHigh <= MAX_CHASE_PCT;

        const freshLowBreakdown = prevC.c >= prevLow && c.c < prevLow;
        const touchedLowZone = c.h >= prevLow * (1 - TOUCH_BUFFER_PCT) && c.l <= prevLow;
        const chasePctLow = (prevLow - c.c) / prevLow;
        const chaseAllowedLow = chasePctLow >= 0 && chasePctLow <= MAX_CHASE_PCT;

        let setup = "";
        let direction: "BUY" | "SELL" | null = null;
        let sl = 0;
        let entryPrice = 0;

        if (freshHighBreakout && chaseAllowedHigh && touchedHighZone && c.c > c.o && (upperWick / candleRange) <= 0.35 && c.c > currentVWAP && c.c > pivots.r1) {
          setup = "HIGH BREAKOUT"; direction = "BUY";
          entryPrice = c.c;
          sl = Math.min(c.l, prevHigh * (1 - SL_BUFFER_PCT));
        } else if (freshLowBreakdown && chaseAllowedLow && touchedLowZone && c.c < c.o && (lowerWick / candleRange) <= 0.35 && c.c < currentVWAP && c.c < pivots.s1) {
          setup = "LOW BREAKDOWN"; direction = "SELL";
          entryPrice = c.c;
          sl = Math.max(c.h, prevLow * (1 + SL_BUFFER_PCT));
        }

        if (direction) {
          const risk = Math.abs(entryPrice - sl);
          const target = direction === "BUY" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);

          let outcomeRR = 0;
          let outcomeMsg = "";
          let currentSL = sl;
          let trailApplied = false;

          for (let j = i + 1; j < sessionCandles.length; j++) {
            const sc = sessionCandles[j];
            const { mins: sMins, timeStr: sTimeStr } = formatIST(sc.t);

            if (direction === "BUY") {
              const currentR = (sc.h - entryPrice) / risk;
              if (currentR >= STRUCTURAL_TRAIL_RR && !trailApplied) {
                trailApplied = true;
                currentSL = entryPrice - (risk * STRUCTURAL_TRAIL_RISK_BUFFER);
              }

              if (sc.l <= currentSL) {
                const exitPrice = currentSL;
                const pnl = exitPrice - entryPrice;
                outcomeRR = pnl / risk;
                outcomeMsg = trailApplied ? `🛡️ BREAKEVEN HIT at ${sTimeStr} (${outcomeRR > 0 ? "+" : ""}${outcomeRR.toFixed(2)}R)` : `❌ SL HIT at ${sTimeStr} (-1.00R)`;
                break;
              } else if (sc.h >= target) {
                outcomeRR = +2.0;
                outcomeMsg = `🎯 TARGET HIT at ${sTimeStr} (+2.00R)`;
                break;
              }
            } else {
              const currentR = (entryPrice - sc.l) / risk;
              if (currentR >= STRUCTURAL_TRAIL_RR && !trailApplied) {
                trailApplied = true;
                currentSL = entryPrice - (risk * STRUCTURAL_TRAIL_RISK_BUFFER);
              }

              if (sc.h >= currentSL) {
                const exitPrice = currentSL;
                const pnl = entryPrice - exitPrice;
                outcomeRR = pnl / risk;
                outcomeMsg = trailApplied ? `🛡️ BREAKEVEN HIT at ${sTimeStr} (${outcomeRR > 0 ? "+" : ""}${outcomeRR.toFixed(2)}R)` : `❌ SL HIT at ${sTimeStr} (-1.00R)`;
                break;
              } else if (sc.l <= target) {
                outcomeRR = +2.0;
                outcomeMsg = `🎯 TARGET HIT at ${sTimeStr} (+2.00R)`;
                break;
              }
            }

            if (sMins >= 915) {
              const exitPrice = sc.c;
              const pnl = direction === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
              outcomeRR = pnl / risk;
              outcomeMsg = `🕒 3:15 PM SQUARE OFF (${outcomeRR > 0 ? "+" : ""}${outcomeRR.toFixed(2)}R)`;
              break;
            }
          }

          dailySignals.push({
            symbol: sym,
            mins,
            timeStr,
            direction,
            setup,
            entryPrice,
            sl,
            target,
            outcomeRR,
            outcomeMsg
          });
          break; // Stop looking for setups for this symbol today
        }
      }
    }
  }

  dailySignals.sort((a, b) => a.mins - b.mins);

  let dayRR = 0;
  let dayWins = 0;
  let dayLosses = 0;
  
  if (dailySignals.length === 0) {
      console.log(`No valid setups triggered for this list on ${targetDate}.`);
      return;
  }

  console.log(`ALL SIGNALS DETECTED (No 5-Trade Cap applied for visibility):`);
  dailySignals.forEach(t => {
    dayRR += t.outcomeRR;
    if (t.outcomeRR > 0) dayWins++; else dayLosses++;
    console.log(`[${t.timeStr}] ${t.symbol} | ${t.setup} | ${t.direction} at ₹${t.entryPrice.toFixed(2)} | SL: ₹${t.sl.toFixed(2)} | Target: ₹${t.target.toFixed(2)}`);
    console.log(`   -> Result: ${t.outcomeMsg}`);
  });

  console.log(`\n========================================================================`);
  console.log(`Total Trades: ${dailySignals.length} | Wins: ${dayWins} | Losses: ${dayLosses}`);
  console.log(`NET DAY RETURN: ${dayRR > 0 ? "+" : ""}${dayRR.toFixed(2)}R`);
  console.log(`========================================================================\n`);
}

runBacktest().catch(console.error);
