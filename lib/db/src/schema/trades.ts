import { pgTable, text, serial, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  signalTime: timestamp("signal_time", { mode: "string" }).notNull(),
  entryPrice: numeric("entry_price").notNull(),
  sl: numeric("sl").notNull(),
  target1: numeric("target1").notNull(),
  target2: numeric("target2").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING, ENTERED, STOP_LOSS_HIT, COMPLETED, CANCELLED
}, (table) => {
  return {
    // Ensure we only have one signal per stock per day
    symbolDateUnique: uniqueIndex("symbol_date_unique").on(table.symbol, table.date),
  };
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = typeof tradesTable.$inferInsert;
export type Trade = typeof tradesTable.$inferSelect;
