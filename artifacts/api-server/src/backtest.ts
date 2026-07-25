import { fetchCandles } from "./routes/stocks";
import { writeFileSync } from "fs";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.01; // Increased for breathing space
const STRUCTURAL_TRAIL_RR = 1.0;
const STRUCTURAL_TRAIL_RISK_BUFFER = 0.05;
const SLIPPAGE_PCT = 0.0005;
const CHARGES_PCT_TURNOVER = 0.0005;


const DRY_RUN_CAPITAL = 50000;
const RISK_PER_TRADE = DRY_RUN_CAPITAL * 0.01;
const MAX_DAILY_TRADES = 5;
const MAX_DAILY_LOSS = -2500;
const MAX_CONSECUTIVE_LOSSES = 3;
const ENTRY_START_MINS = 9 * 60 + 30;
const ENTRY_END_MINS = 11 * 60 + 30;


function formatMinsToIST(mins: number): string {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

let testCases: { symbol: string; date: string; category: string }[] = [];


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
            let data = await fetchCandles(sym, false);
            let hasSufficientHistory = false;
            
            if (data && data.historicalCandles && data.historicalCandles.length > 0) {
                hasSufficientHistory = data.historicalCandles.some((c: any) => getCandleCloseDateIST(c) < targetDate);
                if (hasSufficientHistory) return data;
            }

            console.log(`[DATA] Dhan missing sufficient history for ${sym} (needs data before ${targetDate}). Falling back to Upstox...`);
            
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

interface Trade {
    symbol: string;
    date: string;
    setup: string;
    direction: "LONG" | "SHORT";
    entryTime: string;
    entryTimeMins: number;
    entryPrice: number;
    initialSl: number;
    slPrice: number;
    targetPrice: number;
    quantity: number;
    exitTime?: string;
    exitPrice?: number;
    status: string;
    pnl: number;
    pnlInr: number;
    trailApplied: boolean;
    pdh: number;
    pdl: number;
    eodPrice?: number;
}

async function runBacktest() {
    console.log("Fetching top 20 gainers and 20 losers from intradayscreener...");
    try {
        const url = "https://intradayscreener.com/api/trackStocks/cash";
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const data = await res.json() as any;
        if (data) {
            const gainers = Array.isArray(data.intradayGainers) ? Array.from(new Map(data.intradayGainers.slice(0, 30).map((s: any) => [s.symbol?.trim(), s])).values()).slice(0, 20) : [];
            const losers = Array.isArray(data.intradayLosers) ? Array.from(new Map(data.intradayLosers.slice(0, 30).map((s: any) => [s.symbol?.trim(), s])).values()).slice(0, 20) : [];
            
            const gainerCases = gainers.filter((s: any) => s.symbol && s.ltp > 100).map((s: any) => ({
                symbol: s.symbol,
                date: "2026-07-24",
                category: "GAINER"
            }));
            const loserCases = losers.filter((s: any) => s.symbol && s.ltp > 100).map((s: any) => ({
                symbol: s.symbol,
                date: "2026-07-24",
                category: "LOSER"
            }));
            testCases = [...gainerCases, ...loserCases];
        }
    } catch (e: any) {
        console.error("Failed to fetch dynamic watchlist:", e.message);
    }
    
    if (testCases.length === 0) {
        console.error("No test cases found.");
        return;
    }

    const testDate = "2026-07-24";
    
    // 1. Fetch all candles
    const allCandlesBySymbol = new Map<string, any[]>();
    const prevExtremes = new Map<string, {h: number, l: number}>();
    
    for (const { symbol: sym, date, category } of testCases) {
        console.log(`Fetching candles for ${sym} (${category}) for ${testDate}...`);
        await delay(1500);
        const candleData = await fetchCandlesWithRetry(sym, testDate, 3);
        if (!candleData || !candleData.historicalCandles || candleData.historicalCandles.length === 0) {
            console.log(`Failed to fetch accurate data for ${sym} after retries. Skipping.`);
            continue;
        }
        
        const prevDates = Array.from(new Set(candleData.historicalCandles
            .map((c: any) => getCandleCloseDateIST(c))
            .filter((d: string) => d < testDate)
        )).sort();
        
        const lastPrevDate = prevDates.at(-1);
        if (!lastPrevDate) {
            console.log(`⚠️ No prev-day data for ${sym}`);
            continue;
        }

        const prevDayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === lastPrevDate);
        if (prevDayCandles.length === 0) {
            console.log(`⚠️ No prev-day candles found for ${sym}`);
            continue;
        }

        const prevHigh = Math.max(...prevDayCandles.map((c: any) => c.h));
        const prevLow = Math.min(...prevDayCandles.map((c: any) => c.l));
        prevExtremes.set(sym, { h: prevHigh, l: prevLow });
        
        // Save today's candles
        const targetDayCandles = candleData.historicalCandles.filter((c: any) => getCandleCloseDateIST(c) === testDate);
        // Ensure they are sorted by time just in case
        targetDayCandles.sort((a: any, b: any) => a.t - b.t);
        allCandlesBySymbol.set(sym, targetDayCandles);
    }
    
    // 2. Chronological processing
    const timestampsSet = new Set<number>();
    for (const candles of Array.from(allCandlesBySymbol.values())) {
        for (const c of candles) {
            timestampsSet.add(c.t);
        }
    }
    const timestamps = Array.from(timestampsSet).sort((a, b) => a - b);
    
    let tradesTakenToday = 0;
    let closedLosingTradesCount = 0;
    let realizedPnlTodayInr = 0;
    let killSwitchEngaged = false;
    
    const activeTrades = new Map<string, Trade>();
    const completedTrades: Trade[] = [];
    const skippedSetups: any[] = [];
    
    for (const ts of timestamps) {
        const mins = getISTMinuteOfDay(ts + 300);
        const hrMins = Math.floor(mins / 60).toString().padStart(2, '0') + ":" + (mins % 60).toString().padStart(2, '0');
        
        if (!killSwitchEngaged) {
            if (realizedPnlTodayInr <= MAX_DAILY_LOSS || closedLosingTradesCount >= MAX_CONSECUTIVE_LOSSES) {
                console.log(`[KILL SWITCH] Engaged at ${hrMins}. Squaring off!`);
                killSwitchEngaged = true;
            }
        }
        
        for (const [sym, todayCandles] of Array.from(allCandlesBySymbol.entries())) {
            const cIndex = todayCandles.findIndex((c: any) => c.t === ts);
            if (cIndex === -1) continue;
            const c = todayCandles[cIndex];
            
            let activeTrade = activeTrades.get(sym);
            
            // EVALUATE ACTIVE TRADE
            if (activeTrade) {
                let exitPrice = 0;
                let hit = false;
                let statusMsg = "";
                
                if (killSwitchEngaged || mins >= 15 * 60 + 15) {
                    exitPrice = c.c;
                    hit = true;
                    statusMsg = killSwitchEngaged ? "OPEN (Kill Switch Hit)" : "OPEN (End of Day)";
                } else {
                    if (activeTrade.direction === "LONG") {
                        if (c.l <= activeTrade.slPrice) {
                            exitPrice = activeTrade.slPrice;
                            hit = true;
                            statusMsg = activeTrade.trailApplied ? "🛡️ BREAKEVEN HIT" : "❌ STOP LOSS HIT";
                        } else if (c.h >= activeTrade.targetPrice) {
                            exitPrice = activeTrade.targetPrice;
                            hit = true;
                            statusMsg = "✅ TARGET HIT";
                        }
                    } else {
                        if (c.h >= activeTrade.slPrice) {
                            exitPrice = activeTrade.slPrice;
                            hit = true;
                            statusMsg = activeTrade.trailApplied ? "🛡️ BREAKEVEN HIT" : "❌ STOP LOSS HIT";
                        } else if (c.l <= activeTrade.targetPrice) {
                            exitPrice = activeTrade.targetPrice;
                            hit = true;
                            statusMsg = "✅ TARGET HIT";
                        }
                    }
                    
                    if (!hit && !activeTrade.trailApplied) {
                        const r = Math.abs(activeTrade.entryPrice - activeTrade.slPrice);
                        if (activeTrade.direction === "LONG" && c.h >= activeTrade.entryPrice + (r * STRUCTURAL_TRAIL_RR) && activeTrade.slPrice < activeTrade.entryPrice) {
                            activeTrade.slPrice = activeTrade.entryPrice - (r * STRUCTURAL_TRAIL_RISK_BUFFER);
                            activeTrade.trailApplied = true;
                        } else if (activeTrade.direction === "SHORT" && c.l <= activeTrade.entryPrice - (r * STRUCTURAL_TRAIL_RR) && activeTrade.slPrice > activeTrade.entryPrice) {
                            activeTrade.slPrice = activeTrade.entryPrice + (r * STRUCTURAL_TRAIL_RISK_BUFFER);
                            activeTrade.trailApplied = true;
                        }
                    }
                }
                
                if (hit) {
                    activeTrade.exitPrice = exitPrice;
                    activeTrade.exitTime = hrMins;
                    activeTrade.status = statusMsg;
                    
                    const gross = activeTrade.direction === "LONG" 
                        ? (exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice
                        : (activeTrade.entryPrice - exitPrice) / activeTrade.entryPrice;
                        
                    activeTrade.pnl = gross - (SLIPPAGE_PCT * 2) - CHARGES_PCT_TURNOVER;
                    activeTrade.pnlInr = (activeTrade.pnl * activeTrade.entryPrice) * activeTrade.quantity;
                    
                    if (activeTrade.pnl > 0 && statusMsg.includes("TARGET")) {
                        closedLosingTradesCount = 0;
                    } else if (activeTrade.pnl < 0 && statusMsg.includes("STOP LOSS")) {
                        closedLosingTradesCount++;
                    }
                    
                    realizedPnlTodayInr += activeTrade.pnlInr;
                    completedTrades.push(activeTrade);
                    activeTrades.delete(sym);
                }
                continue;
            }
            
            // EVALUATE NEW SETUP
            if (killSwitchEngaged) continue;
            if (mins < ENTRY_START_MINS || mins > ENTRY_END_MINS) continue;

            if (cIndex < 2) continue;
            
            const extremes = prevExtremes.get(sym);
            if (!extremes) continue;
            const { h: prevHigh, l: prevLow } = extremes;
            
            const prevC = todayCandles[cIndex - 1];
            const prevPrevC = todayCandles[cIndex - 2];
            
            let setup = "";
            let direction: "LONG" | "SHORT" | null = null;
            let sl = 0;
            let entryPrice = c.c;
            let skippedReason = "";
            
            const candleRange = Math.max(c.h - c.l, 0.05);
            const upperWick = c.h - Math.max(c.o, c.c);
            const lowerWick = Math.min(c.o, c.c) - c.l;

            const freshHighBreakout = prevC.c <= prevHigh && c.c > prevHigh;
            const touchedHighZone = c.l <= prevHigh * (1 + TOUCH_BUFFER_PCT) && c.h >= prevHigh;
            const chasePctHigh = (c.c - prevHigh) / prevHigh;
            const chaseAllowedHigh = chasePctHigh >= 0 && chasePctHigh <= MAX_CHASE_PCT;

            const freshLowBreakdown = prevC.c >= prevLow && c.c < prevLow;
            const touchedLowZone = c.h >= prevLow * (1 - TOUCH_BUFFER_PCT) && c.l <= prevLow;
            const chasePctLow = (prevLow - c.c) / prevLow;
            const chaseAllowedLow = chasePctLow >= 0 && chasePctLow <= MAX_CHASE_PCT;

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
                if (c.c <= c.o) {
                    skippedReason = "Bearish breakout candle close";
                } else if (upperWick / candleRange > 0.35) {
                    skippedReason = "Long upper rejection wick";
                } else if (touchedHighZone && chaseAllowedHigh) {
                    setup = "HIGH BREAKOUT"; direction = "LONG";
                    sl = Math.min(c.l, prevHigh * (1 - SL_BUFFER_PCT));
                } else {
                    skippedReason = "Anti-Chasing / Touch Filter";
                }
            } else if (freshLowBreakdown) {
                if (c.c >= c.o) {
                    skippedReason = "Bullish breakdown candle close";
                } else if (lowerWick / candleRange > 0.35) {
                    skippedReason = "Long lower rejection wick";
                } else if (touchedLowZone && chaseAllowedLow) {
                    setup = "LOW BREAKDOWN"; direction = "SHORT";
                    sl = Math.max(c.h, prevLow * (1 + SL_BUFFER_PCT));
                } else {
                    skippedReason = "Anti-Chasing / Touch Filter";
                }
            } else if (validHighRejection) {
                setup = "HIGH REJECTION"; direction = "SHORT";
                sl = Math.max(c.h, zoneTopH * (1 + SL_BUFFER_PCT));
            } else if (validLowSupport) {
                setup = "LOW SUPPORT"; direction = "LONG";
                sl = Math.min(c.l, zoneBotL * (1 - SL_BUFFER_PCT));
            }
            
            const category = testCases.find(tc => tc.symbol === sym)?.category;
            if (direction === "LONG" && category === "LOSER") {
                direction = null;
                skippedReason = "Longs disabled (Intraday Loser filter)";
            } else if (direction === "SHORT" && category === "GAINER") {
                direction = null;
                skippedReason = "Shorts disabled (Intraday Gainer filter)";
            }
            
            if (direction) {
                if (tradesTakenToday >= MAX_DAILY_TRADES) {
                    // Record it as skipped due to limit
                    skippedSetups.push({
                        Symbol: sym,
                        Date: testDate,
                        Time: hrMins,
                        PDH: prevHigh.toFixed(2),
                        PDL: prevLow.toFixed(2),
                        Setup: setup,
                        Direction: "-",
                        Entry: entryPrice.toFixed(2),
                        InitialSL: "-",
                        ActiveSL: "-",
                        Target: "-",
                        Status: "SKIPPED (Max Daily Trades Reached)",
                        HitTime: "-"
                    });
                    continue;
                }
                
                const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
                const target = direction === "LONG" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
                let qty = Math.floor(RISK_PER_TRADE / risk);
                if (qty < 1) qty = 1;
                const maxLeveragedQty = Math.floor((DRY_RUN_CAPITAL * 5) / entryPrice);
                qty = Math.min(qty, maxLeveragedQty);
                
                if (qty > 0) {
                    const newTrade: Trade = {
                        symbol: sym,
                        date: testDate,
                        setup,
                        direction,
                        entryTime: hrMins,
                        entryTimeMins: mins,
                        entryPrice,
                        initialSl: sl,
                        slPrice: sl,
                        targetPrice: target,
                        quantity: qty,
                        status: "OPEN",
                        pnl: 0,
                        pnlInr: 0,
                        trailApplied: false,
                        pdh: prevHigh,
                        pdl: prevLow,
                        eodPrice: todayCandles[todayCandles.length - 1].c
                    };
                    activeTrades.set(sym, newTrade);
                    tradesTakenToday++;
                }
            } else if (skippedReason && !completedTrades.some(t => t.symbol === sym && t.entryTime === hrMins)) {
                 // Only push skipped reason if it's the first time on this candle
                 skippedSetups.push({
                    Symbol: sym,
                    Date: testDate,
                    Time: hrMins,
                    PDH: prevHigh.toFixed(2),
                    PDL: prevLow.toFixed(2),
                    Setup: "SKIPPED",
                    Direction: "-",
                    Entry: c.c.toFixed(2),
                    InitialSL: "-",
                    ActiveSL: "-",
                    Target: "-",
                    Status: skippedReason,
                    HitTime: "-"
                });
            }
        }
    }
    
    // Close out any remaining open trades at EOD
    for (const [sym, t] of Array.from(activeTrades.entries())) {
        t.exitPrice = t.eodPrice || t.entryPrice;
        t.status = "OPEN (End of Day)";
        t.exitTime = "-";
        const gross = t.direction === "LONG" 
            ? (t.exitPrice - t.entryPrice) / t.entryPrice
            : (t.entryPrice - t.exitPrice) / t.entryPrice;
        t.pnl = gross - (SLIPPAGE_PCT * 2) - CHARGES_PCT_TURNOVER;
        t.pnlInr = (t.pnl * t.entryPrice) * t.quantity;
        completedTrades.push(t);
    }
    
    // Combine all results and skipped setups for output
    const primeTimeStr = `${formatMinsToIST(ENTRY_START_MINS)}–${formatMinsToIST(ENTRY_END_MINS)}`;
    let md = `# Intraday Backtest Results (Chronological)\n\n`;
    md += `Prime Time: ${primeTimeStr} | Anti-Chase: ${(MAX_CHASE_PCT * 100).toFixed(1)}% | Touch Buffer: ${(TOUCH_BUFFER_PCT * 100).toFixed(2)}% | Risk:Reward = 1:2 | Leverage: 5x | Max Daily Trades: ${MAX_DAILY_TRADES}\n\n`;
    md += `| Symbol | Date | Time | PDH | PDL | Setup | Dir | Entry | Initial SL | Active SL | Target | Result | P&L (50k) | Exit Time |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

    
    const outputRows = [];
    
    for (const t of completedTrades) {
        let pnlStr = "-";
        let actualPnl = t.pnlInr !== undefined ? t.pnlInr : 0;
        
        if (t.pnlInr === undefined) {
            const entryPrice = t.entryPrice;
            const qty = t.quantity;
            let exitPrice = t.exitPrice || t.entryPrice;
            
            if (t.direction === "LONG") actualPnl = (exitPrice - entryPrice) * qty;
            else if (t.direction === "SHORT") actualPnl = (entryPrice - exitPrice) * qty;
            
            if (actualPnl !== 0 || t.status === "🛡️ BREAKEVEN HIT" || t.status.includes("OPEN")) {
                const entryVal = entryPrice * qty;
                const exitVal = exitPrice * qty;
                const turnover = entryVal + exitVal;
                const slippage = (entryVal * SLIPPAGE_PCT) + (exitVal * SLIPPAGE_PCT);
                const charges = turnover * CHARGES_PCT_TURNOVER;
                actualPnl = actualPnl - slippage - charges;
            }
        }
        
        pnlStr = actualPnl > 0 ? "+₹" + actualPnl.toFixed(2) : "₹" + actualPnl.toFixed(2);

        
        outputRows.push({
             Time: t.entryTime,
             Row: `| ${t.symbol} | ${t.date} | ${t.entryTime} | ${t.pdh.toFixed(2)} | ${t.pdl.toFixed(2)} | ${t.setup} | ${t.direction} | ${t.entryPrice.toFixed(2)} | ${t.initialSl.toFixed(2)} | ${t.slPrice !== t.initialSl ? 'Trailed to ' + t.slPrice.toFixed(2) : 'Initial SL'} | ${t.targetPrice.toFixed(2)} | **${t.status}** | ${pnlStr} | ${t.exitTime} |`
        });
    }
    
    for (const s of skippedSetups) {
        outputRows.push({
            Time: s.Time,
            Row: `| ${s.Symbol} | ${s.Date} | ${s.Time} | ${s.PDH} | ${s.PDL} | ${s.Setup} | ${s.Direction} | ${s.Entry} | ${s.InitialSL} | ${s.ActiveSL} | ${s.Target} | **${s.Status}** | - | ${s.HitTime} |`
        });
    }
    
    // Fill in no prime time entries for symbols that did absolutely nothing
    const tradedOrSkippedSymbols = new Set([...completedTrades.map(t => t.symbol), ...skippedSetups.map(s => s.Symbol)]);
    for (const { symbol } of testCases) {
        if (!tradedOrSkippedSymbols.has(symbol)) {
            const ext = prevExtremes.get(symbol);
            if (ext) {
                outputRows.push({
                    Time: "99:99",
                    Row: `| ${symbol} | ${testDate} | - | ${ext.h.toFixed(2)} | ${ext.l.toFixed(2)} | - | - | - | - | - | - | **No prime time entry** | - | - |`
                });
            }
        }
    }
    
    // Sort rows by time so it looks chronological
    outputRows.sort((a, b) => a.Time.localeCompare(b.Time));
    for (const r of outputRows) {
        md += r.Row + "\n";
    }
    
    writeFileSync("./backtest_results.md", md);
    console.log("Backtest complete.");
}

runBacktest().catch(console.error);
