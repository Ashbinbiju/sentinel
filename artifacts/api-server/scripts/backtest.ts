const MC_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.moneycontrol.com/",
  Origin: "https://www.moneycontrol.com",
};

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const IST_OFFSET_MS = 19800 * 1000;
function getISTDateStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function getISTMinuteOfDay(epochSecs: number): number {
  const ist = new Date(epochSecs * 1000 + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

const NSE_TICK_SIZE = 0.05;
function roundToTick(val: number): number {
  return Math.round(val / NSE_TICK_SIZE) * NSE_TICK_SIZE;
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 30 * 24 * 3600; 
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(
    symbol,
  )}&resolution=5&from=${from}&to=${to}&countback=2500&currencyCode=INR`;

  const response = await fetch(url, { headers: MC_HEADERS });
  if (!response.ok) return [];
  const data = await response.json() as any;
  if (data.s !== "ok" || !data.t) return [];

  const all: Candle[] = data.t.map((t: number, i: number) => ({
    t,
    o: data.o?.[i] ?? 0,
    h: data.h?.[i] ?? 0,
    l: data.l?.[i] ?? 0,
    c: data.c?.[i] ?? 0,
    v: data.v?.[i] ?? 0,
  }));
  return all.sort((a, b) => a.t - b.t);
}

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.01;
const STRUCTURAL_TRAIL_RR = 1.5;
const STRUCTURAL_TRAIL_RISK_BUFFER = 0.15;
const SLIPPAGE_PCT = 0.0005; // 0.05% slippage on entry and exit
const BROKERAGE_PCT = 0.0003; // Brokerage & taxes estimate

const DRY_RUN_CAPITAL = 50000;
const RISK_PER_TRADE = DRY_RUN_CAPITAL * 0.01;
const MAX_DAILY_TRADES = 5;
const MAX_DAILY_LOSS = -2500;
const MAX_CONSECUTIVE_LOSSES = 3;

interface Trade {
  symbol: string;
  date: string;
  setup: string;
  direction: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  slPrice: number;
  targetPrice: number;
  quantity: number;
  exitTime?: string;
  exitPrice?: number;
  status: "WIN" | "LOSS" | "OPEN" | "BREAKEVEN";
  pnl: number;
  pnlInr: number;
  trailApplied: boolean;
}

async function runBacktest(screenerStocks: any[]) {
  const symbols = screenerStocks.map(s => s.symbol);
  console.log(`Starting strict chronological backtest for ${symbols.length} screener symbols...\n`);
  
  const screenerDataMap = new Map<string, any>();
  for (const s of screenerStocks) {
      screenerDataMap.set(s.symbol, s);
  }
  // 1. Fetch all candles
  const allCandlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    const candles = await fetchCandles(symbol);
    if (candles.length > 0) allCandlesBySymbol.set(symbol, candles);
    else console.log(`${symbol}: No data found.`);
  }

  // 2. Group by Date, then organize tick-by-tick
  const byDate = new Map<string, Map<string, Candle[]>>(); // date -> (symbol -> candles)
  const timestampsByDate = new Map<string, Set<number>>();
  
  for (const [symbol, candles] of Array.from(allCandlesBySymbol.entries())) {
    for (const c of candles) {
      const d = getISTDateStr(c.t);
      if (!byDate.has(d)) byDate.set(d, new Map());
      if (!byDate.get(d)!.has(symbol)) byDate.get(d)!.set(symbol, []);
      byDate.get(d)!.get(symbol)!.push(c);
      
      if (!timestampsByDate.has(d)) timestampsByDate.set(d, new Set());
      timestampsByDate.get(d)!.add(c.t);
    }
  }

  const dates = Array.from(byDate.keys()).sort();
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnlPct = 0;
  let totalPnlInr = 0;

  for (let i = 1; i < dates.length; i++) {
    const prevDate = dates[i - 1];
    const today = dates[i];
    if (today !== "2026-07-22") continue;

    const timestamps = Array.from(timestampsByDate.get(today)!).sort((a, b) => a - b);
    
    // Daily state
    const activeTrades = new Map<string, Trade>(); // symbol -> active trade
    const completedTradesToday: Trade[] = [];
    let tradesTakenToday = 0;
    let closedLosingTradesCount = 0;
    let realizedPnlTodayInr = 0;
    let killSwitchEngaged = false;

    // We need prevHigh/prevLow for each symbol
    const prevDayExtremes = new Map<string, {h: number, l: number}>();
    for (const [symbol, prevCandles] of Array.from(byDate.get(prevDate)?.entries() || [])) {
        prevDayExtremes.set(symbol, {
            h: Math.max(...prevCandles.map(c => c.h)),
            l: Math.min(...prevCandles.map(c => c.l))
        });
    }

    // Process tick by tick (5m candle by 5m candle across all symbols)
    for (const ts of timestamps) {
      const mins = getISTMinuteOfDay(ts + 300); // close time of candle
      
      // Update Kill Switch
      if (!killSwitchEngaged) {
          if (realizedPnlTodayInr <= MAX_DAILY_LOSS || closedLosingTradesCount >= MAX_CONSECUTIVE_LOSSES) {
              console.log(`[KILL SWITCH] Engaged on ${today}. Max loss or consecutive losses reached. Squaring off!`);
              killSwitchEngaged = true;
          }
      }

      for (const [symbol, todayCandles] of Array.from(byDate.get(today)?.entries() || [])) {
        const cIndex = todayCandles.findIndex(c => c.t === ts);
        if (cIndex === -1) continue;
        const c = todayCandles[cIndex];

        let activeTrade = activeTrades.get(symbol);
        
        // --- EVALUATE ACTIVE TRADE ---
        if (activeTrade) {
          let exitPrice = 0;
          let hit = false;
          
          // Emergency square-off if kill switch engaged
          if (killSwitchEngaged || mins >= 15 * 60 + 15) {
              exitPrice = c.c;
              hit = true;
          } else {
              // Standard Stop Loss / Target Evaluation
              if (activeTrade.direction === "LONG") {
                if (c.l <= activeTrade.slPrice) {
                  exitPrice = activeTrade.slPrice;
                  hit = true;
                } else if (c.h >= activeTrade.targetPrice) {
                  exitPrice = activeTrade.targetPrice;
                  hit = true;
                }
              } else {
                if (c.h >= activeTrade.slPrice) {
                  exitPrice = activeTrade.slPrice;
                  hit = true;
                } else if (c.l <= activeTrade.targetPrice) {
                  exitPrice = activeTrade.targetPrice;
                  hit = true;
                }
              }
              
              // Trailing Stop Loss Evaluation (if not hit target/SL yet)
              if (!hit && !activeTrade.trailApplied) {
                  const r = Math.abs(activeTrade.entryPrice - activeTrade.slPrice);
                  if (activeTrade.direction === "LONG" && c.c >= activeTrade.entryPrice + (r * STRUCTURAL_TRAIL_RR)) {
                      activeTrade.slPrice = roundToTick(activeTrade.entryPrice - (r * STRUCTURAL_TRAIL_RISK_BUFFER));
                      activeTrade.trailApplied = true;
                  } else if (activeTrade.direction === "SHORT" && c.c <= activeTrade.entryPrice - (r * STRUCTURAL_TRAIL_RR)) {
                      activeTrade.slPrice = roundToTick(activeTrade.entryPrice + (r * STRUCTURAL_TRAIL_RISK_BUFFER));
                      activeTrade.trailApplied = true;
                  }
              }
          }

          if (hit) {
            activeTrade.exitPrice = exitPrice;
            activeTrade.exitTime = new Date((c.t + 300) * 1000 + IST_OFFSET_MS).toISOString().substr(11, 5);
            
            const gross = activeTrade.direction === "LONG" 
              ? (exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice
              : (activeTrade.entryPrice - exitPrice) / activeTrade.entryPrice;
            
            activeTrade.pnl = gross - (SLIPPAGE_PCT * 2) - BROKERAGE_PCT;
            activeTrade.pnlInr = (activeTrade.pnl * activeTrade.entryPrice) * activeTrade.quantity;
            
            if (activeTrade.pnl > 0) {
                activeTrade.status = "WIN";
                closedLosingTradesCount = 0;
            } else if (activeTrade.pnl < 0) {
                activeTrade.status = "LOSS";
                closedLosingTradesCount++;
            } else {
                activeTrade.status = "BREAKEVEN";
            }
            
            console.log(`[${symbol}] ${activeTrade.setup} ${activeTrade.direction} @ ${activeTrade.entryPrice.toFixed(2)} -> exited at ${exitPrice.toFixed(2)} (${activeTrade.status}). PnL: ${(activeTrade.pnl * 100).toFixed(2)}% | INR: ₹${activeTrade.pnlInr.toFixed(2)}`);

            realizedPnlTodayInr += activeTrade.pnlInr;
            completedTradesToday.push(activeTrade);
            activeTrades.delete(symbol);
          }
          continue; // Cannot take another trade on the exact same candle
        }

        // --- EVALUATE NEW TRADE SETUP ---
        if (killSwitchEngaged) continue;
        if (tradesTakenToday >= MAX_DAILY_TRADES) continue;
        if (mins < 10 * 60 + 15 || mins > 14 * 60 + 30) continue;
        if (cIndex < 2) continue; // Need 2 previous candles for fresh breakout logic

        const prevExtremes = prevDayExtremes.get(symbol);
        if (!prevExtremes) continue;
        const { h: prevHigh, l: prevLow } = prevExtremes;

        const prevC = todayCandles[cIndex - 1];
        const prevPrevC = todayCandles[cIndex - 2];

        let setup = "";
        let direction: "LONG" | "SHORT" | null = null;
        let sl = 0;
        let entryPrice = c.c;

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

        if (freshHighBreakout) {
            if (touchedHighZone && chaseAllowedHigh) {
                setup = "HIGH BREAKOUT"; direction = "LONG";
                sl = Math.min(c.l, prevHigh * (1 - SL_BUFFER_PCT));
            }
        } else if (freshLowBreakdown) {
            if (touchedLowZone && chaseAllowedLow) {
                setup = "LOW BREAKDOWN"; direction = "SHORT";
                sl = Math.max(c.h, prevLow * (1 + SL_BUFFER_PCT));
            }
        } else if (validHighRejection) {
            setup = "HIGH REJECTION"; direction = "SHORT";
            sl = Math.max(c.h, zoneTopH * (1 + SL_BUFFER_PCT));
        } else if (validLowSupport) {
            setup = "LOW SUPPORT"; direction = "LONG";
            sl = Math.min(c.l, zoneBotL * (1 - SL_BUFFER_PCT));
        }

        // Gainer/Loser filter
        const screenerStock = screenerDataMap.get(symbol);
        if (screenerStock) {
            if (direction === "LONG" && screenerStock.category === "LOSER") {
                direction = null;
            } else if (direction === "SHORT" && screenerStock.category === "GAINER") {
                direction = null;
            }
        }

        if (direction) {
          entryPrice = roundToTick(entryPrice);
          sl = roundToTick(sl);
          
          const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
          const target = roundToTick(direction === "LONG" ? entryPrice + (risk * 2) : entryPrice - (risk * 2));
          
          let qty = Math.floor(RISK_PER_TRADE / risk);
          if (qty < 1) qty = 1;
          const maxLeveragedQty = Math.floor((DRY_RUN_CAPITAL * 5) / entryPrice);
          qty = Math.min(qty, maxLeveragedQty);

          if (qty > 0) {
              const newTrade: Trade = {
                symbol,
                date: today,
                setup,
                direction,
                entryTime: new Date((c.t + 300) * 1000 + IST_OFFSET_MS).toISOString().substr(11, 5),
                entryPrice,
                slPrice: sl,
                targetPrice: target,
                quantity: qty,
                status: "OPEN",
                pnl: 0,
                pnlInr: 0,
                trailApplied: false
              };
              
              activeTrades.set(symbol, newTrade);
              tradesTakenToday++;
          }
        }
      }
    }
    
    for (const t of completedTradesToday) {
        if (t.pnl > 0) wins++;
        else if (t.pnl < 0) losses++;
        totalPnlPct += t.pnl;
        totalPnlInr += t.pnlInr;
        totalTrades++;
    }
  }

  console.log("\n--- BACKTEST SUMMARY ---");
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Win Rate: ${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0}%`);
  console.log(`Total Net Return (Sum of %): ${(totalPnlPct * 100).toFixed(2)}%`);
  console.log(`Total Profit in INR (assuming ₹50k capital): ₹${totalPnlInr.toFixed(2)}`);
}

async function main() {
  try {
    console.log("Fetching Screener Data...");
    const url = "https://intradayscreener.com/api/trackStocks/cash";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json() as any;
    
    const gainers = Array.isArray(data.intradayGainers) ? data.intradayGainers.slice(0, 15).map((s: any) => ({ ...s, category: "GAINER" })) : [];
    const losers = Array.isArray(data.intradayLosers) ? data.intradayLosers.slice(0, 15).map((s: any) => ({ ...s, category: "LOSER" })) : [];
    const combined = [...gainers, ...losers];
    
    const uniqueStocks = Array.from(new Map(combined.map((s: any) => [s.symbol?.trim(), s])).values()) as any[];
    const validStocks = uniqueStocks.filter(s => s.symbol && s.ltp > 100);
    
    await runBacktest(validStocks);
  } catch (err) {
    console.error("Error fetching screener data", err);
  }
}

main();
