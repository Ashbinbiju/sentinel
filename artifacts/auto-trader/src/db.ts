import fs from "fs";
import path from "path";

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
  saveTrade: (trade: ActiveTrade) => {
    const trades = readDB();
    const existingIndex = trades.findIndex(t => t.id === trade.id);
    if (existingIndex >= 0) {
      trades[existingIndex] = trade;
    } else {
      trades.push(trade);
    }
    writeDB(trades);
  },

  updateTradeSL: (id: string, newSL: number, newHighestLTP: number) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.current_sl = newSL;
      trade.highest_ltp = newHighestLTP;
      writeDB(trades);
    }
  },

  updateHighestLTP: (id: string, newHighestLTP: number) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.highest_ltp = newHighestLTP;
      writeDB(trades);
    }
  },

  markTradeClosed: (id: string) => {
    const trades = readDB();
    const trade = trades.find(t => t.id === id);
    if (trade) {
      trade.status = "CLOSED";
      writeDB(trades);
    }
  },

  getOpenTrades: (): ActiveTrade[] => {
    const trades = readDB();
    return trades.filter(t => t.status === "OPEN");
  }
};
