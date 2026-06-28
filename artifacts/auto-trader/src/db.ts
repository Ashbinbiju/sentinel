import fs from "fs";
import path from "path";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface ActiveTrade {
  id: string;
  symbol: string;
  token: string;
  quantity: number;
  side: "BUY" | "SELL";
  entry_price: number;
  current_sl: number;
  target: number;
  highest_ltp: number;
  status: "OPEN" | "CLOSED";
}

const dbPath = path.resolve(__dirname, "../../trades.json");

// Read from JSON file
function readDB(): ActiveTrade[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  try {
    const data = fs.readFileSync(dbPath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("[DB] Failed to read database:", err);
    return [];
  }
}

// Write to JSON file
function writeDB(trades: ActiveTrade[]) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(trades, null, 2), "utf-8");
  } catch (err) {
    console.error("[DB] Failed to write to database:", err);
  }
}

export const TradeDB = {
  saveTrade: async (trade: ActiveTrade) => {
    // 1. Save locally to JSON for safety/state recovery
    const trades = readDB();
    const existingIndex = trades.findIndex(t => t.id === trade.id);
    if (existingIndex >= 0) {
      trades[existingIndex] = trade;
    } else {
      trades.push(trade);
    }
    writeDB(trades);

    // 2. Push to Supabase for API/Mobile App
    try {
      const today = new Date().toISOString().slice(0, 10);
      await db.insert(tradesTable).values({
        symbol: trade.symbol,
        date: today,
        signalTime: new Date().toISOString(),
        entryPrice: trade.entry_price.toString(),
        sl: trade.current_sl.toString(),
        target1: trade.target.toString(),
        target2: trade.target.toString(),
        status: "ACTIVE"
      }).onConflictDoUpdate({
        target: [tradesTable.symbol, tradesTable.date],
        set: { status: "ACTIVE" }
      });
    } catch (e: any) {
      console.error("[DB] Failed to push trade to Supabase:", e.message);
    }
  },

  updateTradeSL: async (id: string, newSL: number, newHighestLTP: number) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
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
    // 1. Mark closed locally
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.status = "CLOSED";
      writeDB(trades);
      
      // 2. Update Supabase
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
        
        const today = new Date().toISOString().slice(0, 10);
        await db.update(tradesTable)
          .set({ status: dbStatus })
          .where(
            eq(tradesTable.symbol, trade.symbol)
            // Note: Since this is intraday, updating by symbol is usually safe for active trades
          );
      } catch (e: any) {
        console.error("[DB] Failed to update Supabase status:", e.message);
      }
    }
  },

  getOpenTrades: (): ActiveTrade[] => {
    const trades = readDB();
    return trades.filter(t => t.status === "OPEN");
  }
};
