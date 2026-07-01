import { AngelOneBroker } from "./angelone";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const dbPath = path.resolve(__dirname, "../../trades.json");

function getISTDateStr(): string {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let year = "", month = "", day = "";
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
  }
  return `${year}-${month}-${day}`;
}

async function recover() {
  console.log("Starting trade recovery script...");
  const broker = new AngelOneBroker();
  try {
    await broker.login();
    const orderBookResponse = await broker.smartApi.getOrderBook();
    if (!orderBookResponse.status || !Array.isArray(orderBookResponse.data)) {
      console.error("Failed to fetch order book or empty:", orderBookResponse.message);
      process.exit(1);
    }

    const todayStr = getISTDateStr();
    console.log(`Fetching active trades from Supabase for date: ${todayStr}`);
    const dbTrades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.date, todayStr));

    console.log(`Found ${dbTrades.length} active database trades for today.`);

    const recoveredTrades: any[] = [];

    for (const dbTrade of dbTrades) {
      if (dbTrade.status !== "ACTIVE") {
        console.log(`Skipping trade for ${dbTrade.symbol} because status is ${dbTrade.status}`);
        continue;
      }

      // Find matching complete BUY order in the order book
      const matchingOrder = orderBookResponse.data.find((order: any) => {
        const symbolMatch = order.tradingsymbol?.toUpperCase().replace(/-EQ$/i, "").trim() === dbTrade.symbol.toUpperCase().trim();
        const isBuy = order.transactiontype?.toUpperCase() === "BUY";
        const isComplete = (order.orderstatus || order.status || "").toUpperCase() === "COMPLETE";
        return symbolMatch && isBuy && isComplete;
      });

      if (!matchingOrder) {
        console.warn(`Could not find a completed BUY order in the order book for symbol: ${dbTrade.symbol}`);
        continue;
      }

      const recoveredTrade = {
        id: matchingOrder.orderid || `recovered-${Date.now()}`,
        symbol: dbTrade.symbol,
        token: matchingOrder.symboltoken,
        quantity: Number(matchingOrder.filledshares || matchingOrder.quantity || 0),
        side: "BUY",
        entry_price: Number(dbTrade.entryPrice),
        current_sl: Number(dbTrade.sl),
        target: Number(dbTrade.target),
        highest_ltp: Number(dbTrade.entryPrice),
        status: "OPEN"
      };

      console.log(`Recovered trade: ${recoveredTrade.symbol} (Qty: ${recoveredTrade.quantity}, Token: ${recoveredTrade.token}, SL: ${recoveredTrade.current_sl}, Target: ${recoveredTrade.target})`);
      recoveredTrades.push(recoveredTrade);
    }

    if (recoveredTrades.length > 0) {
      fs.writeFileSync(dbPath, JSON.stringify(recoveredTrades, null, 2), "utf8");
      console.log(`Successfully recovered and wrote ${recoveredTrades.length} trades to ${dbPath}`);
    } else {
      console.log("No trades were recovered, did not write to trades.json.");
    }
  } catch (err: any) {
    console.error("Recovery failed:", err);
  }
  process.exit(0);
}

recover();
