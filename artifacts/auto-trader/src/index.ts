import { resolve } from "path";
import { config } from "dotenv";
config({ path: resolve(__dirname, "../../../.env") });
import axios from "axios";
import { initializeScripMaster, getToken } from "./scrip-master";
import { AngelOneBroker } from "./angelone";

const MAX_DAILY_TRADES = 2;
const LEVERAGE = 5; // Intraday leverage for NSE Equity
const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds
const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

// Keep track of broker-executed symbols today to prevent duplicate orders.
// Hydrated from Angel One order book on startup so DB-only signals are not treated as executed.
const executedSymbols = new Set<string>();
let tradesToday = 0;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSymbol(symbol: string | null | undefined): string | null {
  const normalized = symbol?.trim().toUpperCase();
  return normalized ? normalized : null;
}

async function hydrateTradeStateFromBroker(broker: AngelOneBroker) {
  try {
    const brokerSymbols = await broker.getExecutedBuySymbolsFromOrderBook();

    executedSymbols.clear();
    for (const symbol of brokerSymbols) executedSymbols.add(symbol);
    tradesToday = brokerSymbols.size;

    console.log(
      `[BOT] Hydrated ${tradesToday}/${MAX_DAILY_TRADES} executed broker trade(s) for today: ${[...executedSymbols].join(", ") || "none"}`,
    );
  } catch (err: any) {
    if (process.env.DRY_RUN === "true") {
      console.warn(`[BOT] Failed to hydrate broker orders in dry run. Starting with empty in-memory state. ${err.message}`);
      return;
    }

    throw new Error(`Failed to hydrate today's executed broker orders: ${err.message}`);
  }
}

async function main() {
  console.log("=== SENTINEL AUTO-TRADER STARTING ===");
  console.log(`Dry Run Mode: ${process.env.DRY_RUN === "true" ? "ON" : "OFF"}`);

  let simulatedBalance: number | null = null;

  // 1. Load Scrip Master
  await initializeScripMaster();

  // 2. Login to Broker
  const broker = new AngelOneBroker();
  await broker.login();

  // 3. Restore today's executed broker trades before evaluating any new signals.
  await hydrateTradeStateFromBroker(broker);

  console.log("=== INITIALIZATION COMPLETE. STARTING POLLING LOOP ===");

  while (true) {
    try {
      if (tradesToday >= MAX_DAILY_TRADES) {
        console.log(`[BOT] Reached max daily trades (${MAX_DAILY_TRADES}). Shutting down loop for today.`);
        break; // Or just sleep for 24h
      }

      // 4. Poll Sentinel API
      // Uses the production Render URL if provided, otherwise falls back to local dev server
      const apiUrl = `${API_BASE_URL}/api/stocks/momentum-picks`;
      const { data } = await axios.get(apiUrl);

      if (!data || !data.topPicks) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const picks = data.topPicks;
      let cycleBalance: number;

      if (process.env.DRY_RUN === "true") {
        // Use simulated capital for dry run and persist it across polling cycles.
        if (simulatedBalance === null) {
          simulatedBalance = parseFloat(process.env.DRY_RUN_CAPITAL || "50000");
        }
        cycleBalance = simulatedBalance;
        console.log(`[BOT] [DRY RUN] Using simulated capital: INR ${cycleBalance}`);
      } else {
        cycleBalance = await broker.getAccountBalance();
        console.log(`[BOT] Current Available Margin: INR ${cycleBalance}`);
      }

      // 5. Look for fresh entry signals
      for (const pick of picks) {
        const symbol = normalizeSymbol(pick.symbol);
        if (pick.entrySignal === true && symbol && !executedSymbols.has(symbol)) {
          console.log(`[BOT] NEW SIGNAL DETECTED: ${pick.symbol} at INR ${pick.entry}`);

          if (tradesToday >= MAX_DAILY_TRADES) {
            console.log("[BOT] Skipping signal. Daily trade limit reached.");
            break;
          }

          // 6. Map Symbol to Token
          const token = getToken(symbol);
          if (!token) {
            console.log(`[BOT] Cannot trade ${pick.symbol}: No token found in Scrip Master.`);
            executedSymbols.add(symbol); // Mark as handled so we don't spam errors
            continue;
          }

          // 7. Check Balance & Calculate Quantity
          if (cycleBalance < 100) {
            console.warn("[BOT] Insufficient balance to place trade.");
            continue;
          }

          // Allocate one daily trade slot, leaving margin for later signals.
          const buyingPower = cycleBalance * LEVERAGE;
          const safeBuyingPower = buyingPower * 0.99;
          const allocationPerTrade = safeBuyingPower / MAX_DAILY_TRADES;
          const quantity = Math.floor(allocationPerTrade / pick.entry);

          if (quantity <= 0) {
            console.warn(`[BOT] Cannot afford 1 share of ${pick.symbol}. Skipping.`);
            continue;
          }

          // 8. Execute Trade (Using Bracket Order / ROBO)
          try {
            await broker.placeRoboOrder(symbol, token, quantity, pick.entry, pick.target1, pick.sl);
            executedSymbols.add(symbol);
            tradesToday++;

            const estimatedMarginUsed = broker.estimateMarginUsed(quantity, pick.entry, LEVERAGE);
            cycleBalance = Math.max(0, cycleBalance - estimatedMarginUsed);
            if (process.env.DRY_RUN === "true") {
              simulatedBalance = cycleBalance;
            }

            console.log(`[BOT] Trade ${tradesToday}/${MAX_DAILY_TRADES} executed successfully.`);
            console.log(`[BOT] Reserved estimated margin: INR ${estimatedMarginUsed.toFixed(2)} | Cycle balance left: INR ${cycleBalance.toFixed(2)}`);
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
