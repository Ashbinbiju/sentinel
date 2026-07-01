import { AngelOneBroker } from "./angelone";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function test() {
  const broker = new AngelOneBroker();
  try {
    await broker.login();
    await broker.connectWebSocket();

    broker.onTick((data) => {
      console.log("RECEIVED TICK DATA:", JSON.stringify(data));
      process.exit(0);
    });

    // Subscribe to ZEEL token (NSE: 3812)
    setTimeout(() => {
      console.log("Subscribing to ZEEL (3812)...");
      broker.subscribeToTokens(["3812"]);
    }, 2000);

    // Timeout after 15 seconds if no tick received
    setTimeout(() => {
      console.log("Timeout waiting for tick data.");
      process.exit(0);
    }, 15000);

  } catch (err: any) {
    console.error("Error in test:", err);
    process.exit(1);
  }
}

test();
