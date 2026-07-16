import { ActiveTrade, TradeDB, TradeState } from "./db";
import { Candle } from "./candle-engine";
import { DhanBroker, PlaceSuperOrderInput } from "./dhan";
import { randomUUID } from "crypto";
import { getISTDateStr, resolveTradePosition } from "./utils";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.005;
const STRUCTURAL_TRAIL_RR = 1.5;
const STRUCTURAL_TRAIL_RISK_BUFFER = 0.15;
const NSE_TICK_SIZE = 0.05;

export interface WatchlistContext {
  symbol: string;
  securityId: string;
  prevHigh: number;
  prevLow: number;
}

export class ExecutionEngine {
  private broker: DhanBroker;
  private watchlist: Map<string, WatchlistContext> = new Map();

  constructor(broker: DhanBroker) {
    this.broker = broker;
  }

  public setWatchlist(list: WatchlistContext[]) {
    this.watchlist.clear();
    for (const item of list) {
      this.watchlist.set(item.securityId, item);
    }
    console.log(`[ENGINE] Watchlist set with ${list.length} symbols.`);
  }

  private async getActiveOrPendingTrade(securityId: string) {
    return (await TradeDB.getOpenTrades()).find(
      t => t.securityId === securityId
    );
  }

  private evaluationQueue: Promise<void> = Promise.resolve();

  public async evaluateClosedCandle(securityId: string, candle: Candle, history: Candle[]) {
    const evaluateTask = async () => {
      try {
        const ctx = this.watchlist.get(securityId);
        if (!ctx) return; 

        if (await this.getActiveOrPendingTrade(securityId)) {
            return;
        }

        const MAX_DAILY_TRADES = process.env.LIVE_CANARY === "true" ? 1 : 5;
        const tradesToday = (await TradeDB.getTradesForDate(getISTDateStr())).filter(trade =>
          trade.state !== "REJECTED"
        ).length;

        if (tradesToday >= MAX_DAILY_TRADES) {
            return;
        }

        const prevHigh = ctx.prevHigh;
        const prevLow = ctx.prevLow;
        const c = candle;
        if (history.length < 3) return;
        const prevC = history[history.length - 2];
        const prevPrevC = history[history.length - 3];

        // Prevent cross-session signals (and implicitly skip 9:15-9:20 volatility)
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
          return;
        }

        const getISTMinuteOfDay = (epochSecs: number) => {
          const d = new Date(epochSecs * 1000);
          d.setUTCHours(d.getUTCHours() + 5);
          d.setUTCMinutes(d.getUTCMinutes() + 30);
          return d.getUTCHours() * 60 + d.getUTCMinutes();
        };

        const mins = getISTMinuteOfDay(c.t + 300);
        if (mins < 10 * 60 + 15 || mins > 14 * 60 + 30) {
            return;
        }

        let setup = "";
        let direction: "BUY" | "SELL" | null = null;
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
                setup = "HIGH BREAKOUT"; direction = "BUY";
                sl = Math.min(c.l, prevHigh * (1 - SL_BUFFER_PCT));
            }
        } else if (freshLowBreakdown) {
            if (touchedLowZone && chaseAllowedLow) {
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

        if (direction === "BUY") {
            direction = null;
            // console.log(`[ENGINE] SKIPPED ${setup} for ${ctx.symbol} (Longs disabled for Intraday Loser filter)`);
        }

        if (direction) entryPrice = c.c;

        if (direction) {
          console.log(`[ENGINE] SETUP DETECTED! ${setup} for ${ctx.symbol} at ${entryPrice}`);
          await this.initiateTrade(ctx, direction, entryPrice, sl);
        }
      } catch (err: any) {
        console.error(`[ENGINE] evaluateClosedCandle error for ${securityId}:`, err);
      }
    };

    this.evaluationQueue = this.evaluationQueue.then(evaluateTask);
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
      } catch (err: any) {
        console.error(`[ENGINE] Failed to POST Super Order for ${ctx.symbol}:`, err.message);
        await TradeDB.updateState(newTrade.id, "ENTRY_RECONCILIATION_REQUIRED");
        return;
      }

      // Verify execution and protection via order book polling
      if (process.env.DRY_RUN === "true") {
          await TradeDB.updateState(newTrade.id, "PROTECTION_CONFIRMED", { protectionConfirmed: true });
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
          await new Promise(r => setTimeout(r, 2000)); // Poll every 2s

          try {
              const orders = await this.broker.getSuperOrderList();
              
              const parent = orders.find(
                order => order.orderId === superOrderId || order.correlationId === tradeId
              );

              if (parent && (parent.orderStatus === "REJECTED" || parent.orderStatus === "CANCELLED")) {
                  await TradeDB.updateState(tradeId, "REJECTED");
                  return;
              }

              const stopLeg = parent?.legDetails?.find(
                leg => leg.legName === "STOP_LOSS_LEG"
              );

              const entryLeg = parent?.legDetails?.find(
                leg => leg.legName === "ENTRY_LEG"
              );

              const targetLeg = parent?.legDetails?.find(
                leg => leg.legName === "TARGET_LEG"
              );

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
                      break;
                  }

                  await TradeDB.updateState(tradeId, "PROTECTION_CONFIRMED", { 
                      protectionConfirmed: true, 
                      entryPrice: actualFillPrice, 
                      quantity: actualFilledQty,
                      productType: (parent.productType?.toUpperCase() as any) || trade.productType || "INTRADAY"
                  });
                  confirmed = true;
                  console.log(`[ENGINE] Protection verified for ${tradeId} at fill ${actualFillPrice} qty ${actualFilledQty}`);
              }
          } catch (err) {
              console.warn(`[ENGINE] Order book polling failed for ${tradeId}`);
          }
      }

      if (!confirmed) {
          console.warn(`[ENGINE] Failed to verify protection for ${tradeId} after 20s.`);
          await TradeDB.updateState(tradeId, "ENTRY_RECONCILIATION_REQUIRED");
      }
  }

  public async evaluateLiveTick(securityId: string, ltp: number) {
    this.evaluationQueue = this.evaluationQueue.then(() => this._evaluateLiveTick(securityId, ltp)).catch(e => console.error(e));
  }

  private async _evaluateLiveTick(securityId: string, ltp: number) {
    const trade = await this.getActiveOrPendingTrade(securityId);
    if (!trade || trade.state !== "PROTECTION_CONFIRMED") return;

    // Evaluate Structural Trail Rule
    const risk = Math.abs(trade.entryPrice - trade.stopLossPrice);
    let reachedTrailRR = false;
    let trailSLPrice = trade.entryPrice;

    if (trade.side === "BUY" && ltp >= trade.entryPrice + (risk * STRUCTURAL_TRAIL_RR)) {
      reachedTrailRR = true;
      trailSLPrice = this.roundToTick(trade.entryPrice - (risk * STRUCTURAL_TRAIL_RISK_BUFFER)); // Trail below entry to structural floor
    } else if (trade.side === "SELL" && ltp <= trade.entryPrice - (risk * STRUCTURAL_TRAIL_RR)) {
      reachedTrailRR = true;
      trailSLPrice = this.roundToTick(trade.entryPrice + (risk * STRUCTURAL_TRAIL_RISK_BUFFER));
    }

    if (reachedTrailRR && !trade.trailApplied) {
      console.log(`[ENGINE] Trade ${trade.symbol} reached 1.5R! Trailing Super Order SL to ${trailSLPrice}.`);
      await TradeDB.updateState(trade.id, "TRAIL_REQUESTED");
      
      try {
        await this.broker.moveSuperOrderStopToBreakeven(
          trade.superOrderId,
          trailSLPrice,
          trade.trailingJump
        );
        await TradeDB.updateState(trade.id, "TRAIL_CONFIRMED", { trailApplied: true });
      } catch (err) {
        console.error(`[ENGINE] Failed to move SL to breakeven for ${trade.symbol}`, err);
        await TradeDB.updateState(trade.id, "PROTECTION_CONFIRMED");
      }
    }
  }

  public reconcileExits(): Promise<void> {
    this.evaluationQueue = this.evaluationQueue.then(() => this._reconcileExits()).catch(e => console.error(e)) as Promise<void>;
    return this.evaluationQueue;
  }

  private async _reconcileExits() {
      // Background task to mark EXITED if target/SL hit externally
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
                  
                  if (!Number.isFinite(exitPrice) || Number(exitPrice) <= 0) {
                      console.warn(`[ENGINE] Incomplete exit executions for ${trade.symbol}: ${totalQty}/${trade.quantity}`);
                      continue;
                  }

                  await TradeDB.markTradeClosed(trade.id, "BROKER EXIT", exitPrice);
              } else if (
                pos && (
                  (trade.side === "BUY" && netQty < 0) ||
                  (trade.side === "SELL" && netQty > 0)
                )
              ) {
                  console.error(
                    `[EMERGENCY] Position reversed for ${trade.symbol}: ${netQty}`
                  );
                
                  await TradeDB.updateState(
                    trade.id,
                    "REVERSAL_RECONCILIATION_REQUIRED"
                  );
              }
          }
      } catch (e: any) {
          console.error("[ENGINE] Critical error in reconcileExits:", e.message || e);
      }
  }

  public reconcileUnknownOrders(): Promise<void> {
    this.evaluationQueue = this.evaluationQueue.then(() => this._reconcileUnknownOrders()).catch(e => console.error(e)) as Promise<void>;
    return this.evaluationQueue;
  }

  private async _reconcileUnknownOrders(): Promise<void> {
    const unknownTrades = (await TradeDB.getOpenTrades()).filter(trade =>
      ["ENTRY_SUBMITTING", "ENTRY_RECONCILIATION_REQUIRED", "TRAIL_REQUESTED"].includes(trade.state)
    );

    if (unknownTrades.length === 0) return;

    try {
      const brokerOrders = await this.broker.getSuperOrderList();

      for (const trade of unknownTrades) {
        if (trade.state === "TRAIL_REQUESTED") {
            const parent = brokerOrders.find(order => order.orderId === trade.superOrderId || order.correlationId === trade.correlationId);
            if (parent) {
                const slLeg = parent.legDetails?.find(leg => leg.legName === "STOP_LOSS_LEG");
                const priceMatch = slLeg && Math.abs(Number(slLeg.price) - Number(trade.entryPrice)) < 0.001;
                const statusMatch = slLeg && slLeg.orderStatus === "PENDING";
                
                if (priceMatch && statusMatch) {
                    await TradeDB.updateState(trade.id, "TRAIL_CONFIRMED", { trailApplied: true });
                    console.log(`[ENGINE] Recovered breakeven state for ${trade.symbol}`);
                } else if (!statusMatch) {
                    console.warn(`[ENGINE] Breakeven not applied for ${trade.symbol} (SL status: ${slLeg?.orderStatus}). Escalating to ENTRY_RECONCILIATION_REQUIRED`);
                    await TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
                } else {
                    console.warn(`[ENGINE] Breakeven price mismatch for ${trade.symbol}. Leaving in TRAIL_REQUESTED.`);
                }
            } else {
                console.warn(`[ENGINE] Parent missing for breakeven recovery of ${trade.symbol}. Escalating to ENTRY_RECONCILIATION_REQUIRED`);
                await TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
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
            console.error(`[ENGINE] Abandoning verification for ${trade.id} after ${verifyAttempts} attempts. Moving to REJECTED.`);
            await TradeDB.updateState(trade.id, "REJECTED");
            continue;
        }

        await this.verifyOrderExecution(trade.id, parent.orderId);
      }
    } catch (e) {
      console.error("[ENGINE] Failed to run reconcileUnknownOrders", e);
    }
  }

  public reconcileExitOrders(): Promise<void> {
    this.evaluationQueue = this.evaluationQueue.then(() => this._reconcileExitOrders()).catch(e => console.error(e)) as Promise<void>;
    return this.evaluationQueue;
  }

  private async _reconcileExitOrders(): Promise<void> {
    const exitTrades = (await TradeDB.getOpenTrades()).filter(trade => 
      trade.state === "EXIT_RECONCILIATION_REQUIRED" && trade.exitCorrelationId
    );

    if (exitTrades.length === 0) return;

    try {
      const orders = await this.broker.getOrderBook();

      for (const trade of exitTrades) {
        let exitOrder = orders.find(order => order.correlationId === trade.exitCorrelationId);

        if (!exitOrder && trade.exitCorrelationId) {
            exitOrder = await this.broker.getOrderByCorrelationId(trade.exitCorrelationId) || undefined;
        }

        if (!exitOrder) {
            const notFoundCount = (trade.exitNotFoundCount || 0) + 1;
            console.error(`[EMERGENCY] Exit ${trade.exitCorrelationId} missing from broker (count ${notFoundCount}). MANUAL OPERATOR RESOLUTION REQUIRED to avoid unflattened exposure.`);
            await TradeDB.updateState(trade.id, undefined, { exitNotFoundCount: notFoundCount });
            continue;
        }

        if (exitOrder.orderStatus === "TRADED") {
            const exitPrice = Number(exitOrder.averageTradedPrice);
            const filledQty = Number(exitOrder.filledQty);

            if (
                !Number.isFinite(exitPrice) ||
                exitPrice <= 0 ||
                !Number.isFinite(filledQty) ||
                filledQty !== Number(exitOrder.quantity)
            ) {
                continue;
            }

            const positions = await this.broker.getPositions();
            const position = resolveTradePosition(positions, trade);

            if (Number(position?.netQty ?? 0) !== 0) {
                continue;
            }

            await TradeDB.markTradeClosed(trade.id, "SQUARED OFF", exitPrice);
        } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(exitOrder.orderStatus)) {
            await TradeDB.updateState(trade.id, undefined, { exitCorrelationId: "", exitNotFoundCount: 0 });
        } else {
            console.log(`[ENGINE] Cancelling pending exit order for ${trade.symbol}`);
            await this.broker.cancelOrder(exitOrder.orderId);
            await this.broker.waitForOrderTerminal(exitOrder.orderId);
            
            if (!trade.exitCorrelationId) {
                continue;
            }
            const finalOrder = await this.broker.getOrderByCorrelationId(trade.exitCorrelationId);
            
            if (finalOrder?.orderStatus === "TRADED") {
                const finalExitPrice = Number(finalOrder.averageTradedPrice);
                const finalFilledQty = Number(finalOrder.filledQty);

                if (
                    !Number.isFinite(finalExitPrice) ||
                    finalExitPrice <= 0 ||
                    !Number.isFinite(finalFilledQty) ||
                    finalFilledQty !== Number(finalOrder.quantity)
                ) {
                    continue;
                }

                const positions = await this.broker.getPositions();
                const position = resolveTradePosition(positions, trade);

                if (Number(position?.netQty ?? 0) !== 0) {
                    continue;
                }

                await TradeDB.markTradeClosed(trade.id, "SQUARED OFF", finalExitPrice);
            } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(finalOrder?.orderStatus ?? "")) {
                await TradeDB.updateState(trade.id, undefined, { exitCorrelationId: "", exitNotFoundCount: 0 });
            }
        }
      }
    } catch (e) {
      console.error("[ENGINE] Failed to run reconcileExitOrders", e);
    }
  }
}
