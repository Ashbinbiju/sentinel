import { resolve } from "path";
import { config } from "dotenv";
config({ path: resolve(__dirname, "../../../.env") });
import axios from "axios";
import { initializeScripMaster, getToken } from "./scrip-master";
import { AngelOneBroker } from "./angelone";

const MAX_DAILY_TRADES = 2;
const LEVERAGE = 5; // Intraday leverage for NSE Equity
const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds

// Keep track of symbols we've already ordered today to prevent duplicates
// Note: In a production scenario, we should also check the DB or actual broker orders, 
// but since the Sentinel API prevents duplicate entries in the same day via Supabase, 
// we only need this set to prevent firing the same signal twice in the same minute.
const executedSymbols = new Set<string>();
let tradesToday = 0;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== SENTINEL AUTO-TRADER STARTING ===");
  console.log(`Dry Run Mode: ${process.env.DRY_RUN === "true" ? "ON" : "OFF"}`);

  // 1. Load Scrip Master
  await initializeScripMaster();

  // 2. Login to Broker
  const broker = new AngelOneBroker();
  await broker.login();

  console.log("=== INITIALIZATION COMPLETE. STARTING POLLING LOOP ===");

  while (true) {
    try {
      if (tradesToday >= MAX_DAILY_TRADES) {
        console.log(`[BOT] Reached max daily trades (${MAX_DAILY_TRADES}). Shutting down loop for today.`);
        break; // Or just sleep for 24h
      }

      // 3. Poll Sentinel API
      // Uses the production Render URL if provided, otherwise falls back to local dev server
      const baseUrl = process.env.API_URL || "http://localhost:3000";
      const apiUrl = `${baseUrl}/api/stocks/momentum-picks`;
      const { data } = await axios.get(apiUrl);

      if (!data || !data.topPicks) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const picks = data.topPicks;
      
      // 4. Look for fresh entry signals
      for (const pick of picks) {
        if (pick.entrySignal === true && !executedSymbols.has(pick.symbol)) {
          console.log(`[BOT] 🚀 NEW SIGNAL DETECTED: ${pick.symbol} at ₹${pick.entry}`);
          
          if (tradesToday >= MAX_DAILY_TRADES) {
            console.log("[BOT] Skipping signal. Daily trade limit reached.");
            break;
          }

          // 5. Map Symbol to Token
          const token = getToken(pick.symbol);
          if (!token) {
            console.log(`[BOT] Cannot trade ${pick.symbol}: No token found in Scrip Master.`);
            executedSymbols.add(pick.symbol); // Mark as executed so we don't spam errors
            continue;
          }

          // 6. Check Balance & Calculate Quantity
          const balance = await broker.getAccountBalance();
          console.log(`[BOT] Current Available Margin: ₹${balance}`);
          
          if (balance < 100) {
            console.warn("[BOT] Insufficient balance to place trade.");
            continue;
          }

          // Full capital calculation: (Balance * Leverage) / EntryPrice
          const buyingPower = balance * LEVERAGE;
          // Leave 1% buffer for slippage and charges
          const safeBuyingPower = buyingPower * 0.99; 
          const quantity = Math.floor(safeBuyingPower / pick.entry);

          if (quantity <= 0) {
            console.warn(`[BOT] Cannot afford 1 share of ${pick.symbol}. Skipping.`);
            continue;
          }

          // 7. Execute Trade
          try {
            await broker.placeMarketBuy(pick.symbol, token, quantity);
            executedSymbols.add(pick.symbol);
            tradesToday++;
            console.log(`[BOT] Trade ${tradesToday}/${MAX_DAILY_TRADES} executed successfully.`);
          } catch (err) {
            console.error(`[BOT] Failed to execute trade for ${pick.symbol}`, err);
          }
        }
      }

    } catch (err: any) {
      console.error(`[BOT] Polling Error: ${err.message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch(console.error);
