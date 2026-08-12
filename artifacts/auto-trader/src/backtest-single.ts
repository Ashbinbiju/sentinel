// @ts-nocheck
/**
 * Single-stock backtest: Fixed ₹5 target, 1 trade/day, full capital at 5x leverage.
 * Usage: npx tsx src/backtest-single.ts DRREDDY
 */
import axios from "axios";
import { computeEmaVwap, aggregateCandles } from "./nine-ema-vwap.js";

const FIXED_TARGET_POINTS = 5;
const CAPITAL = 50000; // Simulated capital
const LEVERAGE = 5;
const MAX_DAILY_TRADES = 1;

function getISTMinuteOfDay(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function getISTTimeStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().substring(11, 16);
}

function getEpochDateStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().slice(0, 10);
}

function roundToTick(val: number): number {
  return Math.round(val / 0.05) * 0.05;
}

async function runBacktest() {
  const symbol = process.argv[2] || "DRREDDY";
  const API_BASE = process.env.API_URL || "http://localhost:3000";
  
  console.log(`\n🔬 BACKTEST: ${symbol} | Target: ₹${FIXED_TARGET_POINTS} | Capital: ₹${CAPITAL} | Leverage: ${LEVERAGE}x`);
  console.log(`${"─".repeat(80)}`);

  // Fetch candle data from sentinel-api
  const histRes = await axios.get(`${API_BASE}/api/stocks/${symbol}/candles`);
  const historicalCandles = histRes.data?.historicalCandles || [];
  const sessionCandles = histRes.data?.sessionCandles || [];

  if (historicalCandles.length === 0 || sessionCandles.length < 3) {
    console.log("❌ Insufficient data for backtest.");
    return;
  }

  // Determine today's date
  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  // Aggregate all candles into 5-min buckets
  const rawAllCandles = [...historicalCandles, ...sessionCandles].sort((a: any, b: any) => a.t - b.t);
  const allCandles = aggregateCandles(rawAllCandles, 300);

  // Filter today's 5-min candles
  const todayCandles = allCandles.filter((c: any) => {
    const dtStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(c.t * 1000));
    return dtStr === todayIST;
  });

  if (todayCandles.length === 0) {
    console.log(`❌ No candle data for today (${todayIST}).`);
    return;
  }

  console.log(`📊 ${allCandles.length} total 5-min candles | ${todayCandles.length} today (${todayIST})`);
  console.log(`${"─".repeat(80)}\n`);

  let trade: any = null;
  let dailyTradesCount = 0;
  let result: any = null;

  // Walk through each 5-min candle chronologically
  for (const candle of todayCandles) {
    const closeTime = candle.t + 300;
    const mins = getISTMinuteOfDay(closeTime);
    const timeStr = getISTTimeStr(closeTime);

    // Get full history up to this candle for indicator computation
    const historySoFar = allCandles.filter((hc: any) => hc.t <= candle.t);
    if (historySoFar.length < 50) continue;

    const stateArray = computeEmaVwap(historySoFar);
    const currentState = stateArray[stateArray.length - 1];

    // --- Process exits first ---
    if (trade) {
      // Check target hit (intra-candle)
      if (trade.side === "BUY" && candle.h >= trade.target) {
        const pnl = trade.target - trade.entryPrice;
        const totalPnl = pnl * trade.qty;
        result = { pnl, totalPnl, exitPrice: trade.target, exitTime: timeStr, reason: "TARGET HIT ✅" };
        console.log(`  🎯 [TARGET HIT] ${symbol} @ ${timeStr} | Exit: ${trade.target.toFixed(2)} | P&L: ₹${totalPnl.toFixed(2)} (${pnl.toFixed(2)} pts × ${trade.qty} qty)`);
        trade = null;
        continue;
      }
      if (trade.side === "SELL" && candle.l <= trade.target) {
        const pnl = trade.entryPrice - trade.target;
        const totalPnl = pnl * trade.qty;
        result = { pnl, totalPnl, exitPrice: trade.target, exitTime: timeStr, reason: "TARGET HIT ✅" };
        console.log(`  🎯 [TARGET HIT] ${symbol} @ ${timeStr} | Exit: ${trade.target.toFixed(2)} | P&L: ₹${totalPnl.toFixed(2)} (${pnl.toFixed(2)} pts × ${trade.qty} qty)`);
        trade = null;
        continue;
      }

      // Check SL hit (intra-candle)
      if (trade.side === "BUY" && candle.l <= trade.sl) {
        const pnl = trade.sl - trade.entryPrice;
        const totalPnl = pnl * trade.qty;
        result = { pnl, totalPnl, exitPrice: trade.sl, exitTime: timeStr, reason: "SL HIT ❌" };
        console.log(`  🛑 [SL HIT] ${symbol} @ ${timeStr} | Exit: ${trade.sl.toFixed(2)} | P&L: ₹${totalPnl.toFixed(2)} (${pnl.toFixed(2)} pts × ${trade.qty} qty)`);
        trade = null;
        continue;
      }
      if (trade.side === "SELL" && candle.h >= trade.sl) {
        const pnl = trade.entryPrice - trade.sl;
        const totalPnl = pnl * trade.qty;
        result = { pnl, totalPnl, exitPrice: trade.sl, exitTime: timeStr, reason: "SL HIT ❌" };
        console.log(`  🛑 [SL HIT] ${symbol} @ ${timeStr} | Exit: ${trade.sl.toFixed(2)} | P&L: ₹${totalPnl.toFixed(2)} (${pnl.toFixed(2)} pts × ${trade.qty} qty)`);
        trade = null;
        continue;
      }

      // ATR-based trailing (same as live engine)
      const tradeBars = historySoFar.filter((h: any) => h.t >= trade.entryTime);
      if (trade.side === "BUY") {
        const runMax = Math.max(...tradeBars.map((h: any) => h.h), trade.entryPrice);
        const mfe = runMax - trade.entryPrice;
        if (mfe >= currentState.atr * 0.5) {
          const proposedSL = runMax - 2.5 * currentState.atr;
          if (proposedSL > trade.sl) {
            trade.sl = roundToTick(proposedSL);
            console.log(`  📈 [TRAIL] ${symbol} @ ${timeStr} | SL → ${trade.sl.toFixed(2)} (MFE: ${mfe.toFixed(2)})`);
          }
        }
      } else {
        const runMin = Math.min(...tradeBars.map((h: any) => h.l), trade.entryPrice);
        const mfe = trade.entryPrice - runMin;
        if (mfe >= currentState.atr * 0.5) {
          const proposedSL = runMin + 2.5 * currentState.atr;
          if (proposedSL < trade.sl) {
            trade.sl = roundToTick(proposedSL);
            console.log(`  📉 [TRAIL] ${symbol} @ ${timeStr} | SL → ${trade.sl.toFixed(2)} (MFE: ${mfe.toFixed(2)})`);
          }
        }
      }

      // Auto square-off at 3:15 PM
      if (mins >= 15 * 60 + 14) {
        const exitPrice = candle.c;
        const pnl = trade.side === "BUY" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
        const totalPnl = pnl * trade.qty;
        result = { pnl, totalPnl, exitPrice, exitTime: timeStr, reason: "AUTO SQUARE-OFF 🕒" };
        console.log(`  🕒 [SQUARE-OFF] ${symbol} @ ${timeStr} | Exit: ${exitPrice.toFixed(2)} | P&L: ₹${totalPnl.toFixed(2)} (${pnl.toFixed(2)} pts × ${trade.qty} qty)`);
        trade = null;
        break;
      }

      continue; // Skip entry logic while in a trade
    }

    // --- Process entries ---
    if (dailyTradesCount >= MAX_DAILY_TRADES) continue;
    if (mins < 9 * 60 + 30 || mins > 14 * 60 + 45) continue;

    if (!currentState.setupLong && !currentState.setupShort) continue;

    const side = currentState.setupLong ? "BUY" : "SELL";
    const entryPrice = candle.c;
    const sl = roundToTick(currentState.setupLong ? currentState.rawLongSl : currentState.rawShortSl);
    const target = roundToTick(side === "BUY" ? entryPrice + FIXED_TARGET_POINTS : entryPrice - FIXED_TARGET_POINTS);
    const risk = Math.abs(entryPrice - sl);
    const qty = Math.floor((CAPITAL * LEVERAGE) / entryPrice);

    if (qty < 1) continue;

    trade = { side, entryPrice, sl, target, qty, entryTime: candle.t };
    dailyTradesCount++;

    console.log(`  ⚡ [ENTRY ${dailyTradesCount}/${MAX_DAILY_TRADES}] ${symbol} @ ${timeStr}`);
    console.log(`     Side: ${side} | Entry: ${entryPrice.toFixed(2)} | SL: ${sl.toFixed(2)} (${risk.toFixed(2)} pts risk) | Target: ${target.toFixed(2)} (+₹${FIXED_TARGET_POINTS})`);
    console.log(`     Qty: ${qty} shares | Capital deployed: ₹${(qty * entryPrice).toFixed(0)} (${LEVERAGE}x leverage on ₹${CAPITAL})`);
    console.log(`     Max Loss: ₹${(risk * qty).toFixed(2)} | Max Gain: ₹${(FIXED_TARGET_POINTS * qty).toFixed(2)}`);
    console.log(``);
  }

  // If trade is still open at end of data
  if (trade) {
    const lastCandle = todayCandles[todayCandles.length - 1];
    const exitPrice = lastCandle.c;
    const pnl = trade.side === "BUY" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    const totalPnl = pnl * trade.qty;
    result = { pnl, totalPnl, exitPrice, exitTime: getISTTimeStr(lastCandle.t + 300), reason: "STILL OPEN 🔄" };
    console.log(`  🔄 [OPEN] ${symbol} @ ${getISTTimeStr(lastCandle.t + 300)} | LTP: ${exitPrice.toFixed(2)} | Unrealized P&L: ₹${totalPnl.toFixed(2)} (${pnl.toFixed(2)} pts × ${trade.qty} qty)`);
  }

  // Summary
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  📋 BACKTEST RESULT: ${symbol} on ${todayIST}`);
  console.log(`${"═".repeat(80)}`);
  if (result) {
    console.log(`  Outcome:  ${result.reason}`);
    console.log(`  P&L:      ₹${result.totalPnl.toFixed(2)} (${result.pnl.toFixed(2)} pts)`);
    console.log(`  Capital:  ₹${CAPITAL} at ${LEVERAGE}x leverage`);
    const returnPct = (result.totalPnl / CAPITAL) * 100;
    console.log(`  Return:   ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}% on capital`);
  } else {
    console.log(`  No trade signal generated today.`);
  }
  console.log(`${"═".repeat(80)}\n`);
}

runBacktest().catch(console.error);
