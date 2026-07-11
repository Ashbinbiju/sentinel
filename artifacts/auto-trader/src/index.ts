import { initializeScripMaster, getSecurityId } from "./scrip-master";
import { DhanBroker } from "./dhan";
import { TradeDB } from "./db";
import { CandleEngine, Candle } from "./candle-engine";
import { ExecutionEngine, WatchlistContext } from "./engine";
import axios from "axios";

const DRY_RUN = process.env.DRY_RUN === "true";
const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

let isShuttingDown = false;
const shutdown = () => {
  console.log("[BOT] Shutdown signal received.");
  isShuttingDown = true;
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Fetch Volume Shockers
async function getDailyWatchlist(): Promise<WatchlistContext[]> {
  const list: WatchlistContext[] = [];
  try {
    const seUrl = "https://api.stockedge.com/Api/trendingstocksapi/GetVolumeShockers?page=1&pageSize=10&relevantListings=10&lang=en";
    const seRes = await axios.get(seUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    
    if (seRes.data && Array.isArray(seRes.data)) {
      for (const s of seRes.data) {
        const symbol = s.Symbol;
        const ltp = s.C;
        const changePct = s.CZG;
        
        if (ltp > 100 && changePct < 15) {
          const securityId = getSecurityId(symbol);
          if (securityId) {
            // Fetch historical context from api-server
            try {
              const histRes = await axios.get(`${API_BASE_URL}/api/stocks/${symbol}/candles`);
              if (histRes.data && histRes.data.historicalCandles) {
                const histCandles = histRes.data.historicalCandles as Candle[];
                // Filter out today
                const todaySlot = new Date().toISOString().slice(0,10);
                const prevCandles = histCandles.filter(c => {
                  const d = new Date(c.t * 1000);
                  const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
                  return dtStr !== todaySlot;
                });
                
                if (prevCandles.length > 0) {
                  // Find last date
                  const dates = Array.from(new Set(prevCandles.map(c => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t*1000))))).sort();
                  const lastDate = dates[dates.length - 1];
                  const lastDayCandles = prevCandles.filter(c => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t*1000)) === lastDate);
                  
                  const prevHigh = Math.max(...lastDayCandles.map(c => c.h));
                  const prevLow = Math.min(...lastDayCandles.map(c => c.l));
                  
                  list.push({
                    symbol,
                    securityId,
                    prevHigh,
                    prevLow
                  });
                }
              }
            } catch (err: any) {
              console.warn(`[BOT] Could not fetch history for ${symbol}: ${err.message}`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[BOT] Failed to fetch watchlist:`, err.message);
  }
  return list;
}

// 2. Main Entry
async function main() {
  console.log("Starting Sentinel Auto-Trader (Candle Engine Mode)...");
  
  if (DRY_RUN) console.log("⚠️ RUNNING IN DRY-RUN MODE ⚠️");

  await initializeScripMaster();

  const broker = new DhanBroker();
  await broker.validateOrRenewToken();

  const executionEngine = new ExecutionEngine(broker);
  const candleEngine = new CandleEngine();

  // Handle Local Candle Closure -> Evaluate Entry
  candleEngine.on("onCandleClosed", async (securityId: string, candle: Candle, history: Candle[]) => {
    await executionEngine.evaluateClosedCandle(securityId, candle);
  });

  // Reconnection and Startup Logic
  const initEngine = async () => {
    candleEngine.isContinuityValid = false;
    console.log(`[BOT] Fetching Watchlist & Historical Context...`);
    const watchlist = await getDailyWatchlist();
    executionEngine.setWatchlist(watchlist);

    // Backfill session candles
    for (const item of watchlist) {
      try {
        const histRes = await axios.get(`${API_BASE_URL}/api/stocks/${item.symbol}/candles`);
        if (histRes.data && histRes.data.sessionCandles) {
          candleEngine.backfill(item.securityId, histRes.data.sessionCandles);
        }
      } catch (err) {
        // ignore
      }
    }

    candleEngine.isContinuityValid = true;
    console.log(`[BOT] CandleEngine Continuity Validated. Ready for live trading.`);
    
    broker.subscribeToSecurityIds(watchlist.map(w => w.securityId));
  };

  // Setup Live Ticks
  broker.onTick(async (securityId: string, ltp: number) => {
    // We assume 0 volume if we can't extract it reliably, but engine still works
    candleEngine.processTick(securityId, ltp, 0, Date.now());
    
    // Evaluate Live Tick for Exits (Breakeven rule)
    await executionEngine.evaluateLiveTick(securityId, ltp);
  });

  // Keep process alive and monitor connectivity
  await broker.connectWebSocket();
  await initEngine();

  while (!isShuttingDown) {
    await sleep(60000);
    // Ping/Pong or health checks can go here
  }
}

main().catch(console.error);
