import { config } from "dotenv";
import * as path from "path";
config({ path: "../../.env" });

import { TradeDB } from "./src/db";

async function main() {
  const trades = await TradeDB.getTradesForDate(new Date().toISOString().slice(0, 10));
  console.log(`Found ${trades.length} trades for today.`);
  for (const t of trades) {
    console.log(`Trade: ${t.symbol} | Side: ${t.side} | State: ${t.state} | Entry: ${t.entryPrice} | Qty: ${t.quantity} | SuperOrder: ${t.superOrderId}`);
  }
}
main().catch(console.error);
