import { db, tradesTable, swingTradesTable } from "../../lib/db/src/index.ts";
import { eq } from "drizzle-orm";

async function main() {
  const todayStr = "2026-06-29";
  console.log(`Checking database for date: ${todayStr}\n`);

  try {
    // 1. Check Intraday Trades
    const intradayTrades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.date, todayStr));
    
    console.log(`--- Intraday Trades (${intradayTrades.length}) ---`);
    if (intradayTrades.length > 0) {
      console.table(intradayTrades.map(t => ({
        ID: t.id,
        Symbol: t.symbol,
        Time: t.signalTime,
        Entry: t.entryPrice,
        SL: t.sl,
        Target1: t.target1,
        Target2: t.target2,
        Status: t.status
      })));
    } else {
      console.log("No intraday trades found for today.");
    }

    console.log();

    // 2. Check Swing Trades
    const swingTrades = await db
      .select()
      .from(swingTradesTable)
      .where(eq(swingTradesTable.date, todayStr));

    console.log(`--- Swing Trades (${swingTrades.length}) ---`);
    if (swingTrades.length > 0) {
      console.table(swingTrades.map(t => ({
        ID: t.id,
        Symbol: t.symbol,
        Time: t.signalTime,
        Sector: t.sector,
        Direction: t.direction,
        Entry: t.entryPrice,
        SL: t.sl,
        Target: t.target,
        Score: t.score,
        Grade: t.grade,
        Status: t.status
      })));
    } else {
      console.log("No swing trades found for today.");
    }

  } catch (err: any) {
    console.error("Database query failed:", err.message);
  } finally {
    process.exit(0);
  }
}

main();
