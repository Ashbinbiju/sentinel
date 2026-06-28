import { resolve } from "path";
import { config } from "dotenv";
config({ path: resolve(__dirname, "../../../.env") });
import axios from "axios";
import { initializeScripMaster, getToken } from "./scrip-master";
import { AngelOneBroker } from "./angelone";

const MAX_DAILY_TRADES = 5;
const LEVERAGE = 5; // Intraday leverage for NSE Equity
const MAX_DAILY_LOSS = -1000;
const MAX_CONSECUTIVE_LOSSES = 3;
const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds
const MAX_SIGNAL_AGE_MS = 60 * 1000; // 60 seconds strict timeout
const MIN_TRADE_PRICE = 100;
const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

// Keep track of broker-executed symbols today to prevent duplicate orders.
// Hydrated from Angel One order book on startup so DB-only signals are not treated as executed.
const executedSymbols = new Set<string>();
let tradesToday = 0;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendTelegramAlert(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const prefix = process.env.DRY_RUN === "true" ? "🧪 [DRY RUN]\n" : "🤖 [SENTINEL LIVE]\n";

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: `${prefix}${message}`,
    });
  } catch (err: any) {
    console.error("[BOT] Failed to send Telegram alert:", err.message);
  }
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

  await sendTelegramAlert(`✅ Auto-Trader initialized successfully!\nHydrated trades: ${tradesToday}/${MAX_DAILY_TRADES}`);

  console.log("=== INITIALIZATION COMPLETE. STARTING POLLING LOOP ===");

  while (true) {
    try {
      if (tradesToday >= MAX_DAILY_TRADES) {
        console.log(`[BOT] Reached max daily trades (${MAX_DAILY_TRADES}). Shutting down loop for today.`);
        break; // Or just sleep for 24h
      }

      if (process.env.DRY_RUN !== "true") {
        const { realizedPnl, closedLosingTrades } = await broker.getRiskMetrics();
        if (realizedPnl <= MAX_DAILY_LOSS || closedLosingTrades >= MAX_CONSECUTIVE_LOSSES) {
          const msg = `🚨 KILL SWITCH ENGAGED 🚨\nMax loss reached!\nP&L: INR ${realizedPnl}\nLosing Trades: ${closedLosingTrades}\nHalting bot for the day.`;
          console.error(`[KILL SWITCH ENGAGED] Max loss reached (P&L: INR ${realizedPnl}, Losing Trades: ${closedLosingTrades}). Halting bot for the day.`);
          await sendTelegramAlert(msg);
          break; // Permanently stop polling
        }
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
        if (symbol && !executedSymbols.has(symbol)) {
          const side = pick.direction === "SHORT" ? "SELL" : "BUY";
          console.log(`[BOT] NEW ${side} SIGNAL DETECTED: ${pick.symbol} at INR ${pick.entry}`);

          // 5.1 Stale Signal Protection
          if (pick.diagnostics && pick.diagnostics.candleCloseTimeMs) {
            const ageMs = Date.now() - pick.diagnostics.candleCloseTimeMs;
            if (ageMs > MAX_SIGNAL_AGE_MS) {
              const ageSec = Math.floor(ageMs / 1000);
              console.warn(`[BOT] Dropping STALE signal for ${pick.symbol}. Age: ${ageSec}s exceeds limit of ${MAX_SIGNAL_AGE_MS / 1000}s.`);
              executedSymbols.add(symbol); // Ignore for the rest of the day
              continue;
            }
          }

          if (pick.entry < MIN_TRADE_PRICE) {
            console.log(`[BOT] Skipping ${pick.symbol}. Entry INR ${pick.entry} is below minimum INR ${MIN_TRADE_PRICE}.`);
            executedSymbols.add(symbol);
            continue;
          }

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
          let quantity = Math.floor(allocationPerTrade / pick.entry);

          if (quantity <= 0) {
            console.warn(`[BOT] Cannot afford 1 share of ${pick.symbol}. Skipping.`);
            executedSymbols.add(symbol); // Add here too to prevent loop
            continue;
          }

          // 8. Execute Trade (Using Bracket Order / ROBO) with Auto-Retry
          let orderId: string | null = null;
          let retries = 0;
          const MAX_RETRIES = 3;
          let estimatedMarginUsed = 0;

          // Add to executed list immediately to PREVENT infinite polling loops on API rejections
          executedSymbols.add(symbol);

          while (retries < MAX_RETRIES) {
            try {
              orderId = await broker.placeRoboOrder(symbol, token, quantity, pick.entry, pick.target2, pick.sl, side);
              
              tradesToday++;
              estimatedMarginUsed = broker.estimateMarginUsed(quantity, pick.entry, LEVERAGE);
              cycleBalance = Math.max(0, cycleBalance - estimatedMarginUsed);
              if (process.env.DRY_RUN === "true") {
                simulatedBalance = cycleBalance;
              }

              console.log(`[BOT] Trade ${tradesToday}/${MAX_DAILY_TRADES} executed successfully.`);
              console.log(`[BOT] Reserved estimated margin: INR ${estimatedMarginUsed.toFixed(2)} | Cycle balance left: INR ${cycleBalance.toFixed(2)}`);
              
              const diag = pick.diagnostics;
              let diagText = "";
              if (diag) {
                diagText = `\n\n📊 Diagnostics:\nPrev High: ₹${diag.prevHigh}\nPrev Low: ₹${diag.prevLow}\nCandle: O=${diag.candleOpen}, H=${diag.candleHigh}, L=${diag.candleLow}, C=${diag.candleClose}\nReason: ${diag.reason}`;
              }

              const limitPriceNum = side === "BUY" ? pick.entry * 1.003 : pick.entry * 0.997;
              const executionPrice = (Math.round(limitPriceNum * 20) / 20).toFixed(2);

              await sendTelegramAlert(
                `🎯 NEW TRADE EXECUTED\nSymbol: ${pick.symbol}\nSide: ${side}\nSetup: ${pick.setup}\n\nQuantity: ${quantity}\nLimit Execution: ₹${executionPrice}\nTarget: ₹${pick.target2}\nSL: ₹${pick.sl}\n\nMargin Before: ₹${(cycleBalance + estimatedMarginUsed).toFixed(2)}\nMargin Used: ₹${estimatedMarginUsed.toFixed(2)}\nOrder ID: ${orderId || "N/A"}${diagText}`
              );

              // 8.1 Sniper Timeout: Cancel unfilled orders after 20 seconds
              if (process.env.DRY_RUN !== "true" && orderId) {
                broker.monitorOrderFill(orderId, symbol, 20000, sendTelegramAlert).catch(err => {
                  console.error(`[BOT] Monitor failed for ${symbol}:`, err.message);
                });
              }
              break; // Success, break out of retry loop
            } catch (err: any) {
              const errMsg = err.message || "";
              console.error(`[BOT] Failed to execute trade for ${pick.symbol} (Attempt ${retries + 1}/${MAX_RETRIES})`, err);
              
              if (errMsg.toLowerCase().includes("margin") || errMsg.toLowerCase().includes("insufficient")) {
                retries++;
                if (retries < MAX_RETRIES) {
                  quantity = Math.floor(quantity * 0.8); // Reduce quantity by 20%
                  if (quantity < 1) {
                    await sendTelegramAlert(`❌ TRADE FAILED\nSymbol: ${pick.symbol}\nReason: Quantity reduced to 0 due to margin issues.`);
                    break;
                  }
                  console.log(`[BOT] Retrying ${symbol} with reduced quantity: ${quantity}`);
                  await sendTelegramAlert(`🔄 MARGIN RETRY\nSymbol: ${pick.symbol}\nReducing quantity to ${quantity} due to margin rejection.`);
                  await sleep(1000); // Slight delay before retry
                } else {
                  await sendTelegramAlert(`❌ TRADE FAILED\nSymbol: ${pick.symbol}\nReason: Margin issues persisted after ${MAX_RETRIES} attempts.`);
                }
              } else {
                // If it's not a margin error (e.g. Scrip blocked), don't retry.
                await sendTelegramAlert(`❌ TRADE FAILED\nSymbol: ${pick.symbol}\nReason: ${errMsg}`);
                break;
              }
            }
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
