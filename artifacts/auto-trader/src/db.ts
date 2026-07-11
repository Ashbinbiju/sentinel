import fs from "fs";
import path from "path";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type TradeState =
  | "SIGNAL_CREATED"
  | "ENTRY_SUBMITTING"
  | "ENTRY_PENDING"
  | "ENTRY_PART_TRADED"
  | "ENTRY_TRADED"
  | "PROTECTION_CONFIRMED"
  | "BREAKEVEN_REQUESTED"
  | "BREAKEVEN_CONFIRMED"
  | "EXITED"
  | "REJECTED"
  | "ENTRY_RECONCILIATION_REQUIRED"
  | "EXIT_RECONCILIATION_REQUIRED"
  | "REVERSAL_RECONCILIATION_REQUIRED";

export interface ActiveTrade {
  id: string;
  correlationId: string;
  exitCorrelationId?: string;
  superOrderId: string;
  symbol: string;
  securityId: string;
  quantity: number;
  side: "BUY" | "SELL";
  entryPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  trailingJump: number;
  state: TradeState;
  protectionConfirmed: boolean;
  protectionCancelled?: boolean;
  breakevenApplied: boolean;
  createdAt: string;
  updatedAt: string;
  
  // Legacy fields
  entry_price?: number;
  current_sl?: number;
  target?: number;
  highest_ltp?: number;
  status?: "OPEN" | "CLOSED";
}

const dbPath = path.resolve(__dirname, "../../trades.json");

function readDB(): ActiveTrade[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  try {
    const data = fs.readFileSync(dbPath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("FATAL: Failed to read trade database:", err);
    throw err;
  }
}

function writeDB(trades: ActiveTrade[]) {
  try {
    const tempPath = `${dbPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(trades, null, 2), "utf-8");
    fs.renameSync(tempPath, dbPath);
  } catch (err) {
    console.error("FATAL: Failed to write to database:", err);
    throw err;
  }
}

export const TradeDB = {
  getOpenTrades: (): ActiveTrade[] => {
    return readDB().filter(t => 
      t.state !== "EXITED" && 
      t.state !== "REJECTED" && 
      t.status !== "CLOSED"
    );
  },

  getTradesForDate: (dateStr: string): ActiveTrade[] => {
    return readDB().filter(t => t.createdAt.startsWith(dateStr));
  },

  saveTrade: async (trade: ActiveTrade) => {
    const trades = readDB();
    const existingIndex = trades.findIndex(t => t.id === trade.id);
    if (existingIndex >= 0) {
      trades[existingIndex] = trade;
    } else {
      trades.push(trade);
    }
    writeDB(trades);

    try {
      const today = new Date().toISOString().slice(0, 10);
      await db.insert(tradesTable).values({
        symbol: trade.symbol,
        date: today,
        signalTime: trade.createdAt || new Date().toISOString(),
        entryPrice: (trade.entryPrice || trade.entry_price || 0).toString(),
        sl: (trade.stopLossPrice || trade.current_sl || 0).toString(),
        target: (trade.targetPrice || trade.target || 0).toString(),
        status: "ACTIVE"
      }).onConflictDoUpdate({
        target: [tradesTable.symbol, tradesTable.date],
        set: { status: "ACTIVE" }
      });
    } catch (e: any) {
      console.error("[DB] Failed to push trade to Supabase:", e.message);
    }
  },

  updateState: (id: string, newState: TradeState, updates: Partial<ActiveTrade> = {}) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.state = newState;
      trade.updatedAt = new Date().toISOString();
      Object.assign(trade, updates);
      writeDB(trades);
    }
  },

  updateTradeSL: async (id: string, newSL: number, newHighestLTP: number) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.stopLossPrice = newSL;
      trade.current_sl = newSL;
      trade.highest_ltp = newHighestLTP;
      writeDB(trades);
    }
  },

  updateHighestLTP: async (id: string, newHighestLTP: number) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.highest_ltp = newHighestLTP;
      writeDB(trades);
    }
  },

  markTradeClosed: async (id: string, reason: string = "SQUARED OFF") => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.state = "EXITED";
      trade.status = "CLOSED";
      writeDB(trades);
      
      try {
        const statusMap: Record<string, string> = {
          "TARGET 2 HIT": "TARGET 2 HIT",
          "TARGET 1 HIT": "TARGET 1 HIT",
          "SL HIT": "SL HIT",
          "TRAILING SL HIT": "T1 HIT & TRAILING SL HIT",
          "SQUARED OFF (3:15 PM)": "SQUARED OFF",
          "SQUARED OFF": "SQUARED OFF"
        };
        const dbStatus = (statusMap[reason] || "SQUARED OFF") as any;
        
        await db.update(tradesTable)
          .set({ status: dbStatus })
          .where(eq(tradesTable.symbol, trade.symbol));
      } catch (e: any) {
        console.error("[DB] Failed to update Supabase status:", e.message);
      }
    }
  }
};
