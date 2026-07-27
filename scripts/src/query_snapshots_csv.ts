import { db } from "@workspace/db";
import { watchlistSnapshotsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import fs from "fs";
import path from "path";

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
      let csv = "ID,Date,Time,Symbol,Category,LTP,Change_Pct,Prev_High,Prev_Low\n";
      for (const s of snapshots) {
        csv += `${s.id},${s.date},${s.time},${s.symbol},${s.category},${s.ltp},${s.priceChangePct},${s.prevHigh},${s.prevLow}\n`;
      }
      
      const outPath = path.resolve(process.cwd(), "../scratch/snapshots_915_to_1200.csv");
      fs.writeFileSync(outPath, csv);
      
      console.log(`Successfully wrote ${snapshots.length} records to ${outPath}`);
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
