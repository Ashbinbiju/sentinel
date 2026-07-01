import { db, tradesTable, swingTradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

async function main() {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let year = "", month = "", day = "";
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
  }
  const todayStr = `${year}-${month}-${day}`;
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
        Target: t.target,
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
