import { ActiveTrade, TradeDB, TradeState } from "./db";
import { Candle } from "./candle-engine";
import { DhanBroker, PlaceSuperOrderInput } from "./dhan";
import { randomUUID } from "crypto";

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

        const MAX_DAILY_TRADES = 5;
        const todayStr = new Date().toISOString().slice(0, 10);
        const tradesToday = TradeDB.getTradesForDate(todayStr).filter(trade =>
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
      if (qty > maxLeveragedQty) qty = maxLeveragedQty;

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
        TradeDB.updateState(newTrade.id, "RECONCILIATION_REQUIRED");
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

              const protectedPosition =
                parent?.orderStatus === "TRADED" &&
                stopLeg?.orderStatus === "PENDING" &&
                Number(stopLeg.price) > 0 &&
                Number(stopLeg.triggeredQuantity ?? 0) === 0;

              if (protectedPosition) {
                  TradeDB.updateState(tradeId, "ENTRY_TRADED");
                  TradeDB.updateState(tradeId, "PROTECTION_CONFIRMED", { protectionConfirmed: true });
                  confirmed = true;
                  console.log(`[ENGINE] Protection verified for ${tradeId}`);
              }
          } catch (err) {
              console.warn(`[ENGINE] Order book polling failed for ${tradeId}`);
          }
      }

      if (!confirmed) {
          console.warn(`[ENGINE] Failed to verify protection for ${tradeId} after 20s.`);
          TradeDB.updateState(tradeId, "RECONCILIATION_REQUIRED");
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
          for (const trade of activeTrades) {
              const pos = positions.find(p => p.securityId === trade.securityId);
              if (!pos) continue;

              const netQty = Number(pos.netQty || 0);
              const isClosed = (trade.side === "BUY" && netQty <= 0) || (trade.side === "SELL" && netQty >= 0);

              if (isClosed) {
                  console.log(`[ENGINE] Broker reconciliation detected external exit for ${trade.symbol}.`);
                  TradeDB.markTradeClosed(trade.id, "SQUARED OFF");
              }
          }
      } catch (e) {
          // Ignore
      }
  }
}
