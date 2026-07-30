import dotenv from "dotenv";
dotenv.config({ path: "f:/sentinel/.env" });

import axios from "axios";
import { SENTINEL_ALPHA_BASKET } from "f:/sentinel/artifacts/auto-trader/src/alpha-basket";

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
  const to = 1785089400;
  const from = to - (35 * 24 * 3600);

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

async function runMonthlyAlphaBasketBacktest() {
  console.log(`========================================================================`);
  console.log(`MONTHLY ALPHA BASKET BACKTEST: JULY 1, 2026 TO JULY 24, 2026`);
  console.log(`Universe: Optimized Alpha Basket (Top 20) | Strategy: PIVOT_FILTER (R1/S1)`);
  console.log(`Time Filter: ONLY 09:45 AM and 10:00 AM Entries`);
  console.log(`========================================================================\n`);

  console.log(`Fetching 5-minute historical candles for the Alpha Basket stocks...`);
  const stockCandlesMap = new Map<string, any[]>();
  for (const sym of SENTINEL_ALPHA_BASKET) {
    const candles = await fetchMoneycontrol(sym);
    if (candles) stockCandlesMap.set(sym, candles);
  }

  // Get all unique trading dates in July 2026
  const allDatesSet = new Set<string>();
  stockCandlesMap.forEach(candles => {
    candles.forEach(c => {
      const { dateStr } = formatIST(c.t);
      if (dateStr >= "2026-07-01" && dateStr <= "2026-07-24") {
        allDatesSet.add(dateStr);
      }
    });
  });

  const tradingDates = Array.from(allDatesSet).sort();
  console.log(`Loaded ${tradingDates.length} trading sessions: ${tradingDates[0]} to ${tradingDates[tradingDates.length - 1]}\n`);

  let monthlyTotalTrades = 0;
  let monthlyWins = 0;
  let monthlyLosses = 0;
  let monthlyNetRR = 0;
  let profitableDays = 0;
  let lossDays = 0;

  for (const targetDate of tradingDates) {
    const dailySignals: any[] = [];

    for (const sym of SENTINEL_ALPHA_BASKET) {
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

        // ONLY 09:45 (585 mins) OR 10:00 (600 mins)
        if (mins === 585 || mins === 600) {
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

          // PIVOT FILTER ADDED (c.c > pivots.r1 for LONG, c.c < pivots.s1 for SHORT)
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
              entryPrice,
              sl,
              target,
              outcomeRR,
              outcomeMsg
            });
            break;
          }
        }
      }
    }

    // Apply strict 5 trade cap
    dailySignals.sort((a, b) => a.mins - b.mins);
    const executedTrades = dailySignals.slice(0, 5);

    let dayRR = 0;
    let dayWins = 0;
    let dayLosses = 0;

    executedTrades.forEach(t => {
      dayRR += t.outcomeRR;
      if (t.outcomeRR > 0) dayWins++; else dayLosses++;
    });

    monthlyTotalTrades += executedTrades.length;
    monthlyWins += dayWins;
    monthlyLosses += dayLosses;
    monthlyNetRR += dayRR;

    if (dayRR > 0) profitableDays++;
    else if (dayRR < 0) lossDays++;

    if (executedTrades.length > 0) {
       console.log(`📅 ${targetDate} | Trades: ${executedTrades.length} | Wins: ${dayWins} | Net Day Return: ${dayRR > 0 ? "+" : ""}${dayRR.toFixed(2)}R`);
       executedTrades.forEach(t => {
           console.log(`   -> [${t.timeStr}] ${t.symbol} ${t.direction} at ${t.entryPrice.toFixed(2)} | Result: ${t.outcomeMsg}`);
       });
    } else {
       console.log(`📅 ${targetDate} | Trades: 0 | No entries at 09:45 or 10:00 AM.`);
    }
  }

  console.log(`\n========================================================================`);
  console.log(`FULL MONTH (JULY 1 - JULY 24, 2026) 09:45 & 10:00 AM STRATEGY SUMMARY`);
  console.log(`========================================================================`);
  console.log(`Total Trading Sessions:           ${tradingDates.length}`);
  console.log(`Profitable Days:                  ${profitableDays} (${((profitableDays / tradingDates.length) * 100).toFixed(1)}%)`);
  console.log(`Loss Days:                        ${lossDays}`);
  console.log(`Total Trades Taken (5-Cap):       ${monthlyTotalTrades}`);
  console.log(`Total Winning Trades:             ${monthlyWins} (${monthlyTotalTrades > 0 ? ((monthlyWins / monthlyTotalTrades) * 100).toFixed(1) : 0}%)`);
  console.log(`Total Losing Trades:              ${monthlyLosses}`);
  console.log(`NET MONTHLY STRATEGY RETURN:      ${monthlyNetRR > 0 ? "+" : ""}${monthlyNetRR.toFixed(2)}R`);
  console.log(`========================================================================\n`);
}

runMonthlyAlphaBasketBacktest().catch(console.error);
