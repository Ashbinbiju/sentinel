import { initializeScripMaster, getSecurityId } from "./scrip-master";
import { DhanBroker } from "./dhan";
import { TradeDB } from "./db";
import { CandleEngine, Candle } from "./candle-engine";
import { ExecutionEngine, WatchlistContext } from "./engine";
import { sleep, getISTDateStr, getISTMinutes, isMarketOpenIST, resolveTradePosition } from "./utils";
import { isAlphaBasketStock } from "./alpha-basket";
import { randomUUID } from "crypto";
import axios from "axios";
import { Notifier } from "./notifier";

const DRY_RUN = process.env.DRY_RUN === "true";
const LIVE_CANARY = process.env.LIVE_CANARY === "true";
const FULL_LIVE = process.env.FULL_LIVE === "true";
const USE_ALPHA_BASKET_FILTER = process.env.USE_ALPHA_BASKET_FILTER !== "false";

if (!DRY_RUN && !LIVE_CANARY && !FULL_LIVE) {
  throw new Error("Live execution requires LIVE_CANARY=true or explicit FULL_LIVE=true");
}

if (DRY_RUN && LIVE_CANARY) {
  throw new Error("DRY_RUN and LIVE_CANARY cannot both be enabled");
}

const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

const MAX_DAILY_TRADES = LIVE_CANARY ? 1 : (process.env.MAX_DAILY_TRADES ? parseInt(process.env.MAX_DAILY_TRADES, 10) : 5);
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

async function getDailyWatchlist(existingWatchlist?: WatchlistContext[]): Promise<WatchlistContext[]> {
  const list: WatchlistContext[] = [];
  try {
    const url = "https://intradayscreener.com/api/trackStocks/cash";
    const res = await axios.get(url, { headers: { Accept: "application/json" } });

    if (res.data) {
      const gainers = Array.isArray(res.data.intradayGainers) ? res.data.intradayGainers.slice(0, 15).map((s: any) => ({ ...s, category: "GAINER" })) : [];
      const losers = Array.isArray(res.data.intradayLosers) ? res.data.intradayLosers.slice(0, 15).map((s: any) => ({ ...s, category: "LOSER" })) : [];
      const combined = [...gainers, ...losers];
      const uniqueStocks = Array.from(new Map(combined.map((s: any) => [s.symbol?.trim(), s])).values()) as any[];

      for (const s of uniqueStocks) {
        const symbol = s.symbol?.trim();
        const ltp = s.ltp;
        const changePct = s.priceChangePct;

        if (symbol && ltp > 100) {
          if (USE_ALPHA_BASKET_FILTER && !isAlphaBasketStock(symbol)) {
            continue;
          }
          const securityId = getSecurityId(symbol);
          if (securityId) {
            const cached = existingWatchlist?.find(w => w.symbol === symbol);
            if (cached) {
              list.push({
                ...cached,
                category: s.category,
                ltp,
                priceChangePct: changePct,
              });
              continue;
            }

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
                  const dates = Array.from(new Set(prevCandles.map(c => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000))))).sort();
                  const lastDate = dates[dates.length - 1];
                  const lastDayCandles = prevCandles.filter(c => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000)) === lastDate);

                  const prevHigh = Math.max(...lastDayCandles.map(c => c.h));
                  const prevLow = Math.min(...lastDayCandles.map(c => c.l));

                  // Last candle of the previous session — feeds the pivot filter.
                  const chronological = [...lastDayCandles].sort((a, b) => a.t - b.t);
                  const prevClose = chronological[chronological.length - 1].c;

                  if (!Number.isFinite(prevClose)) {
                    console.warn(`[BOT] No previous close for ${symbol}. Pivot filter will block its setups.`);
                  }

                  list.push({ symbol, securityId, prevHigh, prevLow, prevClose, category: s.category, ltp, priceChangePct: changePct });
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

  if (list.length > 0) {
    const todayStr = getISTDateStr();
    const timeStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().substring(11, 16);
    const snapshotPromises = list.map((item) =>
      TradeDB.recordWatchlistSnapshot({
        date: todayStr,
        time: timeStr,
        symbol: item.symbol,
        category: item.category,
        ltp: item.ltp,
        priceChangePct: item.priceChangePct,
        prevHigh: item.prevHigh,
        prevLow: item.prevLow,
      }).catch(() => {})
    );
    await Promise.all(snapshotPromises);
  }

  return list;
}


async function reconcileAfterSquareOff(executionEngine: ExecutionEngine): Promise<void> {
  await executionEngine.reconcileExitOrders();
  await executionEngine.reconcileExits();
}

async function closeAllOpenTrades(broker: DhanBroker, specificTrades?: any[]) {
  const activeTrades = specificTrades || (await TradeDB.getOpenTrades());
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
        await TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
        throw new Error(`Cannot square off unresolved order ${trade.correlationId}`);
      }

      if (trade.superOrderId && !trade.protectionCancelled) {
        const superOrders = await broker.getSuperOrderList();
        const parent = superOrders.find(o => o.orderId === trade.superOrderId);

        if (!parent) {
          await TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
          throw new Error(`Super Order ${trade.superOrderId} unavailable for ${trade.symbol}`);
        }

        if (["CANCELLED", "CLOSED", "REJECTED", "TRADED"].includes(parent.orderStatus)) {
          await TradeDB.updateState(trade.id, undefined, { protectionCancelled: true });
        } else {
          await broker.cancelSuperOrder(trade.superOrderId, "ENTRY_LEG");
          await broker.waitForSuperOrderCancellation(trade.superOrderId);
          await TradeDB.updateState(trade.id, undefined, { protectionCancelled: true });
        }
      }

      let exitAttempts = 0;
      let positionFlat = false;

      if (!trade.productType) {
        const initialPositions = await broker.getPositions();
        const initialPos = resolveTradePosition(initialPositions, trade);

        if (!initialPos) {
          console.log(`[BOT] No live position for legacy trade ${trade.symbol}. Sending to exit reconciliation.`);
          await TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED");
          continue tradeLoop;
        }

        const resolvedProductType = String(initialPos.productType || "").toUpperCase();

        if (resolvedProductType === "INTRADAY" || resolvedProductType === "BO") {
          trade.productType = resolvedProductType as any;
          await TradeDB.updateState(trade.id, undefined, { productType: resolvedProductType as any });
        } else {
          throw new Error(`Unable to resolve product type for exit on ${trade.symbol}`);
        }
      }

      while (exitAttempts < 3 && !positionFlat) {
        exitAttempts++;

        const refreshedPositions = await broker.getPositions();
        const refreshedPosition = resolveTradePosition(refreshedPositions, trade);

        let netQty = 0;
        if (refreshedPosition && refreshedPosition.netQty) {
          netQty = Number(refreshedPosition.netQty);
        }

        if (netQty === 0) {
          console.log(`[BOT] Position flat prior to exit submission for ${trade.symbol}. Force closing ghost trade.`);
          await TradeDB.markTradeClosed(trade.id, "ORPHANED_FLAT_POSITION", trade.entryPrice);
          continue tradeLoop;
        }

        const exitSide = netQty > 0 ? "SELL" : "BUY";
        const qtyToExit = Math.abs(netQty);
        const exitCorrelationId = `sx-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        if (exitCorrelationId.length > 30) {
          throw new Error("Exit correlation ID exceeds Dhan limit");
        }

        await TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED", { exitCorrelationId });

        console.log(`[BOT] Emitting MARKET EXIT for ${qtyToExit} of ${trade.symbol}`);
        const exitOrderId = await broker.placeMarketOrder(trade.securityId, qtyToExit, exitSide, trade.productType as any, exitCorrelationId);

        let retries = 0;
        let orderTerminal = false;

        while (retries < 15 && !orderTerminal) {
          retries++;
          await sleep(1000);
          const orders = await broker.getOrderBook();
          const exitOrder = orders.find(o => o.orderId === exitOrderId);

          const terminalStatuses = new Set(["TRADED", "CANCELLED", "REJECTED", "EXPIRED"]);

          if (exitOrder && terminalStatuses.has(exitOrder.orderStatus)) {
            orderTerminal = true;
          } else if (retries === 15) {
            if (!exitOrder) {
              console.error(`[BOT] ExitReconciliationRequiredError: ${exitCorrelationId}`);
              await TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED", { exitSubmittedAt: Date.now() });
              continue tradeLoop;
            }
            await broker.cancelOrder(exitOrder.orderId);
            await broker.waitForOrderTerminal(exitOrder.orderId);
            orderTerminal = true;
          }
        }

        const completedExit = await broker.getOrderByCorrelationId(exitCorrelationId);

        if (completedExit?.orderStatus === "TRADED") {
          continue tradeLoop;
        }

        if (
          !completedExit ||
          ["TRANSIT", "PENDING", "PART_TRADED"].includes(completedExit.orderStatus)
        ) {
          await TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED", { exitCorrelationId });
          continue tradeLoop;
        }

        if (["CANCELLED", "REJECTED", "EXPIRED"].includes(completedExit?.orderStatus ?? "")) {
          await TradeDB.updateState(trade.id, undefined, { exitCorrelationId: "" });
        }

        const finalPositions = await broker.getPositions();
        const finalPosition = resolveTradePosition(finalPositions, trade);

        positionFlat = Number(finalPosition?.netQty ?? 0) === 0;

        if (!positionFlat) {
          console.warn(`[BOT] Exit attempt ${exitAttempts} did not flatten position. Retrying...`);
        } else {
          console.log(`[BOT] Position flat after terminal non-traded status for ${trade.symbol}. Force closing ghost trade.`);
          await TradeDB.markTradeClosed(trade.id, "ORPHANED_FLAT_POSITION", trade.entryPrice);
          continue tradeLoop;
        }
      }

      if (!positionFlat) {
        console.error(`[BOT] CRITICAL: Failed to square off ${trade.symbol} after 3 attempts.`);
        await TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED");
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
    await executionEngine.evaluateClosedCandle(securityId, candle, history);
  });

  let recoveryPromise: Promise<void> | null = null;
  let initialRecoveryComplete = false;
  let lastWatchlistFetchMs = 0;

  const initAndRecover = (): Promise<void> => {
    if (recoveryPromise) {
      return recoveryPromise;
    }

    recoveryPromise = (async () => {
      candleEngine.prepareForReconnect();

    if (watchlist.length === 0) {
      console.log(`[BOT] Fetching Watchlist & Historical Context...`);
      watchlist = await getDailyWatchlist();
      executionEngine.setWatchlist(watchlist);
    }

    // Recover from gap
    const successfulSymbols: string[] = [];
    for (const item of watchlist) {
      try {
        const histRes = await axios.get(`${API_BASE_URL}/api/stocks/${item.symbol}/candles`);
        const candles = histRes.data?.sessionCandles;

        if (!Array.isArray(candles) || candles.length === 0) {
          console.error(`[BOT] Missing session candles for ${item.symbol}`);
          continue;
        }

        const lastCandle = candles[candles.length - 1];
        const epochSecs = Math.floor(Date.now() / 1000);
        const currentSlot5m = Math.floor(epochSecs / 300) * 300;
        const expectedLastClosed5m = currentSlot5m - 300;
        const currentMins = getISTMinutes();

        if (currentMins >= 9 * 60 + 20) {
          if (Number(lastCandle.t) !== expectedLastClosed5m) {
            console.warn(
              `[BOT] Stale backfill for ${item.symbol}. ` +
              `Last=${lastCandle.t}, expected=${expectedLastClosed5m}`
            );
          }
        }

        const hasGap = candles.some(
          (candle, index) =>
            index > 0 &&
            Number(candle.t) - Number(candles[index - 1].t) !== 300
        );

        if (hasGap) {
          console.error(`[BOT] Missing internal gaps in backfill for ${item.symbol}. Continuity compromised.`);
          continue;
        }

        candleEngine.backfill(item.securityId, candles);
        successfulSymbols.push(item.securityId);

        // Throttle requests to prevent Upstox/Cloudflare HTTP 429 Rate Limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        console.error(`[BOT] Failed REST backfill for ${item.symbol}. Continuity compromised.`);
      }
    }

    if (successfulSymbols.length > 0) {
      candleEngine.isContinuityValid = true;
      console.log(`[BOT] CandleEngine Continuity Validated for ${successfulSymbols.length} stocks. Ready for live trading.`);
      broker.subscribeToSecurityIds(successfulSymbols);

      initialRecoveryComplete = true;
      lastWatchlistFetchMs = Date.now();
    } else {
      console.warn(`[BOT] Backfill failed for all stocks. Skipping continuity validation. Retrying in 60s.`);
    }
  })().finally(() => {
    recoveryPromise = null;
  });

  return recoveryPromise;
};

  broker.on("onReconnect", async () => {
    console.log(`[BOT] WebSocket reconnected. Initiating backfill...`);
    await initAndRecover();
  });

  broker.on("onDisconnect", () => {
    console.warn(`[BOT] WebSocket disconnected. Invalidating continuity and cleaning up partial buckets.`);
    candleEngine.prepareForReconnect();
  });

  broker.onTick((tick) => {
    candleEngine.processTick(tick);
    executionEngine.evaluateLiveTick(tick.securityId, tick.ltp);
  });

  // Start internal timers
  candleEngine.start();
  await broker.connectWebSocket();

  // Initial trade sync
  await executionEngine.syncActiveTrades();

  // Polling / Safety Loop
  while (!isShuttingDown) {
    try {
      const todayStr = getISTDateStr();
      if (todayStr !== currentTradingDay) {
        currentTradingDay = todayStr;
        lastWatchlistFetchMs = 0;
        await broker.validateOrRenewToken();
        // Clear yesterday's continuity state completely
        candleEngine.prepareForReconnect();
      }

      const currentMins = getISTMinutes();
      const nowMs = Date.now();

      // Periodically refresh the watchlist every 3 minutes during market hours
      if (
        initialRecoveryComplete &&
        recoveryPromise === null &&
        currentMins >= 9 * 60 + 15 && 
        currentMins < 15 * 60 + 30 &&
        nowMs - lastWatchlistFetchMs >= 3 * 60 * 1000
      ) {
          console.log(`[BOT] Scheduled Watchlist Refresh (3-min interval).`);

          const newWatchlist = await getDailyWatchlist(watchlist);
          const currentSymbols = new Set(watchlist.map(w => w.symbol));
          const addedSymbols = newWatchlist.filter(w => !currentSymbols.has(w.symbol));

          const newSecurityIds = new Set(newWatchlist.map(item => item.securityId));
          const openTrades = await TradeDB.getOpenTrades();
          const protectedSecurityIds = new Set(openTrades.map(trade => trade.securityId));

          const removedSecurityIds = watchlist
            .filter(item =>
              !newSecurityIds.has(item.securityId) &&
              !protectedSecurityIds.has(item.securityId)
            )
            .map(item => item.securityId);

          if (removedSecurityIds.length > 0) {
            console.log(`[BOT] Unsubscribing from ${removedSecurityIds.length} removed symbols.`);
            broker.unsubscribeFromSecurityIds(removedSecurityIds);
            candleEngine.removeSymbols(removedSecurityIds);
          }

          watchlist = newWatchlist;
          executionEngine.setWatchlist(watchlist);

          if (addedSymbols.length > 0) {
            console.log(`[BOT] Found ${addedSymbols.length} new symbols entering watchlist. Smart backfilling...`);
            const successfulNewSymbols: string[] = [];

            for (const item of addedSymbols) {
              try {
                const histRes = await axios.get(`${API_BASE_URL}/api/stocks/${item.symbol}/candles`);
                const candles = histRes.data?.sessionCandles;

                if (!candles || candles.length === 0) {
                  console.warn(`[BOT] No candles returned for ${item.symbol}. Continuity compromised.`);
                  continue;
                }

                candleEngine.backfill(item.securityId, candles);
                successfulNewSymbols.push(item.securityId);
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (err) {
                console.error(`[BOT] Failed REST backfill for ${item.symbol}. Continuity compromised.`);
              }
            }

            if (successfulNewSymbols.length > 0) {
              console.log(`[BOT] Smart backfill complete. Subscribing to ${successfulNewSymbols.length} new symbols...`);
              broker.subscribeToSecurityIds(successfulNewSymbols);
            }
          }

          await executionEngine.syncActiveTrades();
          lastWatchlistFetchMs = Date.now();
      }

      if (!isMarketOpenIST() && !DRY_RUN && (await TradeDB.getOpenTrades()).length === 0) {
        await sleep(5 * 60 * 1000);
        continue;
      }

      await executionEngine.reconcileUnknownOrders();
      await executionEngine.reconcileExitOrders();
      await executionEngine.syncActiveTrades();

      let activeTrades = (await TradeDB.getOpenTrades());

      // Auto Square-Off at 3:14 PM
      if (currentMins >= 15 * 60 + 14) {
        if (activeTrades.length > 0) {
          console.log(`[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:14 PM).`);
          await closeAllOpenTrades(broker);
          await reconcileAfterSquareOff(executionEngine);
          activeTrades = (await TradeDB.getOpenTrades());
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
        await reconcileAfterSquareOff(executionEngine);
      }

      // Kill Switch Validation
      if (!DRY_RUN) {
        const todayTrades = (await TradeDB.getTradesForDate(getISTDateStr()));
        let realizedPnl = 0;

        for (const t of todayTrades) {
          if (t.state === "EXITED" && t.realizedPnl !== undefined) {
            realizedPnl += t.realizedPnl;
          }
        }

        const exitedToday = todayTrades
          .filter(t => t.state === "EXITED" && t.realizedPnl !== undefined)
          .sort((a, b) => new Date(a.closedAt || a.updatedAt).getTime() - new Date(b.closedAt || b.updatedAt).getTime());

        let closedLosingTrades = 0;
        for (const t of exitedToday) {
          if (t.realizedPnl! < 0) {
            closedLosingTrades++;
          } else if (t.realizedPnl! > 0) {
            closedLosingTrades = 0;
          }
        }

        if (realizedPnl <= MAX_DAILY_LOSS || closedLosingTrades >= MAX_CONSECUTIVE_LOSSES) {
          console.error(`[KILL SWITCH] Max loss reached! P&L: ${realizedPnl}, Losing Trades: ${closedLosingTrades}. Squaring off!`);
          
          try {
            const notifier = new Notifier();
            await notifier.sendKillSwitch(realizedPnl, closedLosingTrades);
          } catch (e) {
            console.error("Failed to send kill switch notification", e);
          }
          
          await closeAllOpenTrades(broker);
          await reconcileAfterSquareOff(executionEngine);
          activeTrades = (await TradeDB.getOpenTrades());

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
