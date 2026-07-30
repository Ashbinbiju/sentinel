import { db } from "@workspace/db";
import { watchlistSnapshotsTable } from "@workspace/db/schema";
import { desc, eq, and, gte, lte } from "drizzle-orm";

async function main() {
  try {
    const recentDateQuery = await db
      .select({ date: watchlistSnapshotsTable.date })
      .from(watchlistSnapshotsTable)
      .orderBy(desc(watchlistSnapshotsTable.date))
      .limit(1);

    if (recentDateQuery.length === 0) {
      console.log("No snapshots found in the database.");
      process.exit(0);
    }

    const latestDate = recentDateQuery[0].date;
    
    // Let's get all snapshots between 09:45 and 10:00 for the latest date
    const morningSnapshots = await db
      .select()
      .from(watchlistSnapshotsTable)
      .where(
        and(
          eq(watchlistSnapshotsTable.date, latestDate),
          gte(watchlistSnapshotsTable.time, "09:45"),
          lte(watchlistSnapshotsTable.time, "10:00")
        )
      )
      .orderBy(watchlistSnapshotsTable.time);
      
    if (morningSnapshots.length === 0) {
      console.log(`No snapshots found between 09:45 and 10:00 AM on ${latestDate}.`);
      process.exit(0);
    }
    
    const uniqueSymbols = new Set<string>();
    morningSnapshots.forEach(s => {
      uniqueSymbols.add(s.symbol);
    });
    
    console.log(`List of unique stocks recorded in the watchlist snapshot between 09:45 and 10:00 AM on ${latestDate}:`);
    console.log(`Total unique stocks: ${uniqueSymbols.size}\n`);
    
    // Sort symbols alphabetically for clean display
    const sortedSymbols = Array.from(uniqueSymbols).sort();
    console.log(sortedSymbols.join(", "));
    
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

main();
