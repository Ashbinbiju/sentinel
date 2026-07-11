import { ActiveTrade, TradeDB, TradeState } from "./db";
import { Candle } from "./candle-engine";
import { DhanBroker, PlaceSuperOrderInput, DhanOrder } from "./dhan";
import { randomUUID } from "crypto";
import { getISTDateStr } from "./utils";

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;

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

  private getActiveOrPendingTrade(securityId: string) {
    return TradeDB.getOpenTrades().find(
      t => t.securityId === securityId
    );
  }

  private evaluationQueue: Promise<void> = Promise.resolve();

  public async evaluateClosedCandle(securityId: string, candle: Candle) {
    const evaluateTask = async () => {
      try {
        const ctx = this.watchlist.get(securityId);
        if (!ctx) return; 

        if (this.getActiveOrPendingTrade(securityId)) {
            return;
        }

        const MAX_DAILY_TRADES = process.env.LIVE_CANARY === "true" ? 1 : 5;
        const tradesToday = TradeDB.getTradesForDate(getISTDateStr()).filter(trade =>
          trade.state !== "REJECTED"
        ).length;

        if (tradesToday >= MAX_DAILY_TRADES) {
            return;
        }

        const prevHigh = ctx.prevHigh;
        const prevLow = ctx.prevLow;
        const c = candle;

        let setup = "";
        let direction: "BUY" | "SELL" | null = null;
        let sl = 0;
        let entryPrice = c.c;

        if (c.h >= prevHigh * (1 - TOUCH_BUFFER_PCT)) {
          if (c.c > prevHigh) {
            if (c.c <= prevHigh * (1 + MAX_CHASE_PCT)) {
              setup = "HIGH BREAKOUT"; direction = "BUY";
              sl = Math.min(c.l, prevHigh * 0.999);
            }
          } else if (c.c < c.o) {
            setup = "HIGH REJECTION"; direction = "SELL";
            sl = Math.max(c.h, prevHigh * 1.001);
          }
          if (direction) entryPrice = c.c;
        } else if (c.l <= prevLow * (1 + TOUCH_BUFFER_PCT)) {
          if (c.c < prevLow) {
            if (c.c >= prevLow * (1 - MAX_CHASE_PCT)) {
              setup = "LOW BREAKDOWN"; direction = "SELL";
              sl = Math.max(c.h, prevLow * 1.001);
            }
          } else if (c.c > c.o) {
            setup = "LOW SUPPORT"; direction = "BUY";
            sl = Math.min(c.l, prevLow * 0.999);
          }
          if (direction) entryPrice = c.c;
        }

        if (direction) {
          console.log(`[ENGINE] SETUP DETECTED! ${setup} for ${ctx.symbol} at ${entryPrice}`);
          await this.initiateTrade(ctx, direction, entryPrice, sl);
        }
      } catch (err: any) {
        console.error(`[ENGINE] evaluateClosedCandle error for ${securityId}:`, err);
      }
    };

    this.evaluationQueue = this.evaluationQueue.then(evaluateTask).catch(err => {
      console.error("[ENGINE] Queue Error:", err);
    });
  }

  private roundToTick(val: number): number {
    return Math.round(val * 20) / 20;
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
        breakevenApplied: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Mandatory sequence
      await TradeDB.saveTrade(newTrade);
      TradeDB.updateState(newTrade.id, "ENTRY_SUBMITTING");

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
        TradeDB.updateState(newTrade.id, "ENTRY_PENDING", { superOrderId });
      } catch (err: any) {
        console.error(`[ENGINE] Failed to POST Super Order for ${ctx.symbol}:`, err.message);
        TradeDB.updateState(newTrade.id, "ENTRY_RECONCILIATION_REQUIRED");
        return;
      }

      // Verify execution and protection via order book polling
      if (process.env.DRY_RUN === "true") {
          TradeDB.updateState(newTrade.id, "PROTECTION_CONFIRMED", { protectionConfirmed: true });
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
                  TradeDB.updateState(tradeId, "REJECTED");
                  return;
              }

              const stopLeg = parent?.legDetails?.find(
                leg => leg.legName === "STOP_LOSS_LEG"
              );

              const entryLeg = parent?.legDetails?.find(
                leg => leg.legName === "ENTRY_LEG"
              );

              const protectedPosition =
                parent?.orderStatus === "TRADED" &&
                stopLeg?.orderStatus === "PENDING" &&
                Number(stopLeg.price) > 0 &&
                Number(stopLeg.triggeredQuantity ?? 0) === 0;

              if (protectedPosition) {
                  const trade = TradeDB.getOpenTrades().find(t => t.id === tradeId);
                  if (!trade) break;
                  
                  const actualFillPrice = Number(parent.averageTradedPrice);
                  const actualFilledQty = Number(parent.filledQty);

                  if (!Number.isFinite(actualFillPrice) || actualFillPrice <= 0 || actualFilledQty !== trade.quantity) {
                      TradeDB.updateState(tradeId, "ENTRY_RECONCILIATION_REQUIRED");
                      break;
                  }

                  TradeDB.updateState(tradeId, "ENTRY_TRADED", { entryPrice: actualFillPrice, quantity: actualFilledQty });
                  TradeDB.updateState(tradeId, "PROTECTION_CONFIRMED", { protectionConfirmed: true, entryPrice: actualFillPrice, quantity: actualFilledQty });
                  confirmed = true;
                  console.log(`[ENGINE] Protection verified for ${tradeId} at fill ${actualFillPrice} qty ${actualFilledQty}`);
              }
          } catch (err) {
              console.warn(`[ENGINE] Order book polling failed for ${tradeId}`);
          }
      }

      if (!confirmed) {
          console.warn(`[ENGINE] Failed to verify protection for ${tradeId} after 20s.`);
          TradeDB.updateState(tradeId, "ENTRY_RECONCILIATION_REQUIRED");
      }
  }

  public async evaluateLiveTick(securityId: string, ltp: number) {
    const trade = this.getActiveOrPendingTrade(securityId);
    if (!trade || trade.state !== "PROTECTION_CONFIRMED") return;

    // Evaluate Breakeven Rule (1R)
    const risk = Math.abs(trade.entryPrice - trade.stopLossPrice);
    let reached1R = false;

    if (trade.side === "BUY" && ltp >= trade.entryPrice + risk) {
      reached1R = true;
    } else if (trade.side === "SELL" && ltp <= trade.entryPrice - risk) {
      reached1R = true;
    }

    if (reached1R && !trade.breakevenApplied) {
      console.log(`[ENGINE] Trade ${trade.symbol} reached 1R! Moving Super Order SL to Breakeven.`);
      TradeDB.updateState(trade.id, "BREAKEVEN_REQUESTED");
      
      try {
        await this.broker.moveSuperOrderStopToBreakeven(
          trade.superOrderId,
          trade.entryPrice,
          trade.trailingJump
        );
        TradeDB.updateState(trade.id, "BREAKEVEN_CONFIRMED", { breakevenApplied: true });
      } catch (err) {
        console.error(`[ENGINE] Failed to move SL to breakeven for ${trade.symbol}`, err);
        TradeDB.updateState(trade.id, "PROTECTION_CONFIRMED");
      }
    }
  }

  public async reconcileExits() {
      // Background task to mark EXITED if target/SL hit externally
      const activeTrades = TradeDB.getOpenTrades().filter(t => t.state === "PROTECTION_CONFIRMED" || t.state === "BREAKEVEN_CONFIRMED");
      if (activeTrades.length === 0) return;

      try {
          const positions = await this.broker.getPositions();
          const superOrders = await this.broker.getSuperOrderList();

          for (const trade of activeTrades) {
              const pos = positions.find(p => p.securityId === trade.securityId && p.productType?.toUpperCase() === "INTRADAY");
              const netQty = Number(pos?.netQty || 0);

              const parent = superOrders.find(o => o.orderId === trade.superOrderId);
              const targetOrSlTriggered = parent?.legDetails?.some(leg => 
                  (leg.legName === "TARGET_LEG" || leg.legName === "STOP_LOSS_LEG") &&
                  leg.orderStatus === "TRIGGERED" &&
                  Number(leg.triggeredQuantity) === trade.quantity
              );

              const positionAbsentOrFlat = !pos || netQty === 0;

              if (positionAbsentOrFlat && parent?.orderStatus === "CLOSED" && targetOrSlTriggered) {
                  console.log(`[ENGINE] Broker reconciliation detected external exit for ${trade.symbol}.`);
                  const trades = await this.broker.getTradesByOrderId(parent.orderId);
                  
                  let totalValue = 0;
                  let totalQty = 0;
                  for (const t of trades) {
                      if (t.transactionType !== trade.side) {
                          totalValue += Number(t.tradedPrice || 0) * Number(t.tradedQty || 0);
                          totalQty += Number(t.tradedQty || 0);
                      }
                  }
                  
                  const exitPrice = totalQty > 0 ? totalValue / totalQty : undefined;
                  TradeDB.markTradeClosed(trade.id, "BROKER EXIT", exitPrice);
              } else if (
                pos && (
                  (trade.side === "BUY" && netQty < 0) ||
                  (trade.side === "SELL" && netQty > 0)
                )
              ) {
                  console.error(
                    `[EMERGENCY] Position reversed for ${trade.symbol}: ${netQty}`
                  );
                
                  TradeDB.updateState(
                    trade.id,
                    "REVERSAL_RECONCILIATION_REQUIRED"
                  );
              }
          }
      } catch (e) {
          // Ignore
      }
  }

  public async reconcileUnknownOrders(): Promise<void> {
    const unknownTrades = TradeDB.getOpenTrades().filter(trade =>
      ["ENTRY_SUBMITTING", "ENTRY_RECONCILIATION_REQUIRED", "BREAKEVEN_REQUESTED"].includes(trade.state)
    );

    if (unknownTrades.length === 0) return;

    try {
      const brokerOrders = await this.broker.getSuperOrderList();

      for (const trade of unknownTrades) {
        if (trade.state === "BREAKEVEN_REQUESTED") {
            const parent = brokerOrders.find(order => order.orderId === trade.superOrderId || order.correlationId === trade.correlationId);
            if (parent) {
                const slLeg = parent.legDetails?.find(leg => leg.legName === "STOP_LOSS_LEG");
                const priceMatch = slLeg && Math.abs(Number(slLeg.price) - Number(trade.entryPrice)) < 0.001;
                const statusMatch = slLeg && slLeg.orderStatus === "PENDING";
                
                if (priceMatch && statusMatch) {
                    TradeDB.updateState(trade.id, "BREAKEVEN_CONFIRMED", { breakevenApplied: true });
                    console.log(`[ENGINE] Recovered breakeven state for ${trade.symbol}`);
                } else if (!statusMatch) {
                    console.warn(`[ENGINE] Breakeven not applied for ${trade.symbol} (SL status: ${slLeg?.orderStatus}). Escalating to ENTRY_RECONCILIATION_REQUIRED`);
                    TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
                } else {
                    console.warn(`[ENGINE] Breakeven price mismatch for ${trade.symbol}. Leaving in BREAKEVEN_REQUESTED.`);
                }
            } else {
                console.warn(`[ENGINE] Parent missing for breakeven recovery of ${trade.symbol}. Escalating to ENTRY_RECONCILIATION_REQUIRED`);
                TradeDB.updateState(trade.id, "ENTRY_RECONCILIATION_REQUIRED");
            }
            continue;
        }

        const parent = brokerOrders.find(order => order.correlationId === trade.correlationId);

        if (!parent) continue;

        TradeDB.updateState(trade.id, "ENTRY_PENDING", {
          superOrderId: parent.orderId,
        });

        await this.verifyOrderExecution(trade.id, parent.orderId);
      }
    } catch (e) {
      console.error("[ENGINE] Failed to run reconcileUnknownOrders", e);
    }
  }

  public async reconcileExitOrders(): Promise<void> {
    const exitTrades = TradeDB.getOpenTrades().filter(trade => 
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
            console.error(`[ENGINE] Exit ${trade.exitCorrelationId} missing from broker (count ${notFoundCount}). Retaining lock indefinitely.`);
            TradeDB.updateState(trade.id, trade.state, { exitNotFoundCount: notFoundCount });
            continue;
        }

        if (["TRADED", "CANCELLED", "REJECTED"].includes(exitOrder.orderStatus)) {
            TradeDB.updateState(trade.id, trade.state, { exitCorrelationId: "", exitNotFoundCount: 0 });
        } else {
            console.log(`[ENGINE] Cancelling pending exit order for ${trade.symbol}`);
            await this.broker.cancelOrder(exitOrder.orderId);
            await this.broker.waitForOrderTerminal(exitOrder.orderId);
            TradeDB.updateState(trade.id, trade.state, { exitCorrelationId: "", exitNotFoundCount: 0 });
        }
      }
    } catch (e) {
      console.error("[ENGINE] Failed to run reconcileExitOrders", e);
    }
  }
}
