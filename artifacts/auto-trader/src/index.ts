import { initializeScripMaster, getSecurityId } from "./scrip-master";
import { DhanBroker } from "./dhan";
import { TradeDB } from "./db";
import { CandleEngine, Candle } from "./candle-engine";
import { ExecutionEngine, WatchlistContext } from "./engine";
import axios from "axios";

const DRY_RUN = process.env.DRY_RUN === "true";
const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

const MAX_DAILY_TRADES = 5;
const MAX_DAILY_LOSS = -2500;
const MAX_CONSECUTIVE_LOSSES = 3;

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

function getISTDateStr(): string {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let year = "", month = "", day = "";
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
  }
  return `${year}-${month}-${day}`;
}

function getISTMinutes(): number {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric', minute: 'numeric' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return hour * 60 + minute;
}

function isMarketOpenIST(): boolean {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', weekday: 'short' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let weekday = '';
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
  }
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const mins = getISTMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

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
            try {
              const histRes = await axios.get(`${API_BASE_URL}/api/stocks/${symbol}/candles`);
              if (histRes.data && histRes.data.historicalCandles) {
                const histCandles = histRes.data.historicalCandles as Candle[];
                const todaySlot = getISTDateStr();
                const prevCandles = histCandles.filter(c => {
                  const d = new Date(c.t * 1000);
                  const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
                  return dtStr !== todaySlot;
                });
                
                if (prevCandles.length > 0) {
                  const dates = Array.from(new Set(prevCandles.map(c => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t*1000))))).sort();
                  const lastDate = dates[dates.length - 1];
                  const lastDayCandles = prevCandles.filter(c => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t*1000)) === lastDate);
                  
                  const prevHigh = Math.max(...lastDayCandles.map(c => c.h));
                  const prevLow = Math.min(...lastDayCandles.map(c => c.l));
                  
                  list.push({ symbol, securityId, prevHigh, prevLow });
                }
              }
            } catch (err: any) {
              // ignore
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

async function closeAllOpenTrades(broker: DhanBroker) {
    const activeTrades = TradeDB.getOpenTrades();
    if (activeTrades.length === 0) return;

    for (const trade of activeTrades) {
        try {
            const positions = await broker.getPositions();
            const pos = positions.find(p => p.securityId === trade.securityId);
            
            if (trade.superOrderId) {
               await broker.cancelSuperOrder(trade.superOrderId, "ENTRY_LEG");
               await broker.waitForSuperOrderCancellation(trade.superOrderId);
            }
            
            let netQty = 0;
            if (pos && pos.netQty) {
                netQty = Number(pos.netQty);
            }

            if (netQty !== 0) {
                const exitSide = netQty > 0 ? "SELL" : "BUY";
                const qtyToExit = Math.abs(netQty);
                console.log(`[BOT] Emitting MARKET EXIT for ${qtyToExit} of ${trade.symbol}`);
                const exitOrderId = await broker.placeMarketOrder(trade.securityId, qtyToExit, exitSide);
                
                // Poll order until TRADED
                let retries = 0;
                let exited = false;
                while (retries < 15 && !exited) {
                  retries++;
                  await sleep(1000);
                  const orders = await broker.getOrderBook();
                  const exitOrder = orders.find(o => o.orderId === exitOrderId);
                  if (exitOrder && (exitOrder.orderStatus === "TRADED" || exitOrder.tradedQty > 0)) {
                    exited = true;
                  }
                }
                
                // Refresh positions and confirm netQty === 0
                const updatedPositions = await broker.getPositions();
                const updatedPos = updatedPositions.find(p => p.securityId === trade.securityId);
                if (updatedPos && Number(updatedPos.netQty || 0) === 0) {
                  TradeDB.markTradeClosed(trade.id, "SQUARED OFF");
                } else {
                  console.warn(`[BOT] Failed to confirm exit for ${trade.symbol}. netQty is not zero.`);
                }
            } else {
                TradeDB.markTradeClosed(trade.id, "SQUARED OFF");
            }
        } catch (e) {
            console.error(`[BOT] Failed to close trade ${trade.id}`, e);
        }
    }
}

async function main() {
  console.log("Starting Sentinel Auto-Trader...");
  if (DRY_RUN) console.log("⚠️ RUNNING IN DRY-RUN MODE ⚠️");

  await initializeScripMaster();

  const broker = new DhanBroker();
  await broker.validateOrRenewToken();

  const executionEngine = new ExecutionEngine(broker);
  const candleEngine = new CandleEngine();

  let currentTradingDay = getISTDateStr();
  let watchlist: WatchlistContext[] = [];

  candleEngine.on("onCandleClosed", async (securityId: string, candle: Candle, history: Candle[]) => {
    await executionEngine.evaluateClosedCandle(securityId, candle);
  });

  const initAndRecover = async () => {
    candleEngine.prepareForReconnect();
    
    if (watchlist.length === 0) {
        console.log(`[BOT] Fetching Watchlist & Historical Context...`);
        watchlist = await getDailyWatchlist();
        executionEngine.setWatchlist(watchlist);
    }

    // Recover from gap
    let backfillSuccess = true;
    for (const item of watchlist) {
      try {
        const histRes = await axios.get(`${API_BASE_URL}/api/stocks/${item.symbol}/candles`);
        const candles = histRes.data?.sessionCandles;

        if (!Array.isArray(candles) || candles.length === 0) {
          backfillSuccess = false;
          console.error(`[BOT] Missing session candles for ${item.symbol}`);
          continue;
        }

        const lastCandle = candles[candles.length - 1];
        const epochSecs = Math.floor(Date.now() / 1000);
        const currentSlot5m = Math.floor(epochSecs / 300) * 300;
        const expectedLastClosed5m = currentSlot5m - 300;

        if (lastCandle.t < expectedLastClosed5m - 60) {
          backfillSuccess = false;
          console.error(`[BOT] Stale backfill for ${item.symbol}. Last candle is ${lastCandle.t}, expected ${expectedLastClosed5m}`);
          continue;
        }

        candleEngine.backfill(item.securityId, candles);
      } catch (err) {
        console.error(`[BOT] Failed REST backfill for ${item.symbol}. Continuity compromised.`);
        backfillSuccess = false;
      }
    }

    if (backfillSuccess) {
        candleEngine.isContinuityValid = true;
        console.log(`[BOT] CandleEngine Continuity Validated. Ready for live trading.`);
        broker.subscribeToSecurityIds(watchlist.map(w => w.securityId));
    } else {
        console.warn(`[BOT] Backfill failed. Skipping continuity validation. Retrying in 60s.`);
    }
  };

  broker.on("onReconnect", async () => {
      console.log(`[BOT] WebSocket reconnected. Initiating backfill...`);
      await initAndRecover();
  });

  broker.on("onDisconnect", () => {
      console.warn(`[BOT] WebSocket disconnected. Invalidating continuity and cleaning up partial buckets.`);
      candleEngine.prepareForReconnect();
  });

  broker.onTick(async (tick) => {
    candleEngine.processTick(tick);
    await executionEngine.evaluateLiveTick(tick.securityId, tick.ltp);
  });

  // Start internal timers
  candleEngine.start();
  await broker.connectWebSocket();

  // Polling / Safety Loop
  while (!isShuttingDown) {
    try {
      const todayStr = getISTDateStr();
      if (todayStr !== currentTradingDay) {
        currentTradingDay = todayStr;
        watchlist = [];
        await broker.validateOrRenewToken();
        await initAndRecover();
      }

      if (!isMarketOpenIST() && !DRY_RUN) {
        await sleep(5 * 60 * 1000);
        continue;
      }

      // Auto Square-Off at 3:14 PM
      const currentMins = getISTMinutes();
      if (currentMins >= 15 * 60 + 14 && currentMins <= 15 * 60 + 30) {
        const activeTrades = TradeDB.getOpenTrades();
        if (activeTrades.length > 0) {
          console.log(`[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:14 PM).`);
          await closeAllOpenTrades(broker);
        }
        await sleep(15 * 60 * 1000);
        continue;
      }

      // Kill Switch Validation
      if (!DRY_RUN) {
        const { realizedPnl, closedLosingTrades } = await broker.getRiskMetrics();
        if (realizedPnl <= MAX_DAILY_LOSS || closedLosingTrades >= MAX_CONSECUTIVE_LOSSES) {
           console.error(`[KILL SWITCH] Max loss reached! P&L: ${realizedPnl}, Losing Trades: ${closedLosingTrades}. Squaring off!`);
           await closeAllOpenTrades(broker);
           // Sleep until next day
           while (todayStr === getISTDateStr()) {
               await sleep(60 * 60 * 1000);
           }
           continue;
        }
      }

      // Reconcile Exits
      await executionEngine.reconcileExits();

      // Retry failed backfills if continuity is broken
      if (!candleEngine.isContinuityValid && isMarketOpenIST()) {
          await initAndRecover();
      }

    } catch (e: any) {
       console.error(`[BOT] Safety Loop Error:`, e.message);
    }

    await sleep(60000);
  }
}

main().catch(console.error);
