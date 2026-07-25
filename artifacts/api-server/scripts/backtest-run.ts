// Temporary runner: backtest a fixed list of symbols, LONG only
const MC_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.moneycontrol.com/",
  Origin: "https://www.moneycontrol.com",
};

interface Candle {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

const IST_OFFSET_MS = 19800 * 1000;
function getISTDateStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function getISTMinuteOfDay(epochSecs: number): number {
  const ist = new Date(epochSecs * 1000 + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
const NSE_TICK_SIZE = 0.05;
function roundToTick(val: number): number {
  return Math.round(val / NSE_TICK_SIZE) * NSE_TICK_SIZE;
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 30 * 24 * 3600;
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&countback=2500&currencyCode=INR`;
  const response = await fetch(url, { headers: MC_HEADERS });
  if (!response.ok) return [];
  const data = await response.json() as any;
  if (data.s !== "ok" || !data.t) return [];
  const all: Candle[] = data.t.map((t: number, i: number) => ({
    t, o: data.o?.[i] ?? 0, h: data.h?.[i] ?? 0,
    l: data.l?.[i] ?? 0, c: data.c?.[i] ?? 0, v: data.v?.[i] ?? 0,
  }));
  return all.sort((a, b) => a.t - b.t);
}

const TOUCH_BUFFER_PCT = 0.0015;
const MAX_CHASE_PCT = 0.008;
const SL_BUFFER_PCT = 0.01;
const STRUCTURAL_TRAIL_RR = 1.5;
const STRUCTURAL_TRAIL_RISK_BUFFER = 0.15;
const SLIPPAGE_PCT = 0.0005;
const BROKERAGE_PCT = 0.0003;
const DRY_RUN_CAPITAL = 50000;
const RISK_PER_TRADE = DRY_RUN_CAPITAL * 0.01;
const MAX_DAILY_TRADES = 5;
const MAX_DAILY_LOSS = -2500;
const MAX_CONSECUTIVE_LOSSES = 3;

interface Trade {
  symbol: string; date: string; setup: string;
  direction: "LONG" | "SHORT"; entryTime: string; entryPrice: number;
  slPrice: number; targetPrice: number; quantity: number;
  exitTime?: string; exitPrice?: number;
  status: "WIN" | "LOSS" | "OPEN" | "BREAKEVEN";
  pnl: number; pnlInr: number; trailApplied: boolean;
}

async function runBacktest(screenerStocks: any[]) {
  const symbols = screenerStocks.map(s => s.symbol);
  console.log(`\nRunning LONG-ONLY backtest for ${symbols.length} symbols: ${symbols.join(", ")}\n`);

  const screenerDataMap = new Map<string, any>();
  for (const s of screenerStocks) screenerDataMap.set(s.symbol, s);

  const allCandlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    process.stdout.write(`  Fetching ${symbol}... `);
    const candles = await fetchCandles(symbol);
    if (candles.length > 0) { allCandlesBySymbol.set(symbol, candles); console.log(`${candles.length} candles`); }
    else console.log("FAILED or no data");
  }

  const allDates = new Set<string>();
  for (const candles of allCandlesBySymbol.values())
    for (const c of candles) allDates.add(getISTDateStr(c.t));
  // Only the most recent Friday
  const allFridays = Array.from(allDates).sort().filter(d => new Date(d + "T06:00:00Z").getUTCDay() === 5);
  const sortedDates = allFridays.slice(-1); // just last Friday

  const allCompletedTrades: Trade[] = [];
  let totalPnlPct = 0, totalPnlInr = 0, totalTrades = 0, wins = 0, losses = 0;

  for (const date of sortedDates) {
    const activeTrades = new Map<string, Trade>();
    const completedTradesToday: Trade[] = [];
    let tradesTakenToday = 0;
    let dailyLossInr = 0;
    let consecutiveLosses = 0;

    const dailyCandlesBySymbol = new Map<string, Candle[]>();
    for (const [symbol, candles] of allCandlesBySymbol.entries()) {
      const day = candles.filter(c => getISTDateStr(c.t) === date);
      if (day.length > 0) dailyCandlesBySymbol.set(symbol, day);
    }

    const allDayCandles: { symbol: string; candle: Candle }[] = [];
    for (const [symbol, candles] of dailyCandlesBySymbol.entries())
      for (const candle of candles) allDayCandles.push({ symbol, candle });
    allDayCandles.sort((a, b) => a.candle.t - b.candle.t);

    const allTimestamps = [...new Set(allDayCandles.map(x => x.candle.t))].sort((a, b) => a - b);

    for (const ts of allTimestamps) {
      const minute = getISTMinuteOfDay(ts);
      if (minute < 9 * 60 + 20 || minute > 15 * 60) continue; // market open guard

      for (const { symbol, candle } of allDayCandles.filter(x => x.candle.t === ts)) {
        const activeTrade = activeTrades.get(symbol);

        if (activeTrade) {
          // Manage open trade
          let exitPrice: number | undefined;
          let status: Trade["status"] | undefined;

          const { direction, slPrice, targetPrice, entryPrice } = activeTrade;

          if (direction === "LONG") {
            if (candle.l <= slPrice) { exitPrice = slPrice; status = "LOSS"; }
            else if (candle.h >= targetPrice) { exitPrice = targetPrice; status = "WIN"; }

            // Structural trail
            const risk = entryPrice - slPrice;
            if (!activeTrade.trailApplied && candle.h >= entryPrice + STRUCTURAL_TRAIL_RR * risk) {
              const newSl = roundToTick(entryPrice - STRUCTURAL_TRAIL_RISK_BUFFER * risk);
              if (newSl > activeTrade.slPrice) { activeTrade.slPrice = newSl; activeTrade.trailApplied = true; }
            }
          }

          if (minute >= 15 * 60 && !exitPrice) {
            exitPrice = candle.c; status = activeTrade.trailApplied ? "BREAKEVEN" : (candle.c >= activeTrade.entryPrice ? "WIN" : "LOSS");
          }

          if (exitPrice && status) {
            const exitWithSlippage = direction === "LONG" ? exitPrice * (1 - SLIPPAGE_PCT) : exitPrice * (1 + SLIPPAGE_PCT);
            const pnlPct = direction === "LONG" ? (exitWithSlippage - activeTrade.entryPrice) / activeTrade.entryPrice - BROKERAGE_PCT : (activeTrade.entryPrice - exitWithSlippage) / activeTrade.entryPrice - BROKERAGE_PCT;
            const pnlInr = pnlPct * activeTrade.quantity * activeTrade.entryPrice;
            activeTrade.exitTime = new Date(ts * 1000).toISOString();
            activeTrade.exitPrice = exitWithSlippage;
            activeTrade.status = pnlPct >= 0 ? (pnlPct === 0 ? "BREAKEVEN" : "WIN") : "LOSS";
            activeTrade.pnl = pnlPct;
            activeTrade.pnlInr = pnlInr;
            dailyLossInr += pnlInr < 0 ? pnlInr : 0;
            if (pnlInr < 0) consecutiveLosses++; else consecutiveLosses = 0;
            completedTradesToday.push({ ...activeTrade });
            activeTrades.delete(symbol);
          }
          continue;
        }

        // Kill switch
        if (dailyLossInr <= MAX_DAILY_LOSS || consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) continue;
        if (tradesTakenToday >= MAX_DAILY_TRADES) continue;
        if (minute < 9 * 60 + 25 || minute > 14 * 60 + 30) continue;
        if (activeTrades.has(symbol)) continue;

        // Setup detection: LONG only - breakout above prior candle high
        const dayCandles = dailyCandlesBySymbol.get(symbol) ?? [];
        const idx = dayCandles.findIndex(c => c.t === ts);
        if (idx < 1) continue;
        const prevCandle = dayCandles[idx - 1];

        const breakoutLevel = prevCandle.h;
        const currentHigh = candle.h;
        const entryPrice = roundToTick(breakoutLevel * (1 + TOUCH_BUFFER_PCT));
        const chaseLimit = roundToTick(breakoutLevel * (1 + MAX_CHASE_PCT));

        if (currentHigh >= breakoutLevel && candle.o <= chaseLimit && entryPrice <= chaseLimit) {
          const slPrice = roundToTick(prevCandle.l * (1 - SL_BUFFER_PCT));
          const risk = entryPrice - slPrice;
          if (risk <= 0) continue;
          const targetPrice = roundToTick(entryPrice + 2 * risk);
          const quantity = Math.max(1, Math.floor(RISK_PER_TRADE / risk));
          const entryWithSlippage = roundToTick(entryPrice * (1 + SLIPPAGE_PCT));

          const trade: Trade = {
            symbol, date, setup: "BREAKOUT_LONG", direction: "LONG",
            entryTime: new Date(ts * 1000).toISOString(),
            entryPrice: entryWithSlippage, slPrice, targetPrice, quantity,
            status: "OPEN", pnl: 0, pnlInr: 0, trailApplied: false,
          };
          activeTrades.set(symbol, trade);
          tradesTakenToday++;
        }
      }
    }

    // Close any still-open trades at EOD
    for (const [symbol, trade] of activeTrades.entries()) {
      const dayCandles = dailyCandlesBySymbol.get(symbol) ?? [];
      const last = dayCandles[dayCandles.length - 1];
      if (!last) continue;
      const exitPrice = last.c * (trade.direction === "LONG" ? (1 - SLIPPAGE_PCT) : (1 + SLIPPAGE_PCT));
      const pnlPct = (exitPrice - trade.entryPrice) / trade.entryPrice - BROKERAGE_PCT;
      const pnlInr = pnlPct * trade.quantity * trade.entryPrice;
      trade.exitTime = new Date(last.t * 1000).toISOString();
      trade.exitPrice = exitPrice;
      trade.status = pnlPct >= 0 ? "WIN" : "LOSS";
      trade.pnl = pnlPct;
      trade.pnlInr = pnlInr;
      completedTradesToday.push({ ...trade });
    }

    for (const t of completedTradesToday) {
      const icon = t.status === "WIN" ? "✅" : t.status === "LOSS" ? "❌" : "➖";
      console.log(`${icon} [${t.date}] ${t.symbol} ${t.direction} | Entry: ₹${t.entryPrice.toFixed(2)} | Exit: ₹${t.exitPrice?.toFixed(2)} | PnL: ${(t.pnl * 100).toFixed(2)}% (₹${t.pnlInr.toFixed(2)}) | ${t.status}`);
      if (t.pnl > 0) wins++; else if (t.pnl < 0) losses++;
      totalPnlPct += t.pnl;
      totalPnlInr += t.pnlInr;
      totalTrades++;
      allCompletedTrades.push(t);
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("              BACKTEST SUMMARY (LONG ONLY)          ");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Symbols        : ${symbols.join(", ")}`);
  console.log(`  Total Trades   : ${totalTrades}`);
  console.log(`  Wins / Losses  : ${wins} / ${losses}`);
  console.log(`  Win Rate       : ${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0}%`);
  console.log(`  Net Return     : ${(totalPnlPct * 100).toFixed(2)}%`);
  console.log(`  Total PnL (₹)  : ₹${totalPnlInr.toFixed(2)}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

const SYMBOLS = [
  "RELAXO", "RESPONIND", "ECLERX", "AIIL", "FINOPB",
  "FEDERALBNK", "KALYANKJIL", "AFCONS", "VAIBHAVGBL", "BHARATFORG",
  "CAMPUS", "METROBRAND", "ZFCVINDIA", "EXIDEIND", "KOTAKBANK",
  "AEGISLOG", "ANANTRAJ", "PRESTIGE", "SONACOMS", "DLF",
  "CMSINFO", "INDIACEM", "PTCIL", "J&KBANK", "STAR",
];

const screenerStocks = SYMBOLS.map(symbol => ({ symbol, ltp: 200, category: "GAINER" }));
runBacktest(screenerStocks);
