import { AngelOneBroker } from "./angelone";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function check() {
  const broker = new AngelOneBroker();
  try {
    await broker.login();
    const response = await broker.smartApi.getOrderBook();
    console.log("Order Book Response Status:", response.status);
    console.log("Order Book Response Message:", response.message);
    if (response.status && Array.isArray(response.data)) {
      console.log(`Found ${response.data.length} orders in order book:`);
      for (const order of response.data) {
        console.log({
          symbol: order.tradingsymbol,
          time: order.updatetime || order.ordertime,
          txType: order.transactiontype,
          product: order.producttype,
          status: order.orderstatus || order.status,
          filled: order.filledshares,
          exchange: order.exchange
        });
      }
    } else {
      console.log("No data or empty response data:", response.data);
    }
  } catch (err: any) {
    console.error("Error checking order book:", err);
  }
  process.exit(0);
}

check();
