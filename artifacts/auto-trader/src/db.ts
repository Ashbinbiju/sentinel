import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

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

const dbPath = path.resolve(__dirname, "../../trades.db");

// Ensure the directory exists if we put it elsewhere, but it's in the workspace root
const db = new Database(dbPath);

// Initialize DB schema
db.exec(`
  CREATE TABLE IF NOT EXISTS active_trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    token TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    current_sl REAL NOT NULL,
    target REAL NOT NULL,
    highest_ltp REAL NOT NULL,
    status TEXT NOT NULL
  )
`);

export const TradeDB = {
  saveTrade: (trade: ActiveTrade) => {
    const stmt = db.prepare(`
      INSERT INTO active_trades (id, symbol, token, quantity, side, entry_price, current_sl, target, highest_ltp, status)
      VALUES (@id, @symbol, @token, @quantity, @side, @entry_price, @current_sl, @target, @highest_ltp, @status)
    `);
    stmt.run(trade);
  },

  updateTradeSL: (id: string, newSL: number, newHighestLTP: number) => {
    const stmt = db.prepare(`
      UPDATE active_trades
      SET current_sl = @newSL, highest_ltp = @newHighestLTP
      WHERE id = @id
    `);
    stmt.run({ id, newSL, newHighestLTP });
  },

  updateHighestLTP: (id: string, newHighestLTP: number) => {
    const stmt = db.prepare(`
      UPDATE active_trades
      SET highest_ltp = @newHighestLTP
      WHERE id = @id
    `);
    stmt.run({ id, newHighestLTP });
  },

  markTradeClosed: (id: string) => {
    const stmt = db.prepare(`
      UPDATE active_trades
      SET status = 'CLOSED'
      WHERE id = @id
    `);
    stmt.run({ id });
  },

  getOpenTrades: (): ActiveTrade[] => {
    const stmt = db.prepare(`
      SELECT * FROM active_trades
      WHERE status = 'OPEN'
    `);
    return stmt.all() as ActiveTrade[];
  }
};
