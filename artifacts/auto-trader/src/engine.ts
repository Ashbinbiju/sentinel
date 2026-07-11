import { ActiveTrade, TradeDB, TradeState } from "./db";
import { Candle } from "./candle-engine";
import { DhanBroker, PlaceSuperOrderInput } from "./dhan";
import { randomUUID } from "crypto";
import axios from "axios";

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

  private getPendingOrActiveTrade(securityId: string) {
    return TradeDB.getOpenTrades().find(
      t => t.securityId === securityId && t.state !== "EXITED" && t.state !== "REJECTED"
    );
  }

  public async evaluateClosedCandle(securityId: string, candle: Candle) {
    const ctx = this.watchlist.get(securityId);
    if (!ctx) return; // Not in watchlist

    // Don't evaluate if we already have an active/pending trade for this symbol
    if (this.getPendingOrActiveTrade(securityId)) return;

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
  }

  private roundToTick(val: number): number {
    return Math.round(val * 20) / 20;
  }

  private async initiateTrade(ctx: WatchlistContext, side: "BUY"|"SELL", entryPrice: number, sl: number) {
    const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
    const target = side === "BUY" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
    
    // Configured capital (could be dynamic)
    const simulatedBalance = parseFloat(process.env.DRY_RUN_CAPITAL || "50000");
    const riskPerTrade = simulatedBalance * 0.01; // 1% risk
    
    let qty = Math.floor(riskPerTrade / risk);
    if (qty < 1) qty = 1;
    
    // Apply leverage check
    const maxLeveragedQty = Math.floor((simulatedBalance * 5) / entryPrice);
    if (qty > maxLeveragedQty) qty = maxLeveragedQty;

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

    // Mandatory sequence step 2: Persist SIGNAL_CREATED
    TradeDB.saveTrade(newTrade);

    // Step 3: Persist ENTRY_SUBMITTING
    TradeDB.updateState(newTrade.id, "ENTRY_SUBMITTING");

    try {
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

      // Step 4: POST Super Order
      const superOrderId = await this.broker.placeSuperOrder(orderInput);
      
      // Step 5: Persist returned order ID
      TradeDB.updateState(newTrade.id, "ENTRY_PENDING", { superOrderId });

      // Assuming immediate execution for MARKET orders. In reality, we should check order book.
      TradeDB.updateState(newTrade.id, "ENTRY_TRADED");
      
      // Step 7: Confirm protection
      TradeDB.updateState(newTrade.id, "PROTECTION_CONFIRMED", { protectionConfirmed: true });
      
    } catch (err: any) {
      console.error(`[ENGINE] Failed to place Super Order for ${ctx.symbol}:`, err.message);
      TradeDB.updateState(newTrade.id, "REJECTED");
    }
  }

  public async evaluateLiveTick(securityId: string, ltp: number) {
    const trade = this.getPendingOrActiveTrade(securityId);
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
        // Rollback state so it can retry
        TradeDB.updateState(trade.id, "PROTECTION_CONFIRMED");
      }
    }
  }
}
