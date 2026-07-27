import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const todayStr = '2026-07-27';
  console.log(`Checking full details for trades on date: ${todayStr}\n`);

  try {
    const intradayTrades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.date, todayStr));
    
    console.log(`--- Intraday Trades (${intradayTrades.length}) ---`);
    if (intradayTrades.length > 0) {
      console.table(intradayTrades.map((t: any) => ({
        ID: t.id,
        Symbol: t.symbol,
        Dir: t.direction,
        Entry: t.entryPrice,
        Exit: t.exitPrice,
        Status: t.status,
        PnL: t.pnl,
        Reason: t.exitReason,
        Trail: t.trailApplied ? 'Yes' : 'No'
      })));
    } else {
      console.log("No intraday trades found for today.");
    }
  } catch (err: any) {
    console.error("Database query failed:", err.message);
  } finally {
    process.exit(0);
  }
}

main();
