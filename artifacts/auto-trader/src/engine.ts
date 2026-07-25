import axios from "axios";
import { ActiveTrade, TradeDB, TradeState } from "./db";
import { Candle } from "./candle-engine";
import { DhanBroker, PlaceSuperOrderInput } from "./dhan";
import { randomUUID } from "crypto";
import { getISTDateStr, resolveTradePosition } from "./utils";
import { Notifier } from "./notifier";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.01;
const STRUCTURAL_TRAIL_RR = 1.0;
const STRUCTURAL_TRAIL_RISK_BUFFER = 0.05;
const NSE_TICK_SIZE = 0.05;


export interface WatchlistContext {
  symbol: string;
  securityId: string;
  prevHigh: number;
  prevLow: number;
  category: "GAINER" | "LOSER";
}

export class ExecutionEngine {
  private broker: DhanBroker;
  private notifier: Notifier;
  private watchlist: Map<string, WatchlistContext> = new Map();

  constructor(broker: DhanBroker) {
    this.broker = broker;
    this.notifier = new Notifier();
  }

  public setWatchlist(list: WatchlistContext[]) {
    this.watchlist.clear();
    for (const item of list) {
      this.watchlist.set(item.securityId, item);
    }
    console.log(`[ENGINE] Watchlist set with ${list.length} symbols.`);
  }

  private candleQueue: Promise<void> = Promise.resolve();
  private tickQueue: Promise<void> = Promise.resolve();
  private maintenanceQueue: Promise<void> = Promise.resolve();

  private blockingTrades = new Map<string, ActiveTrade>();
  private protectedTrades = new Map<string, ActiveTrade>();

  public async syncActiveTrades() {
    const openTrades = await TradeDB.getOpenTrades();
    
    this.blockingTrades.clear();
    this.protectedTrades.clear();

    for (const trade of openTrades) {
      this.blockingTrades.set(trade.securityId, trade);
      
      if (trade.state === "PROTECTION_CONFIRMED" || trade.state === "TRAIL_CONFIRMED") {
        this.protectedTrades.set(trade.securityId, trade);
      }
    }
  }

  private getActiveOrPendingTrade(securityId: string): ActiveTrade | undefined {
    return this.blockingTrades.get(securityId);
  }

  public evaluateClosedCandle(securityId: string, candle: Candle, history: Candle[]): void {
    const processCandle = async () => {
      try {
        const ctx = this.watchlist.get(securityId);
        if (!ctx) return null; 

        let c = candle;
        const apiBaseUrl = process.env.API_URL || "http://localhost:3000";

        if (c.isPartial) {
          console.log(`[CANDLE] CLOSED secId=${securityId} time=${new Date(c.t * 1000).toISOString()} partial=true`);
          if (global.hasOwnProperty('partial5m')) (global as any).partial5m++;
          
          try {
            const histRes = await axios.get(`${apiBaseUrl}/api/stocks/${ctx.symbol}/candles`, { timeout: 5000 });
            const restCandles = histRes.data?.sessionCandles;
            const recovered = restCandles?.find((rc: any) => Number(rc.t) === Number(c.t));
            
            if (recovered) {
              c = recovered;
              if (global.hasOwnProperty('recoveredCandles')) (global as any).recoveredCandles++;

              const recoveredIndex = history.findIndex(item => Number(item.t) === Number(c.t));
              if (recoveredIndex >= 0) {
                history[recoveredIndex] = { ...recovered, isPartial: false };
              }
            } else {
              console.log(`[ENGINE] REJECTED ${ctx.symbol} slot=${new Date(c.t * 1000).toISOString().substring(11, 16)} reason=PARTIAL_RECOVERY_FAILED`);
              if (global.hasOwnProperty('failedRecoveries')) (global as any).failedRecoveries++;
              return null;
            }
          } catch (err) {
            console.log(`[ENGINE] REJECTED ${ctx.symbol} slot=${new Date(c.t * 1000).toISOString().substring(11, 16)} reason=PARTIAL_RECOVERY_FAILED`);
            if (global.hasOwnProperty('failedRecoveries')) (global as any).failedRecoveries++;
            return null;
          }
        } else {
          console.log(`[CANDLE] CLOSED secId=${securityId} time=${new Date(c.t * 1000).toISOString()} partial=false`);
        }

        const evaluateTask = async () => {
          try {
            const candleClosedAtMs = (Number(c.t) + 300) * 1000;
            const signalDelayMs = Date.now() - candleClosedAtMs;

            const prevHigh = ctx.prevHigh;
            const prevLow = ctx.prevLow;
            const slotIso = new Date(c.t * 1000).toISOString().substring(11, 16);
            const reject = (reason: string) => {
              console.log(`[ENGINE] REJECTED ${ctx.symbol} slot=${slotIso} reason=${reason}`);
            };

            if (c.isPartial === false && signalDelayMs > 30_000) {
               return reject("STALE_RECOVERED_CANDLE");
            }

            if (history.length < 3) {
                return reject("INSUFFICIENT_HISTORY");
            }
            
            const prevC = history[history.length - 2];
            const prevPrevC = history[history.length - 3];

            const getEpochDateStr = (epochSecs: number) => {
              const d = new Date(epochSecs * 1000);
              d.setUTCHours(d.getUTCHours() + 5);
              d.setUTCMinutes(d.getUTCMinutes() + 30);
              return d.toISOString().slice(0, 10);
            };

            if (
              getEpochDateStr(prevC.t) !== getEpochDateStr(c.t) || 
              getEpochDateStr(prevPrevC.t) !== getEpochDateStr(c.t)
            ) {
              return reject("NOT_FRESH_CROSS");
            }

            const getISTMinuteOfDay = (epochSecs: number) => {
              const d = new Date(epochSecs * 1000);
              d.setUTCHours(d.getUTCHours() + 5);
              d.setUTCMinutes(d.getUTCMinutes() + 30);
              return d.getUTCHours() * 60 + d.getUTCMinutes();
            };

            const mins = getISTMinuteOfDay(c.t + 300);
            if (mins < 9 * 60 + 30 || mins > 11 * 60 + 30) {
                return reject("OUTSIDE_TIME");
            }

            console.log(`[ENGINE] EVALUATING ${ctx.symbol} slot=${slotIso} O=${c.o} H=${c.h} L=${c.l} C=${c.c} PDH=${prevHigh} PDL=${prevLow}`);

            let setup = "";
            let direction: "BUY" | "SELL" | null = null;
            let sl = 0;
            let entryPrice = c.c;

            const candleRange = Math.max(c.h - c.l, 0.05);
            const upperWick = c.h - Math.max(c.o, c.c);
            const lowerWick = Math.min(c.o, c.c) - c.l;

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
                if (!chaseAllowedHigh) return reject("CHASE_BLOCK");
                if (c.c <= c.o) return reject("BEARISH_BREAKOUT_CANDLE");
                if (upperWick / candleRange > 0.35) return reject("LONG_UPPER_REJECTION_WICK");
                if (touchedHighZone) {
                    setup = "HIGH BREAKOUT"; direction = "BUY";
                    sl = Math.min(c.l, prevHigh * (1 - SL_BUFFER_PCT));
                }
            } else if (freshLowBreakdown) {
                if (!chaseAllowedLow) return reject("CHASE_BLOCK");
                if (c.c >= c.o) return reject("BULLISH_BREAKDOWN_CANDLE");
                if (lowerWick / candleRange > 0.35) return reject("LONG_LOWER_REJECTION_WICK");
                if (touchedLowZone) {
                    setup = "LOW BREAKDOWN"; direction = "SELL";
                    sl = Math.max(c.h, prevLow * (1 + SL_BUFFER_PCT));
                }
            } else if (validHighRejection) {
                setup = "HIGH REJECTION"; direction = "SELL";
                sl = Math.max(c.h, zoneTopH * (1 + SL_BUFFER_PCT));
            } else if (validLowSupport) {
                setup = "LOW SUPPORT"; direction = "BUY";
                sl = Math.min(c.l, zoneBotL * (1 - SL_BUFFER_PCT));
            }

            if (!direction) {
                return reject("NO_SETUP");
            }

            if (direction === "BUY" && ctx.category === "LOSER") {
                return reject("CATEGORY_BLOCK");
            } else if (direction === "SELL" && ctx.category === "GAINER") {
                return reject("CATEGORY_BLOCK");
            }

            entryPrice = c.c;

            const activeTrade = this.getActiveOrPendingTrade(securityId);
            if (activeTrade) {
                return reject("ACTIVE_OR_PENDING_TRADE");
            }

            const MAX_DAILY_TRADES = process.env.LIVE_CANARY === "true" ? 1 : 5;
            const tradesToday = (await TradeDB.getTradesForDate(getISTDateStr())).filter(trade =>
              trade.state !== "REJECTED"
            ).length;

            if (tradesToday >= MAX_DAILY_TRADES) {
                return reject("DAILY_LIMIT");
            }

            console.log(`[ENGINE] SETUP DETECTED! ${setup} for ${ctx.symbol} at ${entryPrice}`);
            await this.initiateTrade(ctx, direction, entryPrice, sl);
          } catch (err: any) {
            console.error(`[ENGINE] evaluateClosedCandle error for ${securityId}:`, err);
          }
        };
        return evaluateTask;
      } catch (err: any) {
        console.error(`[ENGINE] processCandle error for ${securityId}:`, err);
        return null;
      }
    };

    processCandle().then((evalTask) => {
      if (!evalTask) return;
      const queuedAt = Date.now();
      this.candleQueue = this.candleQueue.then(async () => {
        const lag = Date.now() - queuedAt;
        if (lag > (global as any).maxCandleQueueLagMs || 0) (global as any).maxCandleQueueLagMs = lag;
        await evalTask();
      }).catch(e => console.error("[ENGINE] Candle queue error:", e));
    });
  }

  private roundToTick(val: number): number {
    return Math.round(val / NSE_TICK_SIZE) * NSE_TICK_SIZE;
  }

  private async initiateTrade(ctx: WatchlistContext, side: "BUY"|"SELL", entryPrice: number, sl: number) {
    try {
      const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
      const target = side === "BUY" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
      
      let cycleBalance: number;
      if (process.env.DRY_RUN === "true") {
        cycleBalance = parseFloat(process.env.DRY_RUN_CAPITAL || "50000");
      } else {
        cycleBalance = await this.broker.getAccountBalance();
      }

      const riskPerTrade = cycleBalance * 0.01; 
      let qty = Math.floor(riskPerTrade / risk);
      if (qty < 1) qty = 1;
      
      const maxLeveragedQty = Math.floor((cycleBalance * 5) / entryPrice);
      if (maxLeveragedQty < 1) {
          console.warn(`[ENGINE] Insufficient balance for one-share canary for ${ctx.symbol}. Required: ${entryPrice}. Available: ${cycleBalance}`);
          return;
      }
      
      qty = process.env.LIVE_CANARY === "true" ? 1 : Math.min(qty, maxLeveragedQty);

      if (qty <= 0) {
          console.warn(`[ENGINE] Insufficient balance for ${ctx.symbol}. Required: ${entryPrice}. Available: ${cycleBalance}`);
          return;
      }

      const trailingJump = this.roundToTick(risk * 0.5);
      const correlationId = `sentinel-${Date.now()}-${randomUUID().slice(0,5)}`;

      const newTrade: ActiveTrade = {
        id: correlationId,
        correlationId,
        superOrderId: "",
        symbol: ctx.symbol,
        securityId: ctx.securityId,
        quantity: qty,
        side,
        entryPrice: this.roundToTick(entryPrice),
        stopLossPrice: this.roundToTick(sl),
        targetPrice: this.roundToTick(target),
        trailingJump,
        state: "SIGNAL_CREATED",
        protectionConfirmed: false,
        trailApplied: false,
        productType: "INTRADAY",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Mandatory sequence
      await TradeDB.saveTrade(newTrade);
      await TradeDB.updateState(newTrade.id, "ENTRY_SUBMITTING");

      const orderInput: PlaceSuperOrderInput = {
        securityId: newTrade.securityId,
        side: newTrade.side,
        quantity: newTrade.quantity,
        entryPrice: newTrade.entryPrice,
        targetPrice: newTrade.targetPrice,
        stopLossPrice: newTrade.stopLossPrice,
        trailingJump: newTrade.trailingJump,
        correlationId: newTrade.correlationId
      };

      let superOrderId: string;
      try {
        superOrderId = await this.broker.placeSuperOrder(orderInput);
        await TradeDB.updateState(newTrade.id, "ENTRY_PENDING", { superOrderId });
        await this.syncActiveTrades();
      } catch (err: any) {
        console.error(`[ENGINE] Failed to POST Super Order for ${ctx.symbol}:`, err.message);
        await TradeDB.updateState(newTrade.id, "ENTRY_RECONCILIATION_REQUIRED");
        await this.syncActiveTrades();
        return;
      }

      if (process.env.DRY_RUN === "true") {
          await TradeDB.updateState(newTrade.id, "PROTECTION_CONFIRMED", { protectionConfirmed: true });
          await this.syncActiveTrades();
          return;
      }

      await this.verifyOrderExecution(newTrade.id, superOrderId);

    } catch (err: any) {
        console.error(`[ENGINE] Critical error initiating trade for ${ctx.symbol}:`, err.message);
    }
  }

  private async verifyOrderExecution(tradeId: string, superOrderId: string) {
      let retries = 0;
      let confirmed = false;

      while (retries < 10 && !confirmed) {
          retries++;
          await new Promise(r => setTimeout(r, 2000));

          try {
              const orders = await this.broker.getSuperOrderList();
              const parent = orders.find(
                order => order.orderId === superOrderId || order.correlationId === tradeId
              );

              if (parent && (parent.orderStatus === "REJECTED" || parent.orderStatus === "CANCELLED")) {
                  await TradeDB.updateState(tradeId, "REJECTED");
                  await this.syncActiveTrades();
                  return;
              }

              const stopLeg = parent?.legDetails?.find(leg => leg.legName === "STOP_LOSS_LEG");
              const entryLeg = parent?.legDetails?.find(leg => leg.legName === "ENTRY_LEG");
              const targetLeg = parent?.legDetails?.find(leg => leg.legName === "TARGET_LEG");

              const isLegPending = stopLeg?.orderStatus === "PENDING";
              const isLegTraded = stopLeg?.orderStatus === "TRADED" || targetLeg?.orderStatus === "TRADED";

              const protectedPosition =
                parent?.orderStatus === "TRADED" &&
                (isLegPending || isLegTraded) &&
                Number(stopLeg?.price ?? 0) > 0;

              if (protectedPosition) {
                  const trade = (await TradeDB.getOpenTrades()).find(t => t.id === tradeId);
                  if (!trade) break;
                  
                  const actualFillPrice = Number(parent.averageTradedPrice);
                  const actualFilledQty = Number(parent.filledQty);

                  if (!Number.isFinite(actualFillPrice) || actualFillPrice <= 0 || actualFilledQty !== trade.quantity) {
                      await TradeDB.updateState(tradeId, "ENTRY_RECONCILIATION_REQUIRED");
                      await this.syncActiveTrades();
                      break;
                  }

                  await TradeDB.updateState(tradeId, "PROTECTION_CONFIRMED", { 
                      protectionConfirmed: true, 
                      entryPrice: actualFillPrice, 
                      quantity: actualFilledQty,
                      productType: (parent.productType?.toUpperCase() as any) || trade.productType || "INTRADAY"
                  });
                  await this.syncActiveTrades();
                  confirmed = true;
                  console.log(`[ENGINE] Protection verified for ${tradeId} at fill ${actualFillPrice} qty ${actualFilledQty}`);
                  this.notifier.sendTradeEntry(trade.symbol, trade.side, actualFillPrice, trade.targetPrice, trade.stopLossPrice).catch(e => console.error(e));
              }
          } catch (err) {
              console.warn(`[ENGINE] Order book polling failed for ${tradeId}`);
          }
      }

      if (!confirmed) {
          console.warn(`[ENGINE] Failed to verify protection for ${tradeId} after 20s.`);
          await TradeDB.updateState(tradeId, "ENTRY_RECONCILIATION_REQUIRED");
          await this.syncActiveTrades();
      }
  }

  public evaluateLiveTick(securityId: string, ltp: number): void {
    const queuedTrade = this.protectedTrades.get(securityId);
    if (!queuedTrade) return;

    const queuedAt = Date.now();
    this.tickQueue = this.tickQueue
      .then(async () => {
        const lag = Date.now() - queuedAt;
        if (lag > (global as any).maxTickQueueLagMs || 0) (global as any).maxTickQueueLagMs = lag;

        const currentTrade = this.protectedTrades.get(securityId);
        if (!currentTrade || currentTrade.id !== queuedTrade.id) return;
        
        await this._evaluateLiveTick(securityId, ltp, currentTrade);
      })
      .catch((error) => {
        console.error("[ENGINE] Tick queue error:", error);
      });
  }

  private async _evaluateLiveTick(securityId: string, ltp: number, trade: ActiveTrade) {
    if (trade.state !== "PROTECTION_CONFIRMED" && trade.state !== "TRAIL_CONFIRMED") return;

    const risk = Math.abs(trade.entryPrice - trade.stopLossPrice);
    
    if (trade.state === "PROTECTION_CONFIRMED" && !trade.trailApplied) {
      let reachedTrailRR = false;
      let trailSLPrice = trade.entryPrice;

      if (trade.side === "BUY" && ltp >= trade.entryPrice + (risk * STRUCTURAL_TRAIL_RR)) {
        reachedTrailRR = true;
        trailSLPrice = this.roundToTick(trade.entryPrice - (risk * STRUCTURAL_TRAIL_RISK_BUFFER));
      } else if (trade.side === "SELL" && ltp <= trade.entryPrice - (risk * STRUCTURAL_TRAIL_RR)) {
        reachedTrailRR = true;
        trailSLPrice = this.roundToTick(trade.entryPrice + (risk * STRUCTURAL_TRAIL_RISK_BUFFER));
      }

      if (reachedTrailRR) {
        console.log(`[ENGINE] Trade ${trade.symbol} reached ${STRUCTURAL_TRAIL_RR}R! Trailing Super Order SL to ${trailSLPrice}.`);
        await TradeDB.updateState(trade.id, "TRAIL_REQUESTED", { requestedTrailStopPrice: trailSLPrice });

        await this.syncActiveTrades();
        
        try {
          await this.broker.moveSuperOrderStopToBreakeven(trade.superOrderId, trailSLPrice, trade.trailingJump);
          await TradeDB.updateState(trade.id, "TRAIL_CONFIRMED", { trailApplied: true, stopLossPrice: trailSLPrice });
          await this.syncActiveTrades();
          this.notifier.sendTrailApplied(trade.symbol, trailSLPrice).catch(e => console.error(e));
        } catch (err: any) {
          console.error(`[ENGINE] Failed to trail Super Order for ${trade.symbol}:`, err.message);
          // Left as TRAIL_REQUESTED for broker reconciliation
        }
      }
    }
  }

  private async initiateExit(trade: ActiveTrade, exitPrice: number, reason: string) {
    try {
      const pnl = trade.side === "BUY" ? (exitPrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - exitPrice) / trade.entryPrice;
      await TradeDB.markTradeClosed(trade.id, reason, exitPrice);
      await this.syncActiveTrades();
      
      this.notifier.sendTradeExit(trade.symbol, trade.side, pnl, exitPrice).catch(e => console.error(e));
    } catch (err: any) {
      console.error(`[ENGINE] Critical error exiting trade ${trade.symbol}:`, err.message);
      await TradeDB.updateState(trade.id, "EXIT_RECONCILIATION_REQUIRED");
      await this.syncActiveTrades();
    }
  }

  public reconcileExits(): Promise<void> {
    this.maintenanceQueue = this.maintenanceQueue.then(async () => {
      const activeTrades = (await TradeDB.getOpenTrades()).filter(t => 
          t.state === "PROTECTION_CONFIRMED" || 
          t.state === "TRAIL_CONFIRMED" || 
          (t.state === "EXIT_RECONCILIATION_REQUIRED" && !t.exitCorrelationId)
      );
      if (activeTrades.length === 0) return;

      try {
          const positions = await this.broker.getPositions();
          const superOrders = await this.broker.getSuperOrderList();

          for (const trade of activeTrades) {
              const pos = resolveTradePosition(positions, trade);
              const netQty = Number(pos?.netQty || 0);

              const parent = superOrders.find(o => o.orderId === trade.superOrderId);
              const triggeredLeg = parent?.legDetails?.find(leg => 
                  (leg.legName === "TARGET_LEG" || leg.legName === "STOP_LOSS_LEG") &&
                  leg.orderStatus === "TRIGGERED" &&
                  Number(leg.triggeredQuantity) === trade.quantity
              );

              const positionAbsentOrFlat = !pos || netQty === 0;

              if (positionAbsentOrFlat && parent?.orderStatus === "CLOSED" && triggeredLeg) {
                  console.log(`[ENGINE] Broker reconciliation detected external exit for ${trade.symbol}.`);
                  const trades = await this.broker.getTradesByOrderId(triggeredLeg.orderId);
                  
                  let totalValue = 0;
                  let totalQty = 0;
                  for (const t of trades) {
                      if (t.transactionType !== trade.side) {
                          totalValue += Number(t.tradedPrice || 0) * Number(t.tradedQuantity || 0);
                          totalQty += Number(t.tradedQuantity || 0);
                      }
                  }
                  
                  const exitPrice = totalQty === trade.quantity ? totalValue / totalQty : undefined;
                  const filledQty = totalQty;

                  if (!Number.isFinite(exitPrice) || Number(exitPrice) <= 0 || !Number.isFinite(filledQty) || filledQty !== trade.quantity) continue;

                  if (Number(pos?.netQty ?? 0) !== 0) {
                      console.warn(`[ENGINE] Exit order traded but position not flat for ${trade.symbol}`);
                      continue;
                  }

                  await TradeDB.markTradeClosed(trade.id, "SQUARED OFF", exitPrice);
                  await this.syncActiveTrades();
                  const pnl = trade.side === "BUY" ? (Number(exitPrice) - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - Number(exitPrice)) / trade.entryPrice;
                  this.notifier.sendTradeExit(trade.symbol, trade.side, pnl, Number(exitPrice)).catch(e => console.error(e));
              } else if (pos && ((trade.side === "BUY" && netQty < 0) || (trade.side === "SELL" && netQty > 0))) {
                  console.error(`[EMERGENCY] Position reversed for ${trade.symbol}: ${netQty}`);
                  await TradeDB.updateState(trade.id, "REVERSAL_RECONCILIATION_REQUIRED");
                  await this.syncActiveTrades();
              }
          }
      } catch (e: any) {
          console.error("[ENGINE] Critical error in reconcileExits:", e.message || e);
      }
    }).catch(e => console.error("[ENGINE] Maintenance queue error:", e));
    return this.maintenanceQueue;
  }

  public reconcileUnknownOrders(): Promise<void> {
    this.maintenanceQueue = this.maintenanceQueue.then(async () => {
      try {
        const unknownTrades = (await TradeDB.getOpenTrades()).filter(trade =>
          ["ENTRY_SUBMITTING", "ENTRY_RECONCILIATION_REQUIRED", "TRAIL_REQUESTED"].includes(trade.state)
        );

        if (unknownTrades.length === 0) return;

        const brokerOrders = await this.broker.getSuperOrderList();

        for (const trade of unknownTrades) {
          if (trade.state === "TRAIL_REQUESTED") {
              const parent = brokerOrders.find(order => order.orderId === trade.superOrderId || order.correlationId === trade.correlationId);
              if (parent) {
                  const slLeg = parent.legDetails?.find(leg => leg.legName === "STOP_LOSS_LEG");
                  const targetPrice = trade.requestedTrailStopPrice || trade.entryPrice;
                  const priceMatch = slLeg && Math.abs(Number(slLeg.price) - Number(targetPrice)) < 0.001;
                  const statusMatch = slLeg && slLeg.orderStatus === "PENDING";
                  
                  if (priceMatch && statusMatch) {
                      await TradeDB.updateState(trade.id, "TRAIL_CONFIRMED", { trailApplied: true, stopLossPrice: targetPrice });
                      await this.syncActiveTrades();
                  } else if (!statusMatch) {
                      await TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
                      await this.syncActiveTrades();
                  }
              }
              continue;
          }

          const parent = brokerOrders.find(order => order.correlationId === trade.correlationId);
          if (!parent) continue;

          const verifyAttempts = (trade.verifyAttempts || 0) + 1;
          await TradeDB.updateState(trade.id, "ENTRY_PENDING", {
            superOrderId: parent.orderId,
            verifyAttempts,
            productType: (parent.productType?.toUpperCase() as any) || trade.productType || "INTRADAY",
          });

          if (verifyAttempts > 5) {
              await TradeDB.updateState(trade.id, "REJECTED");
              await this.syncActiveTrades();
              continue;
          }

          await this.verifyOrderExecution(trade.id, parent.orderId);
          await this.syncActiveTrades();
        }
      } catch (err) {
        console.error(`[ENGINE] Failed to reconcile unknown orders:`, err);
      }
    }).catch(e => console.error("[ENGINE] Maintenance queue error:", e));
    return this.maintenanceQueue;
  }

  public reconcileExitOrders(): Promise<void> {
    this.maintenanceQueue = this.maintenanceQueue.then(async () => {
      try {
        const exitTrades = (await TradeDB.getOpenTrades()).filter(
          trade => trade.state === "EXIT_RECONCILIATION_REQUIRED" && Boolean(trade.exitCorrelationId)
        );

        if (exitTrades.length === 0) return;

        const orders = await this.broker.getOrderBook();

        for (const trade of exitTrades) {
          let exitOrder = orders.find(order => order.correlationId === trade.exitCorrelationId);
          if (!exitOrder && trade.exitCorrelationId) {
              exitOrder = await this.broker.getOrderByCorrelationId(trade.exitCorrelationId) || undefined;
          }

          if (!exitOrder) {
              const notFoundCount = (trade.exitNotFoundCount || 0) + 1;
              await TradeDB.updateState(trade.id, undefined, { exitNotFoundCount: notFoundCount });
              continue;
          }

          if (exitOrder.orderStatus === "TRADED") {
              const exitPrice = Number(exitOrder.averageTradedPrice);
              const filledQty = Number(exitOrder.filledQty);

              if (!Number.isFinite(exitPrice) || exitPrice <= 0 || !Number.isFinite(filledQty) || filledQty !== trade.quantity) continue;

              const positions = await this.broker.getPositions();
              const position = positions.find(
                  (p: any) =>
                      p.tradingSymbol === trade.symbol &&
                      (p.productType?.toUpperCase() as any || "INTRADAY") === (trade.productType || "INTRADAY")
              );
              
              if (Number(position?.netQty ?? 0) !== 0) {
                  console.warn(`[ENGINE] Exit order traded but position not flat for ${trade.symbol}`);
                  continue;
              }

              await TradeDB.markTradeClosed(trade.id, "SQUARED OFF", exitPrice);
              await this.syncActiveTrades();
              const pnl = trade.side === "BUY" ? (exitPrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - exitPrice) / trade.entryPrice;
              this.notifier.sendTradeExit(trade.symbol, trade.side, pnl, exitPrice).catch(e => console.error(e));
          } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(exitOrder.orderStatus)) {
              await TradeDB.updateState(trade.id, undefined, { exitCorrelationId: "", exitNotFoundCount: 0 });
          } else {
              await this.broker.cancelOrder(exitOrder.orderId);
              await this.broker.waitForOrderTerminal(exitOrder.orderId);
              const finalOrder = await this.broker.getOrderByCorrelationId(trade.exitCorrelationId || "");
              
              if (finalOrder?.orderStatus === "TRADED") {
                  const finalExitPrice = Number(finalOrder.averageTradedPrice);
                  const filledQty = Number(finalOrder.filledQty);

                  if (!Number.isFinite(finalExitPrice) || finalExitPrice <= 0 || !Number.isFinite(filledQty) || filledQty !== trade.quantity) continue;

                  const positions = await this.broker.getPositions();
                  const position = positions.find(
                      (p: any) =>
                          p.tradingSymbol === trade.symbol &&
                          (p.productType?.toUpperCase() as any || "INTRADAY") === (trade.productType || "INTRADAY")
                  );
                  
                  if (Number(position?.netQty ?? 0) !== 0) {
                      console.warn(`[ENGINE] Final exit order traded but position not flat for ${trade.symbol}`);
                      continue;
                  }

                  await TradeDB.markTradeClosed(trade.id, "SQUARED OFF", finalExitPrice);
                  await this.syncActiveTrades();
                  const pnl = trade.side === "BUY" ? (finalExitPrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - finalExitPrice) / trade.entryPrice;
                  this.notifier.sendTradeExit(trade.symbol, trade.side, pnl, finalExitPrice).catch(e => console.error(e));
              } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(finalOrder?.orderStatus ?? "")) {
                  await TradeDB.updateState(trade.id, undefined, { exitCorrelationId: "", exitNotFoundCount: 0 });
              }
          }
        }
      } catch (err) {
        console.error(`[ENGINE] Failed to reconcile exit orders:`, err);
      }
    }).catch(e => console.error("[ENGINE] Maintenance queue error:", e));
    return this.maintenanceQueue;
  }
}
