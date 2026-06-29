import { resolve } from "path";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { initializeScripMaster, getToken } from "./scrip-master";
import { AngelOneBroker } from "./angelone";
import { TradeDB, ActiveTrade } from "./db";

const DRY_RUN = process.env.DRY_RUN === "true";

const MAX_DAILY_TRADES = parseInt(process.env.MAX_DAILY_TRADES || "2", 10);
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

  const prefix = DRY_RUN ? "🧪 [DRY RUN]\n" : "🤖 [SENTINEL LIVE]\n";

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
    if (DRY_RUN) {
      console.warn(`[BOT] Failed to hydrate broker orders in dry run. Starting with empty in-memory state. ${err.message}`);
      return;
    }

    throw new Error(`Failed to hydrate today's executed broker orders: ${err.message}`);
  }
}

async function main() {
  console.log("Starting Sentinel Auto-Trader (Active Manager)...");
  
  if (DRY_RUN) {
    console.log("⚠️ RUNNING IN DRY-RUN MODE ⚠️");
    console.log("No actual trades will be placed.");
  }

  // 1. Initialize Scrip Master
  await initializeScripMaster();

  // 2. Authenticate Broker
  const broker = new AngelOneBroker();
  try {
    await broker.login();
  } catch (err: any) {
    if (!DRY_RUN) {
      console.error("Failed to authenticate with Angel One. Exiting.", err);
      process.exit(1);
    }
  }

  let simulatedBalance: number | null = null;

  // 3. Connect WebSocket & Setup Active Manager Callbacks
  if (!DRY_RUN) {
    await broker.connectWebSocket();
    
    // Subscribe to existing open trades from DB
    const openTrades = TradeDB.getOpenTrades();
    if (openTrades.length > 0) {
      console.log(`[BOT] Resuming management for ${openTrades.length} open trades from DB.`);
      const openTokens = openTrades.map(t => t.token);
      broker.subscribeToTokens(openTokens);
    }

    // Handle incoming ticks for Trailing SL / Target Exits
    broker.onTick(async (data: any) => {
      // Data usually contains { token, last_traded_price, ... } depending on mode
      // SmartAPI tick format for LTP mode (mode 1) usually sends { tk: "token", ltp: 123.45 }
      if (!data || !data.tk || !data.ltp) return;
      
      const token = data.tk.toString();
      const ltp = Number(data.ltp);

      const activeTrades = TradeDB.getOpenTrades();
      const trade = activeTrades.find(t => t.token === token);
      
      if (trade) {
        // Track highest LTP for trailing SL
        if (ltp > trade.highest_ltp && trade.side === "BUY") {
          await TradeDB.updateHighestLTP(trade.id, ltp);
          
          // Trailing SL Logic: If LTP reaches halfway to target (1:1 RR), trail SL to breakeven
          const risk = trade.entry_price - trade.current_sl;
          if (risk > 0 && ltp >= trade.entry_price + risk && trade.current_sl < trade.entry_price) {
            await TradeDB.updateTradeSL(trade.id, trade.entry_price, ltp);
            console.log(`[BOT] Trailing SL moved to breakeven for ${trade.symbol}`);
            sendTelegramAlert(`🚀 TRAILING SL UPDATED\nSymbol: ${trade.symbol}\nNew SL: ₹${trade.entry_price} (Risk Free!)`);
          }
        }

        // Exit Logic
        if (trade.side === "BUY") {
          if (ltp <= trade.current_sl) {
            console.log(`[BOT] STOP LOSS HIT for ${trade.symbol} at ${ltp}`);
            await closeTrade(broker, trade, "STOP LOSS", ltp);
          } else if (ltp >= trade.target) {
            console.log(`[BOT] TARGET HIT for ${trade.symbol} at ${ltp}`);
            await closeTrade(broker, trade, "TARGET", ltp);
          }
        }
      }
    });
  }

  // 4. Determine Initial Capital
  await hydrateTradeStateFromBroker(broker);

  await sendTelegramAlert(`✅ Auto-Trader initialized successfully!\nHydrated trades: ${tradesToday}/${MAX_DAILY_TRADES}`);

  console.log("=== INITIALIZATION COMPLETE. STARTING POLLING LOOP ===");

  function getISTMinutes(): number {
    const now = new Date();
    const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric', minute: 'numeric' } as const;
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    let hour = 0, minute = 0;
    for (const p of parts) {
      if (p.type === 'hour') hour = parseInt(p.value, 10);
      if (p.type === 'minute') minute = parseInt(p.value, 10);
    }
    return hour * 60 + minute;
  }

  function isMarketOpenIST(): boolean {
    const now = new Date();
    const options = { timeZone: 'Asia/Kolkata', weekday: 'short' } as const;
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    let weekday = '';
    for (const p of parts) {
      if (p.type === 'weekday') weekday = p.value;
    }
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const mins = getISTMinutes();
    return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  }

  while (true) {
    try {
      if (!isMarketOpenIST() && process.env.DRY_RUN !== "true") {
        console.log("[BOT] Outside market hours (IST). Sleeping for 5 minutes...");
        await sleep(5 * 60 * 1000); // Check again in 5 minutes
        continue;
      }

      // Auto Square-Off at 3:14 PM to avoid Angel One charges
      const currentMins = getISTMinutes();
      if (currentMins >= 15 * 60 + 14 && currentMins <= 15 * 60 + 30) {
        const activeTrades = TradeDB.getOpenTrades();
        if (activeTrades.length > 0) {
          console.log(`[BOT] 🚨 INTRADAY AUTO SQUARE-OFF TRIGGERED (3:14 PM). Closing ${activeTrades.length} open positions!`);
          for (const trade of activeTrades) {
            await closeTrade(broker, trade, "AUTO SQUARE-OFF (3:14 PM)", trade.highest_ltp || trade.entry_price);
          }
        }
        console.log("[BOT] Market closing soon. Halting new trades and sleeping until 3:30 PM...");
        await sleep(15 * 60 * 1000);
        continue;
      }

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

          // 8. Execute Trade (Using INTRADAY Market Order) with Auto-Retry
          let orderId: string | null = null;
          let retries = 0;
          const MAX_RETRIES = 3;
          let estimatedMarginUsed = 0;

          // Add to executed list immediately to PREVENT infinite polling loops on API rejections
          executedSymbols.add(symbol);

          while (retries < MAX_RETRIES) {
            try {
              orderId = await broker.placeMarketBuy(symbol, token, quantity, side);
              
              tradesToday++;
              estimatedMarginUsed = broker.estimateMarginUsed(quantity, pick.entry, LEVERAGE);
              cycleBalance = Math.max(0, cycleBalance - estimatedMarginUsed);
              if (process.env.DRY_RUN === "true") {
                simulatedBalance = cycleBalance;
              }

              console.log(`[BOT] Trade ${tradesToday}/${MAX_DAILY_TRADES} executed successfully.`);
              console.log(`[BOT] Reserved estimated margin: INR ${estimatedMarginUsed.toFixed(2)} | Cycle balance left: INR ${cycleBalance.toFixed(2)}`);
              
              // Assume filled at signal entry (in production, we'd fetch actual fill price from order book, but API limits make that hard instantly)
              const fillPrice = pick.entry;

              // Save to DB for Active Management
              if (!DRY_RUN) {
                const newTrade: ActiveTrade = {
                  id: orderId || `dry-${Date.now()}`,
                  symbol: pick.symbol,
                  token: token,
                  quantity: quantity,
                  side: side,
                  entry_price: fillPrice,
                  current_sl: pick.sl,
                  target: pick.target,
                  highest_ltp: fillPrice,
                  status: "OPEN"
                };
                await TradeDB.saveTrade(newTrade);
                broker.subscribeToTokens([token]);
              }

              const diag = pick.diagnostics;
              let diagText = "";
              if (diag) {
                diagText = `\n\n📊 Diagnostics:\nPrev High: ₹${diag.prevHigh}\nPrev Low: ₹${diag.prevLow}\nCandle: O=${diag.candleOpen}, H=${diag.candleHigh}, L=${diag.candleLow}, C=${diag.candleClose}\nReason: ${diag.reason}`;
              }

              await sendTelegramAlert(
                `🎯 NEW ACTIVE TRADE\nSymbol: ${pick.symbol}\nSide: ${side}\nSetup: ${pick.setup}\n\nQuantity: ${quantity}\nEst Entry: ₹${fillPrice}\nTarget: ₹${pick.target}\nSL: ₹${pick.sl}\n\nMargin Used: ₹${estimatedMarginUsed.toFixed(2)}\nOrder ID: ${orderId || "N/A"}${diagText}`
              );

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
      const msg = err.message || "";
      if (
        msg.includes("Invalid Token") ||
        msg.includes("Token Expired") ||
        msg.includes("Session Expired") ||
        msg.includes("AG8001")
      ) {
        console.error("[BOT] Critical token error. Deleting session file and exiting process for PM2 to restart.");
        try {
          let dir = process.cwd();
          let sessionFilePath = "";
          for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
              sessionFilePath = path.join(dir, ".angel_session.json");
              break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
          if (!sessionFilePath) {
            sessionFilePath = path.resolve(process.cwd(), "../../.angel_session.json");
          }
          if (fs.existsSync(sessionFilePath)) {
            fs.unlinkSync(sessionFilePath);
            console.log("[BOT] Deleted shared session file.");
          }
        } catch (fileErr: any) {
          console.error("[BOT] Failed to delete session file:", fileErr.message);
        }
        process.exit(1);
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function closeTrade(broker: AngelOneBroker, trade: ActiveTrade, reason: string, exitPrice: number) {
  try {
    const exitSide = trade.side === "BUY" ? "SELL" : "BUY";
    const orderId = await broker.placeMarketBuy(trade.symbol, trade.token, trade.quantity, exitSide);
    
    await TradeDB.markTradeClosed(trade.id, reason);
    broker.unsubscribeFromTokens([trade.token]);
    
    const pnl = trade.side === "BUY" ? exitPrice - trade.entry_price : trade.entry_price - exitPrice;
    const totalPnl = pnl * trade.quantity;
    const icon = totalPnl >= 0 ? "✅" : "❌";

    await sendTelegramAlert(
      `${icon} TRADE CLOSED (${reason})\nSymbol: ${trade.symbol}\nExit Price: ₹${exitPrice}\nGross P&L: ₹${totalPnl.toFixed(2)}\nOrder ID: ${orderId}`
    );
  } catch (err: any) {
    console.error(`[BOT] Failed to close trade ${trade.symbol}:`, err.message);
    await sendTelegramAlert(`🚨 URGENT: FAILED TO CLOSE ${trade.symbol} (${reason})\nManual intervention required!\nError: ${err.message}`);
  }
}

main().catch(console.error);
