import { db } from "@workspace/db";
import { watchlistSnapshotsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, asc } from "drizzle-orm";

async function main() {
  const todayStr = '2026-07-27';
  
  try {
    const snapshots = await db
      .select()
      .from(watchlistSnapshotsTable)
      .where(
        and(
          eq(watchlistSnapshotsTable.date, todayStr),
          gte(watchlistSnapshotsTable.time, '09:15'),
          lte(watchlistSnapshotsTable.time, '12:00')
        )
      )
      .orderBy(asc(watchlistSnapshotsTable.time), asc(watchlistSnapshotsTable.id));
    
    if (snapshots.length > 0) {
      // Because there might be a lot of records, let's just take the first 25 to show a sample
      // Or we can just display the first 25 of this time window.
      const displaySnapshots = snapshots.slice(0, 25);
      
      let md = `Found ${snapshots.length} snapshots between 9:15 and 12:00. Here are the first 25:\n\n`;
      md += "| ID | Time | Symbol | Category | LTP | Change % | Prev High | Prev Low |\n";
      md += "|---|---|---|---|---|---|---|---|\n";
      for (const s of displaySnapshots) {
        md += `| ${s.id} | ${s.time} | ${s.symbol} | ${s.category} | ${s.ltp} | ${s.priceChangePct}% | ${s.prevHigh} | ${s.prevLow} |\n`;
      }
      console.log(md);
    } else {
      console.log("No snapshots found between 09:15 and 12:00 for today.");
    }
  } catch (err: any) {
    console.error("Database query failed:", err.message);
  } finally {
    process.exit(0);
  }
}

main();
