import { pgTable, text, timestamp, boolean, jsonb, real } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, gte } from "drizzle-orm";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const db = drizzle(pool);

const trades = pgTable("trades", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  entryPrice: real("entry_price").notNull(),
  stopLoss: real("stop_loss").notNull(),
  target: real("target"),
  status: text("status").notNull(),
  brokerOrderId: text("broker_order_id"),
  exitPrice: real("exit_price"),
  pnl: real("pnl"),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

async function main() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const todaysTrades = await db
    .select()
    .from(trades)
    .where(gte(trades.createdAt, startOfDay));

  console.log("Today's Trades:");
  console.table(todaysTrades.map(t => ({
    id: t.id,
    symbol: t.symbol,
    status: t.status,
    entry: t.entryPrice,
    sl: t.stopLoss,
    target: t.target,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    reason: t.reason
  })));
  process.exit(0);
}

main().catch(console.error);
