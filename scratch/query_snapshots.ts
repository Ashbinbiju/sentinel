import { db } from "@workspace/db";
import { watchlistSnapshotsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

async function main() {
  const todayStr = '2026-07-27';
  
  try {
    const snapshots = await db
      .select()
      .from(watchlistSnapshotsTable)
      .where(eq(watchlistSnapshotsTable.date, todayStr))
      .orderBy(desc(watchlistSnapshotsTable.time));
    
    if (snapshots.length > 0) {
      console.log(JSON.stringify(snapshots, null, 2));
    } else {
      console.log("[]");
    }
  } catch (err: any) {
    console.error("Database query failed:", err.message);
  } finally {
    process.exit(0);
  }
}

main();
