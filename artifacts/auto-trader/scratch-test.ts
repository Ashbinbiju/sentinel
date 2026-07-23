import { DhanBroker } from "./src/dhan";
import { config } from "dotenv";
config({ path: "../../.env" });

async function main() {
  const broker = new DhanBroker();
  
  process.env.DRY_RUN = "false"; 

  console.log("Validating token...");
  await broker.validateOrRenewToken();

  console.log("Placing test Super Order...");
  try {
    const res = await broker.placeSuperOrder({
      securityId: "11536", // TCS
      side: "BUY",
      quantity: 1,
      entryPrice: 300,
      targetPrice: 305,
      stopLossPrice: 295,
      trailingJump: 1,
      correlationId: "test-order-" + Date.now()
    });
    console.log("Success:", res);
  } catch (err: any) {
    console.error("Failed to place Super Order:", err.message);
  }
}
main().catch(console.error);
