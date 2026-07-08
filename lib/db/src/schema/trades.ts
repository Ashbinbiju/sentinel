import { pgTable, text, serial, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const TRADE_STATUSES = [
  "PENDING",
  "ACTIVE",
  "TARGET HIT",
  "SL HIT",
  "ENTRY INVALID",
  "SQUARED OFF",
] as const;

export const tradeStatusSchema = z.enum(TRADE_STATUSES);
export type TradeStatus = z.infer<typeof tradeStatusSchema>;

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  signalTime: timestamp("signal_time", { mode: "string", withTimezone: true }).notNull(),
  entryPrice: numeric("entry_price").notNull(),
  sl: numeric("sl").notNull(),
  target: numeric("target").notNull(),
  status: text("status", { enum: TRADE_STATUSES }).notNull().default("PENDING"),
  hitTime: text("hit_time"),
  plPct: numeric("pl_pct"),
}, (table) => {
  return {
    // Ensure we only have one signal per stock per day
    symbolDateUnique: uniqueIndex("symbol_date_unique").on(table.symbol, table.date),
  };
});

export const insertTradeSchema = createInsertSchema(tradesTable, {
  status: tradeStatusSchema,
}).omit({ id: true });
export type InsertTrade = typeof tradesTable.$inferInsert;
export type Trade = typeof tradesTable.$inferSelect;

export const SWING_TRADE_STATUSES = [
  "WATCHLIST",
  "ACTIVE",
  "TARGET HIT",
  "SL HIT",
  "EXIT REVIEW",
  "CLOSED",
  "EXPIRED",
] as const;

export const swingTradeStatusSchema = z.enum(SWING_TRADE_STATUSES);
export type SwingTradeStatus = z.infer<typeof swingTradeStatusSchema>;

export const swingTradesTable = pgTable("swing_trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(),
  signalTime: timestamp("signal_time", { mode: "string", withTimezone: true }).notNull(),
  sector: text("sector"),
  direction: text("direction").notNull().default("LONG"),
  entryType: text("entry_type").notNull().default("PULLBACK"),
  currentPrice: numeric("current_price").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  sl: numeric("sl").notNull(),
  target: numeric("target").notNull(),
  score: numeric("score").notNull(),
  grade: text("grade").notNull(),
  setup: text("setup").notNull(),
  reason: text("reason"),
  expectedHoldDays: numeric("expected_hold_days").notNull().default("8"),
  status: text("status", { enum: SWING_TRADE_STATUSES }).notNull().default("WATCHLIST"),
  entryHitDate: text("entry_hit_date"),
  exitDate: text("exit_date"),
  lastPrice: numeric("last_price"),
  lastCheckedAt: timestamp("last_checked_at", { mode: "string", withTimezone: true }),
}, (table) => {
  return {
    symbolDateUnique: uniqueIndex("swing_symbol_date_unique").on(table.symbol, table.date),
  };
});

export type SwingTrade = typeof swingTradesTable.$inferSelect;
