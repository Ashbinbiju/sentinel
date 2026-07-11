import { fetchCandles } from "./routes/stocks";
import { writeFileSync } from "fs";

const TARGET_DATE = "2026-07-10"; // Friday
const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;

const testSymbols = [
    "ELECON"
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

async function fetchCandlesWithRetry(sym: string, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await fetchCandles(sym);
            // Verify we actually got data to avoid falling back to Moneycontrol blindly
            if (data && data.historicalCandles && data.historicalCandles.length > 0) {
                return data;
            }
        } catch (err: any) {
            console.log(`[Attempt ${i+1}] Failed to fetch ${sym}: ${err.message}`);
        }
        await delay(1000); // 1-second delay between retries
    }
    return null;
}

async function runBacktest() {
    const results = [];

    for (const sym of testSymbols) {
        console.log(`Fetching candles for ${sym}...`);
        
        // Respect rate limit: pause for 1 second before fetching the next stock
        await delay(1000);
        
        const candleData = await fetchCandlesWithRetry(sym, 3);
        if (!candleData || !candleData.historicalCandles || candleData.historicalCandles.length === 0) {
            console.log(`Failed to fetch accurate data for ${sym} after retries. Skipping.`);
            continue;
        }

        const prevDates = Array.from(new Set(candleData.historicalCandles
            .map((c: any) => getCandleCloseDateIST(c))
            .filter((d: string) => d < TARGET_DATE)
        )).sort();
        
        const lastPrevDate = prevDates.at(-1);
        if (!lastPrevDate) continue;

        const prevDayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === lastPrevDate);
        if (prevDayCandles.length === 0) continue;

        const prevHigh = Math.max(...prevDayCandles.map((c: any) => c.h));
        const prevLow = Math.min(...prevDayCandles.map((c: any) => c.l));

        const fridayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === TARGET_DATE);


        
        let tradeTaken = false;
        
        for (const c of fridayCandles) {
            const mins = getISTMinuteOfDay(c.t + 300); 
            
            if (mins < 10 * 60 + 15 || mins > 14 * 60 + 30) {
                continue; 
            }

            let setup = "";
            let direction: string | null = null;
            let sl = 0;
            let entryPrice = c.c;
            let skippedReason = "";

            if (c.h >= prevHigh * (1 - TOUCH_BUFFER_PCT)) {
                if (c.c > prevHigh) {
                    if (c.c <= prevHigh * (1 + MAX_CHASE_PCT)) {
                        setup = "HIGH BREAKOUT"; direction = "LONG";
                        sl = Math.min(c.l, prevHigh * 0.999);
                    } else {
                        skippedReason = "Anti-Chasing Filter";
                    }
                } else if (c.c < c.o) {
                    setup = "HIGH REJECTION"; direction = "SHORT";
                    sl = Math.max(c.h, prevHigh * 1.001);
                }
                if (direction) entryPrice = c.c;
            } else if (c.l <= prevLow * (1 + TOUCH_BUFFER_PCT)) {
                if (c.c < prevLow) {
                    if (c.c >= prevLow * (1 - MAX_CHASE_PCT)) {
                        setup = "LOW BREAKDOWN"; direction = "SHORT";
                        sl = Math.max(c.h, prevLow * 1.001);
                    } else {
                        skippedReason = "Anti-Chasing Filter";
                    }
                } else if (c.c > c.o) {
                    setup = "LOW SUPPORT"; direction = "LONG";
                    sl = Math.min(c.l, prevLow * 0.999);
                }
                if (direction) entryPrice = c.c;
            }

            if (direction) {
                const hrMins = Math.floor(mins / 60).toString().padStart(2, '0') + ":" + (mins % 60).toString().padStart(2, '0');
                const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
                const target = direction === "LONG" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
                
                const entryIndex = fridayCandles.indexOf(c);
                const remainingCandles = fridayCandles.slice(entryIndex + 1);
                let exitStatus = "OPEN (End of Day)";
                let hitTime = "-";

                for (const rc of remainingCandles) {
                    const rcMins = getISTMinuteOfDay(rc.t + 300);
                    const rcTime = Math.floor(rcMins / 60).toString().padStart(2, '0') + ":" + (rcMins % 60).toString().padStart(2, '0');
                    
                    if (direction === "LONG") {
                        if (rc.l <= sl) {
                            exitStatus = "❌ STOP LOSS HIT";
                            hitTime = rcTime;
                            break;
                        } else if (rc.h >= target) {
                            exitStatus = "✅ TARGET HIT";
                            hitTime = rcTime;
                            break;
                        }
                    } else { 
                        if (rc.h >= sl) {
                            exitStatus = "❌ STOP LOSS HIT";
                            hitTime = rcTime;
                            break;
                        } else if (rc.l <= target) {
                            exitStatus = "✅ TARGET HIT";
                            hitTime = rcTime;
                            break;
                        }
                    }
                }

                results.push({
                    Symbol: sym,
                    Time: hrMins,
                    PDH: prevHigh.toFixed(2),
                    Setup: setup,
                    Direction: direction,
                    Entry: entryPrice.toFixed(2),
                    StopLoss: sl.toFixed(2),
                    Target: target.toFixed(2),
                    CloseDistance: `${((c.c / prevHigh - 1) * 100).toFixed(2)}%`,
                    Status: exitStatus,
                    HitTime: hitTime
                });
                tradeTaken = true;
                break;
            } else if (skippedReason) {
                const hrMins = Math.floor(mins / 60).toString().padStart(2, '0') + ":" + (mins % 60).toString().padStart(2, '0');
                results.push({
                    Symbol: sym,
                    Time: hrMins,
                    PDH: prevHigh.toFixed(2),
                    Setup: "SKIPPED",
                    Direction: "-",
                    Entry: c.c.toFixed(2),
                    StopLoss: "-",
                    Target: "-",
                    CloseDistance: `${((c.c / prevHigh - 1) * 100).toFixed(2)}%`,
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
                    Time: "-",
                    PDH: prevHigh.toFixed(2),
                    Setup: "-",
                    Direction: "-",
                    Entry: "-",
                    StopLoss: "-",
                    Target: "-",
                    CloseDistance: "-",
                    Status: "No prime time entry",
                    HitTime: "-"
            });
        }
    }
    
    let md = `# Intraday Backtest Results\n\n`;
    md += `This table shows exactly how the bot evaluated these stocks using the Prime Time window (10:15 - 14:30) and the 0.8% Anti-Chasing filter with 0.15% Touch Buffer.\n\n`;
    md += `| Symbol | Time | PDH | Setup | Dir | Entry | SL | Target | Result | Exit Time |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of results) {
        md += `| ${r.Symbol} | ${r.Time} | ${r.PDH} | ${r.Setup} | ${r.Direction} | ${r.Entry} | ${r.StopLoss} | ${r.Target} | **${r.Status}** | ${r.HitTime} |\n`;
    }
    writeFileSync("./backtest_results.md", md);
    console.log("Backtest complete.");
}

runBacktest().catch(console.error);
