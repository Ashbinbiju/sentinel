import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { db, tradesTable, eq } from "@workspace/db";

export type TradeState =
  | "SIGNAL_CREATED"
  | "ENTRY_SUBMITTING"
  | "ENTRY_PENDING"
  | "ENTRY_PART_TRADED"
  | "ENTRY_TRADED"
  | "PROTECTION_CONFIRMED"
  | "TRAIL_REQUESTED"
  | "TRAIL_CONFIRMED"
  | "EXITED"
  | "REJECTED"
  | "ENTRY_RECONCILIATION_REQUIRED"
  | "EXIT_RECONCILIATION_REQUIRED"
  | "REVERSAL_RECONCILIATION_REQUIRED";

export interface ActiveTrade {
  id: string;
  correlationId: string;
  exitCorrelationId?: string;
  exitSubmittedAt?: number;
  exitNotFoundCount?: number;
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
  trailApplied: boolean;
  requestedTrailStopPrice?: number;
  exitPrice?: number;
  realizedPnl?: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  verifyAttempts?: number;
  productType?: "INTRADAY" | "BO";
  
  // Legacy fields
  entry_price?: number;
  current_sl?: number;
  target?: number;
  highest_ltp?: number;
  status?: "OPEN" | "CLOSED";
}

const _currentFile = fileURLToPath(import.meta.url);
const _currentDir = path.dirname(_currentFile);
const dbPath = process.env.TRADE_STATE_PATH ?? path.resolve(_currentDir, "../data/trades.json");

// Verify the state directory is writable at startup
(function verifyStateDir() {
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    console.log(`[DB] Trade state path: ${dbPath}`);
  } catch (err: any) {
    console.error(`[FATAL] Trade state directory is not writable: ${dir}`, err.message);
    process.exit(1);
  }
})();

function fatalPersistenceError(error: unknown, msg: string): never {
  console.error(`[FATAL] ${msg}`, error);
  process.exit(1);
}

async function readDB(): Promise<ActiveTrade[]> {
  if (!fs.existsSync(dbPath)) {
    if (process.env.DRY_RUN !== "true" && process.env.BOOTSTRAP_DB !== "true") {
      fatalPersistenceError(new Error("trades.json missing"), "Persistence unavailable in LIVE mode.");
    }
    return [];
  }
  try {
    const data = await fsPromises.readFile(dbPath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    fatalPersistenceError(err, "Failed to read trade database");
  }
}

async function writeDB(trades: ActiveTrade[]) {
  try {
    const tempPath = `${dbPath}.tmp`;
    await fsPromises.writeFile(tempPath, JSON.stringify(trades, null, 2), "utf-8");
    await fsPromises.rename(tempPath, dbPath);
  } catch (err) {
    fatalPersistenceError(err, "Failed to write to database");
  }
}

let dbMutex = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = dbMutex.then(async () => {
    return await fn();
  });
  dbMutex = next.catch(() => {}) as Promise<void>;
  return next;
}

export const TradeDB = {
  getOpenTrades: async (): Promise<ActiveTrade[]> => {
    return withLock(async () => {
      const trades = await readDB();
      return trades.filter(t => 
        t.state !== "EXITED" && 
        t.state !== "REJECTED" && 
        t.status !== "CLOSED"
      );
    });
  },

  getTradesForDate: async (dateStr: string): Promise<ActiveTrade[]> => {
    return withLock(async () => {
      const trades = await readDB();
      return trades.filter(t => t.createdAt && t.createdAt.startsWith(dateStr));
    });
  },

  saveTrade: async (trade: ActiveTrade) => {
    return withLock(async () => {
      const trades = await readDB();
      const existingIndex = trades.findIndex(t => t.id === trade.id);
      if (existingIndex >= 0) {
        trades[existingIndex] = trade;
      } else {
        trades.push(trade);
      }
      await writeDB(trades);

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
    });
  },

  updateState: async (id: string, newState: TradeState | undefined, updates: Partial<ActiveTrade> = {}) => {
    return withLock(async () => {
      const trades = await readDB();
      const trade = trades.find(t => t.id === id);
      if (trade) {
        if (newState) trade.state = newState;
        trade.updatedAt = new Date().toISOString();
        Object.assign(trade, updates);
        await writeDB(trades);
      }
    });
  },

  getAllExitedTrades: async () => {
    return withLock(async () => {
      const trades = await readDB();
      return trades.filter(t => t.state === "EXITED");
    });
  },

  updateTradeSL: async (id: string, newSL: number, newHighestLTP: number) => {
    return withLock(async () => {
      const trades = await readDB();
      const trade = trades.find(t => t.id === id);
      if (trade) {
        trade.stopLossPrice = newSL;
        trade.current_sl = newSL;
        trade.highest_ltp = newHighestLTP;
        await writeDB(trades);
      }
    });
  },

  updateHighestLTP: async (id: string, newHighestLTP: number) => {
    return withLock(async () => {
      const trades = await readDB();
      const trade = trades.find(t => t.id === id);
      if (trade) {
        trade.highest_ltp = newHighestLTP;
        await writeDB(trades);
      }
    });
  },

  markTradeClosed: async (id: string, reason: string = "SQUARED OFF", exitPrice?: number) => {
    return withLock(async () => {
      const trades = await readDB();
      const trade = trades.find(t => t.id === id);
      if (trade) {
        let realizedPnl = 0;
        if (exitPrice && trade.entryPrice && trade.quantity) {
          realizedPnl = (exitPrice - trade.entryPrice) * trade.quantity * (trade.side === "BUY" ? 1 : -1);
        }
        trade.state = "EXITED";
        trade.status = "CLOSED";
        trade.exitPrice = exitPrice;
        trade.realizedPnl = realizedPnl;
        trade.closedAt = new Date().toISOString();
        await writeDB(trades);
        
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
    });
  }
};
