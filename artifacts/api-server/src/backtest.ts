import { fetchCandles } from "./routes/stocks";
import { writeFileSync } from "fs";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const STRUCTURAL_TRAIL_RR = 1.5;
const STRUCTURAL_TRAIL_RISK_BUFFER = 0.15;
const PRIME_TIME_START_MINUTES = 10 * 60 + 15;
const PRIME_TIME_END_MINUTES = 14 * 60 + 30;

const testCases: { symbol: string; date: string }[] = [
    { symbol: "SUDARSCHEM", date: "2026-07-10" }
];

function getISTDateStr(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  return formatter.format(d);
}

function getISTMinuteOfDay(epochSecs: number): number {
  const d = new Date(epochSecs * 1000);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const [h, m] = formatter.format(d).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function getCandleCloseDateIST(c: any): string {
    return getISTDateStr(c.t + 300);
}

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

async function fetchCandlesWithRetry(sym: string, targetDate: string, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            // Try Dhan first (isSwing = false)
            let data = await fetchCandles(sym, false);
            let hasSufficientHistory = false;
            
            if (data && data.historicalCandles && data.historicalCandles.length > 0) {
                // We need candles from the day BEFORE targetDate to calculate PDH/PDL
                hasSufficientHistory = data.historicalCandles.some(c => getCandleCloseDateIST(c) < targetDate);
                if (hasSufficientHistory) return data;
            }

            console.log(`[DATA] Dhan missing sufficient history for ${sym} (needs data before ${targetDate}). Falling back to Upstox...`);
            
            // Fallback to Upstox (isSwing = true)
            data = await fetchCandles(sym, true);
            if (data && data.historicalCandles && data.historicalCandles.length > 0) {
                return data;
            }
        } catch (err: any) {
            console.log(`[Attempt ${i+1}] Failed to fetch ${sym}: ${err.message}`);
        }
        await delay(1000);
    }
    return null;
}

async function runBacktest() {
    const results = [];

    for (const { symbol: sym, date: TARGET_DATE } of testCases) {
        console.log(`Fetching candles for ${sym} (${TARGET_DATE})...`);
        
        await delay(1500);
        
        const candleData = await fetchCandlesWithRetry(sym, TARGET_DATE, 3);
        if (!candleData || !candleData.historicalCandles || candleData.historicalCandles.length === 0) {
            console.log(`Failed to fetch accurate data for ${sym} after retries. Skipping.`);
            continue;
        }

        const prevDates = Array.from(new Set(candleData.historicalCandles
            .map((c: any) => getCandleCloseDateIST(c))
            .filter((d: string) => d < TARGET_DATE)
        )).sort();
        
        const lastPrevDate = prevDates.at(-1);
        if (!lastPrevDate) {
            results.push({ Symbol: sym, Date: TARGET_DATE, Time: "-", PDH: "-", PDL: "-", Setup: "-", Direction: "-", Entry: "-", StopLoss: "-", Target: "-", Status: "⚠️ No prev-day data (date too old for API window)", HitTime: "-" });
            continue;
        }

        const prevDayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === lastPrevDate);
        if (prevDayCandles.length === 0) {
            results.push({ Symbol: sym, Date: TARGET_DATE, Time: "-", PDH: "-", PDL: "-", Setup: "-", Direction: "-", Entry: "-", StopLoss: "-", Target: "-", Status: "⚠️ No prev-day candles found", HitTime: "-" });
            continue;
        }

        const prevHigh = Math.max(...prevDayCandles.map((c: any) => c.h));
        const prevLow = Math.min(...prevDayCandles.map((c: any) => c.l));

        const targetDayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === TARGET_DATE);

        let tradeTaken = false;
        
        for (let i = 0; i < targetDayCandles.length; i++) {
            const c = targetDayCandles[i];
            const prevC = i > 0 ? targetDayCandles[i-1] : prevDayCandles[prevDayCandles.length - 1];
            const prevPrevC = i > 1 ? targetDayCandles[i-2] : (i === 1 ? prevDayCandles[prevDayCandles.length - 1] : (prevDayCandles[prevDayCandles.length - 2] || prevDayCandles[prevDayCandles.length - 1]));
            const mins = getISTMinuteOfDay(c.t + 300); 
            
            if (mins < 10 * 60 + 15 || mins > 14 * 60 + 30) {
                continue; 
            }

            let setup = "";
            let direction: string | null = null;
            let sl = 0;
            let entryPrice = c.c;
            let skippedReason = "";

            // Breakout rules
            const freshHighBreakout = prevC.c <= prevHigh && c.c > prevHigh;
            const touchedHighZone = c.l <= prevHigh * (1 + TOUCH_BUFFER_PCT) && c.h >= prevHigh;
            const chasePctHigh = (c.c - prevHigh) / prevHigh;
            const chaseAllowedHigh = chasePctHigh >= 0 && chasePctHigh <= MAX_CHASE_PCT;

            const freshLowBreakdown = prevC.c >= prevLow && c.c < prevLow;
            const touchedLowZone = c.h >= prevLow * (1 - TOUCH_BUFFER_PCT) && c.l <= prevLow;
            const chasePctLow = (prevLow - c.c) / prevLow;
            const chaseAllowedLow = chasePctLow >= 0 && chasePctLow <= MAX_CHASE_PCT;

            // Rejection rules (must touch zone and reverse, approaching from the correct side)
            const zoneTopH = prevHigh * (1 + TOUCH_BUFFER_PCT);
            const zoneBotH = prevHigh * (1 - TOUCH_BUFFER_PCT);
            const zoneTopL = prevLow * (1 + TOUCH_BUFFER_PCT);
            const zoneBotL = prevLow * (1 - TOUCH_BUFFER_PCT);

            const approachedHighFromBelow = prevPrevC.c < prevHigh && prevC.c < prevHigh;
            const touchedHighRejectionZone = c.h >= zoneBotH && c.h <= prevHigh * (1 + MAX_CHASE_PCT);
            const validHighRejection = approachedHighFromBelow && touchedHighRejectionZone && c.c < c.o && c.c <= prevHigh;

            const approachedLowFromAbove = prevPrevC.c > prevLow && prevC.c > prevLow;
            const touchedLowSupportZone = c.l <= zoneTopL && c.l >= prevLow * (1 - MAX_CHASE_PCT);
            const validLowSupport = approachedLowFromAbove && touchedLowSupportZone && c.c > c.o && c.c >= prevLow;

            if (freshHighBreakout) {
                if (touchedHighZone && chaseAllowedHigh) {
                    setup = "HIGH BREAKOUT"; direction = "LONG";
                    sl = Math.min(c.l, prevHigh * 0.999);
                } else {
                    skippedReason = "Anti-Chasing / Touch Filter";
                }
            } else if (freshLowBreakdown) {
                if (touchedLowZone && chaseAllowedLow) {
                    setup = "LOW BREAKDOWN"; direction = "SHORT";
                    sl = Math.max(c.h, prevLow * 1.001);
                } else {
                    skippedReason = "Anti-Chasing / Touch Filter";
                }
            } else if (validHighRejection) {
                setup = "HIGH REJECTION"; direction = "SHORT";
                sl = Math.max(c.h, zoneTopH) * 1.001;
            } else if (validLowSupport) {
                setup = "LOW SUPPORT"; direction = "LONG";
                sl = Math.min(c.l, zoneBotL) * 0.999;
            }

            if (direction) entryPrice = c.c;

            if (direction) {
                const hrMins = Math.floor(mins / 60).toString().padStart(2, '0') + ":" + (mins % 60).toString().padStart(2, '0');
                const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
                const target = direction === "LONG" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
                
                const entryIndex = targetDayCandles.indexOf(c);
                const remainingCandles = targetDayCandles.slice(entryIndex + 1);
                let exitStatus = "OPEN (End of Day)";
                let hitTime = "-";

                for (const rc of remainingCandles) {
                    const rcMins = getISTMinuteOfDay(rc.t + 300);
                    const rcTime = Math.floor(rcMins / 60).toString().padStart(2, '0') + ":" + (rcMins % 60).toString().padStart(2, '0');
                    
                    if (direction === "LONG") {
                        if (rc.l <= sl) {
                            exitStatus = sl === entryPrice ? "🛡️ BREAKEVEN HIT" : "❌ STOP LOSS HIT";
                            hitTime = rcTime;
                            break;
                        } else if (rc.h >= target) {
                            exitStatus = "✅ TARGET HIT";
                            hitTime = rcTime;
                            break;
                        } else if (rc.h >= entryPrice + (risk * STRUCTURAL_TRAIL_RR) && sl < entryPrice) {
                            sl = entryPrice - (risk * STRUCTURAL_TRAIL_RISK_BUFFER); // Structural Trail
                        }
                    } else { 
                        if (rc.h >= sl) {
                            exitStatus = sl === entryPrice ? "🛡️ BREAKEVEN HIT" : "❌ STOP LOSS HIT";
                            hitTime = rcTime;
                            break;
                        } else if (rc.l <= target) {
                            exitStatus = "✅ TARGET HIT";
                            hitTime = rcTime;
                            break;
                        } else if (rc.l <= entryPrice - (risk * STRUCTURAL_TRAIL_RR) && sl > entryPrice) {
                            sl = entryPrice + (risk * STRUCTURAL_TRAIL_RISK_BUFFER); // Structural Trail
                        }
                    }
                }

                results.push({
                    Symbol: sym,
                    Date: TARGET_DATE,
                    Time: hrMins,
                    PDH: prevHigh.toFixed(2),
                    PDL: prevLow.toFixed(2),
                    Setup: setup,
                    Direction: direction,
                    Entry: entryPrice.toFixed(2),
                    StopLoss: sl.toFixed(2),
                    Target: target.toFixed(2),
                    Status: exitStatus,
                    HitTime: hitTime
                });
                tradeTaken = true;
                break;
            } else if (skippedReason) {
                const hrMins = Math.floor(mins / 60).toString().padStart(2, '0') + ":" + (mins % 60).toString().padStart(2, '0');
                results.push({
                    Symbol: sym,
                    Date: TARGET_DATE,
                    Time: hrMins,
                    PDH: prevHigh.toFixed(2),
                    PDL: prevLow.toFixed(2),
                    Setup: "SKIPPED",
                    Direction: "-",
                    Entry: c.c.toFixed(2),
                    StopLoss: "-",
                    Target: "-",
                    Status: skippedReason,
                    HitTime: "-"
                });
                tradeTaken = true;
                break;
            }
        }
        
        if (!tradeTaken) {
            results.push({
                    Symbol: sym,
                    Date: TARGET_DATE,
                    Time: "-",
                    PDH: prevHigh.toFixed(2),
                    PDL: prevLow.toFixed(2),
                    Setup: "-",
                    Direction: "-",
                    Entry: "-",
                    StopLoss: "-",
                    Target: "-",
                    Status: "No prime time entry",
                    HitTime: "-"
            });
        }
    }
    
    let md = `# Intraday Backtest Results\n\n`;
    md += `Prime Time: 10:15–14:30 | Anti-Chase: 0.8% | Touch Buffer: 0.15% | Risk:Reward = 1:2\n\n`;
    md += `| Symbol | Date | Time | PDH | PDL | Setup | Dir | Entry | SL | Target | Result | P&L (10k) | Exit Time |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of results) {
        let pnlStr = "-";
        if (r.Entry !== "-" && r.Status !== "No prime time entry") {
            const entryPrice = parseFloat(r.Entry);
            const qty = Math.floor(50000 / entryPrice);
            let exitPrice = entryPrice;
            if (r.Status === "✅ TARGET HIT") exitPrice = parseFloat(r.Target);
            else if (r.Status === "❌ STOP LOSS HIT" || r.Status === "🛡️ BREAKEVEN HIT") exitPrice = parseFloat(r.StopLoss);
            
            let pnl = 0;
            if (r.Direction === "LONG") pnl = (exitPrice - entryPrice) * qty;
            else if (r.Direction === "SHORT") pnl = (entryPrice - exitPrice) * qty;
            
            pnlStr = pnl > 0 ? "+₹" + pnl.toFixed(2) : "₹" + pnl.toFixed(2);
        }
        md += `| ${r.Symbol} | ${r.Date} | ${r.Time} | ${r.PDH} | ${r.PDL} | ${r.Setup} | ${r.Direction} | ${r.Entry} | ${r.StopLoss} | ${r.Target} | **${r.Status}** | ${pnlStr} | ${r.HitTime} |\n`;
    }
    writeFileSync("./backtest_results.md", md);
    console.log("Backtest complete.");
}

runBacktest().catch(console.error);
