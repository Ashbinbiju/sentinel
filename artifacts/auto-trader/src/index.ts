import { initializeScripMaster, getSecurityId } from "./scrip-master";
import { DhanBroker } from "./dhan";
import { TradeDB } from "./db";
import { CandleEngine, Candle } from "./candle-engine";
import { ExecutionEngine, WatchlistContext } from "./engine";
import { sleep, getISTDateStr, getISTMinutes, isMarketOpenIST } from "./utils";
import { randomUUID } from "crypto";
import axios from "axios";

const DRY_RUN = process.env.DRY_RUN === "true";
const LIVE_CANARY = process.env.LIVE_CANARY === "true";

if (DRY_RUN && LIVE_CANARY) {
  throw new Error("DRY_RUN and LIVE_CANARY cannot both be enabled");
}

const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

const MAX_DAILY_TRADES = LIVE_CANARY ? 1 : 5;
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

async function closeAllOpenTrades(broker: DhanBroker, specificTrades?: any[]) {
    const activeTrades = specificTrades || TradeDB.getOpenTrades();
    if (activeTrades.length === 0) return;

    tradeLoop:
    for (const trade of activeTrades) {
        try {
            if (trade.exitCorrelationId) {
                console.warn(`[BOT] Trade ${trade.symbol} has unresolved exitCorrelationId. Skipping new exit placement.`);
                continue tradeLoop;
            }

            // Cancel active Super Order legs
            if (["ENTRY_SUBMITTING", "ENTRY_RECONCILIATION_REQUIRED"].includes(trade.state) && !trade.superOrderId) {
                TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
                throw new Error(`Cannot square off unresolved order ${trade.correlationId}`);
            }

            if (trade.superOrderId && !trade.protectionCancelled) {
               const superOrders = await broker.getSuperOrderList();
               const parent = superOrders.find(o => o.orderId === trade.superOrderId);
               
               if (!parent) {
                 TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
                 throw new Error(`Super Order ${trade.superOrderId} unavailable for ${trade.symbol}`);
               }
               
               if (["CANCELLED", "CLOSED", "REJECTED"].includes(parent.orderStatus)) {
                 TradeDB.updateState(trade.id, trade.state, { protectionCancelled: true });
               } else {
                 await broker.cancelSuperOrder(trade.superOrderId, "ENTRY_LEG");
                 await broker.waitForSuperOrderCancellation(trade.superOrderId);
                 TradeDB.updateState(trade.id, trade.state, { protectionCancelled: true });
               }
            }
            
            let exitAttempts = 0;
            let positionFlat = false;
            
            while (exitAttempts < 3 && !positionFlat) {
              exitAttempts++;
              
              const refreshedPositions = await broker.getPositions();
              const refreshedPosition = refreshedPositions.find(p => p.securityId === trade.securityId && p.productType?.toUpperCase() === "INTRADAY");
              
              let netQty = 0;
              if (refreshedPosition && refreshedPosition.netQty) {
                  netQty = Number(refreshedPosition.netQty);
              }

              if (netQty === 0) {
                  TradeDB.markTradeClosed(trade.id, "SQUARED OFF");
                  positionFlat = true;
                  break;
              }

              const exitSide = netQty > 0 ? "SELL" : "BUY";
              const qtyToExit = Math.abs(netQty);
              const exitCorrelationId = `sx-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
              if (exitCorrelationId.length > 30) {
                throw new Error("Exit correlation ID exceeds Dhan limit");
              }
              
              TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED", { exitCorrelationId });
              
              console.log(`[BOT] Emitting MARKET EXIT for ${qtyToExit} of ${trade.symbol}`);
              const exitOrderId = await broker.placeMarketOrder(trade.securityId, qtyToExit, exitSide, "INTRADAY", exitCorrelationId);
              
              let retries = 0;
              let orderTerminal = false;
              
              while (retries < 15 && !orderTerminal) {
                retries++;
                await sleep(1000);
                const orders = await broker.getOrderBook();
                const exitOrder = orders.find(o => o.orderId === exitOrderId);
                
                const terminalStatuses = new Set(["TRADED", "CANCELLED", "REJECTED"]);
                
                if (exitOrder && terminalStatuses.has(exitOrder.orderStatus)) {
                  orderTerminal = true;
                } else if (retries === 15) {
                  if (!exitOrder) {
                    console.error(`[BOT] ExitReconciliationRequiredError: ${exitCorrelationId}`);
                    TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED", { exitSubmittedAt: Date.now() });
                    continue tradeLoop;
                  }
                  await broker.cancelOrder(exitOrder.orderId);
                  await broker.waitForOrderTerminal(exitOrder.orderId);
                  orderTerminal = true;
                }
              }
              
              const finalPositions = await broker.getPositions();
              const finalPosition = finalPositions.find(p => p.securityId === trade.securityId && p.productType?.toUpperCase() === "INTRADAY");
              
              positionFlat = Number(finalPosition?.netQty ?? 0) === 0;
              
              if (positionFlat) {
                  const completedExit = await broker.getOrderByCorrelationId(exitCorrelationId);

                  if (completedExit?.orderStatus !== "TRADED" || Number(completedExit.filledQty) !== qtyToExit) {
                    continue tradeLoop;
                  }

                  TradeDB.markTradeClosed(trade.id, "SQUARED OFF", Number(completedExit.averageTradedPrice));
              } else {
                console.warn(`[BOT] Exit attempt ${exitAttempts} did not flatten position. Retrying...`);
              }
            }
            
            if (!positionFlat) {
                console.error(`[BOT] CRITICAL: Failed to square off ${trade.symbol} after 3 attempts.`);
                TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED");
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

        if (Number(lastCandle.t) !== expectedLastClosed5m) {
          backfillSuccess = false;
          console.error(`[BOT] Stale backfill for ${item.symbol}. Last candle is ${lastCandle.t}, expected ${expectedLastClosed5m}`);
          continue;
        }

        const hasGap = candles.some(
          (candle, index) =>
            index > 0 &&
            Number(candle.t) - Number(candles[index - 1].t) !== 300
        );

        if (hasGap) {
          backfillSuccess = false;
          console.error(`[BOT] Missing internal gaps in backfill for ${item.symbol}. Continuity compromised.`);
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

      if (!isMarketOpenIST() && !DRY_RUN && TradeDB.getOpenTrades().length === 0) {
        await sleep(5 * 60 * 1000);
        continue;
      }

      // Reconcile unknown accepted orders
      await executionEngine.reconcileUnknownOrders();
      await executionEngine.reconcileExitOrders();

      let activeTrades = TradeDB.getOpenTrades();

      // Auto Square-Off at 3:14 PM
      const currentMins = getISTMinutes();
      if (currentMins >= 15 * 60 + 14) {
        if (activeTrades.length > 0) {
          console.log(`[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:14 PM).`);
          await closeAllOpenTrades(broker);
          activeTrades = TradeDB.getOpenTrades();
        }
        
        if (activeTrades.length > 0) {
          console.error(`[BOT] CRITICAL: Square-off failed for ${activeTrades.length} trades. Will retry in safety loop.`);
        }
      }

      // Reversal/Emergency Intraday Square-off
      const orphanedTrades = activeTrades.filter(t => t.state === "REVERSAL_RECONCILIATION_REQUIRED");
      if (orphanedTrades.length > 0) {
          console.warn(`[BOT] Found ${orphanedTrades.length} reversed trades needing emergency square-off.`);
          await closeAllOpenTrades(broker, orphanedTrades);
      }

      // Kill Switch Validation
      if (!DRY_RUN) {
        const todayTrades = TradeDB.getTradesForDate(getISTDateStr());
        let realizedPnl = 0;
        let closedLosingTrades = 0;
        
        for (const t of todayTrades) {
            if (t.state === "EXITED" && t.realizedPnl !== undefined) {
                realizedPnl += t.realizedPnl;
                if (t.realizedPnl < 0) closedLosingTrades++;
            }
        }
        if (realizedPnl <= MAX_DAILY_LOSS || closedLosingTrades >= MAX_CONSECUTIVE_LOSSES) {
           console.error(`[KILL SWITCH] Max loss reached! P&L: ${realizedPnl}, Losing Trades: ${closedLosingTrades}. Squaring off!`);
           await closeAllOpenTrades(broker);
           activeTrades = TradeDB.getOpenTrades();
           
           if (activeTrades.length > 0) {
               console.error(`[KILL SWITCH] Failed to square off. Retrying in safety loop...`);
               await sleep(10 * 1000);
               continue;
           }
           
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

    await sleep(10000);
  }
}

main().catch(console.error);
