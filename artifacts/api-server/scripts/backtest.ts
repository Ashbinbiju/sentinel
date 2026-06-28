
const MC_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.moneycontrol.com/",
  Origin: "https://www.moneycontrol.com",
};

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const IST_OFFSET_MS = 19800 * 1000;
function getISTDateStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function getISTMinuteOfDay(epochSecs: number): number {
  const ist = new Date(epochSecs * 1000 + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 30 * 24 * 3600; // Try fetching 30 days
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(
    symbol,
  )}&resolution=5&from=${from}&to=${to}&countback=2500&currencyCode=INR`;

  const response = await fetch(url, { headers: MC_HEADERS });
  if (!response.ok) return [];
  const data = await response.json() as any;
  if (data.s !== "ok" || !data.t) return [];

  const all: Candle[] = data.t.map((t: number, i: number) => ({
    t,
    o: data.o?.[i] ?? 0,
    h: data.h?.[i] ?? 0,
    l: data.l?.[i] ?? 0,
    c: data.c?.[i] ?? 0,
    v: data.v?.[i] ?? 0,
  }));
  return all.sort((a, b) => a.t - b.t);
}

const SLIPPAGE_PCT = 0.0005; // 0.05% slippage on entry and exit
const BROKERAGE_PCT = 0.0003; // Brokerage & taxes estimate

interface Trade {
  symbol: string;
  date: string;
  setup: string;
  direction: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  slPrice: number;
  targetPrice: number;
  exitTime?: string;
  exitPrice?: number;
  status: "WIN" | "LOSS" | "OPEN";
  pnl: number;
}

async function runBacktest(symbols: string[]) {
  console.log(`Starting backtest for ${symbols.join(", ")}...\n`);
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;

  for (const symbol of symbols) {
    const candles = await fetchCandles(symbol);
    if (candles.length === 0) {
      console.log(`${symbol}: No data found.`);
      continue;
    }

    // Group by date
    const byDate = new Map<string, Candle[]>();
    for (const c of candles) {
      const d = getISTDateStr(c.t);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(c);
    }
    const dates = Array.from(byDate.keys()).sort();

    let symbolTrades = 0;
    let symbolPnl = 0;

    for (let i = 1; i < dates.length; i++) {
      const prevDate = dates[i - 1];
      const today = dates[i];
      if (today !== "2026-06-25") continue;
      
      
      const prevCandles = byDate.get(prevDate)!;
      const todayCandles = byDate.get(today)!;

      const prevHigh = Math.max(...prevCandles.map((c) => c.h));
      const prevLow = Math.min(...prevCandles.map((c) => c.l));

      let activeTrade: Trade | null = null;
      let alreadyTraded = false;

      for (let j = 0; j < todayCandles.length; j++) {
        const c = todayCandles[j];
        const mins = getISTMinuteOfDay(c.t + 300); // close time

        // Evaluate active trade
        if (activeTrade) {
          let exitPrice = 0;
          let hit = false;
          let status: "WIN" | "LOSS" = "LOSS";

          if (activeTrade.direction === "LONG") {
            if (c.l <= activeTrade.slPrice) {
              exitPrice = activeTrade.slPrice;
              hit = true;
            } else if (c.h >= activeTrade.targetPrice) {
              exitPrice = activeTrade.targetPrice;
              hit = true;
              status = "WIN";
            }
          } else {
            if (c.h >= activeTrade.slPrice) {
              exitPrice = activeTrade.slPrice;
              hit = true;
            } else if (c.l <= activeTrade.targetPrice) {
              exitPrice = activeTrade.targetPrice;
              hit = true;
              status = "WIN";
            }
          }

          // Force exit at 15:15
          if (!hit && mins >= 15 * 60 + 15) {
            exitPrice = c.c;
            hit = true;
            if (activeTrade.direction === "LONG") status = exitPrice > activeTrade.entryPrice ? "WIN" : "LOSS";
            else status = exitPrice < activeTrade.entryPrice ? "WIN" : "LOSS";
          }

          if (hit) {
            activeTrade.exitPrice = exitPrice;
            activeTrade.exitTime = new Date((c.t + 300) * 1000 + IST_OFFSET_MS).toISOString().substr(11, 5);
            activeTrade.status = status;
            
            // Calc PnL
            const gross = activeTrade.direction === "LONG" 
              ? (exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice
              : (activeTrade.entryPrice - exitPrice) / activeTrade.entryPrice;
            
            // Apply costs
            activeTrade.pnl = gross - (SLIPPAGE_PCT * 2) - BROKERAGE_PCT;
            
            console.log(`[${symbol}] ${activeTrade.setup} ${activeTrade.direction} @ ${activeTrade.entryPrice.toFixed(2)} -> exited at ${exitPrice.toFixed(2)} (${status}). PnL: ${(activeTrade.pnl * 100).toFixed(2)}%`);

            symbolPnl += activeTrade.pnl;
            symbolTrades++;
            if (activeTrade.pnl > 0) wins++; else losses++;
            totalTrades++;
            
            activeTrade = null;
            alreadyTraded = true; // only 1 trade per day
          }
          continue;
        }

        if (alreadyTraded) continue;
        if (mins < 9 * 60 + 15 || mins > 11 * 60 + 30) continue;

        let setup = "";
        let direction: "LONG" | "SHORT" | null = null;
        let sl = 0;
        let entryPrice = c.c;

if (j === 0) {
          if (c.o < prevLow * 0.999) {
            setup = "GAP DOWN"; direction = "SHORT"; 
            entryPrice = c.o; // Enter at open
            sl = c.h; // SL is high of the first candle
          } else if (c.o > prevHigh * 1.001) {
            setup = "GAP UP"; direction = "LONG"; 
            entryPrice = c.o; // Enter at open
            sl = c.l; // SL is low of the first candle
          }
        } 
        
        if (!direction) {
          // Intraday touch logic
          if (c.h >= prevHigh) {
            if (c.c > prevHigh) {
              setup = "HIGH BREAKOUT"; direction = "LONG";
              sl = Math.min(c.l, prevHigh * 0.999);
            } else {
              setup = "HIGH REJECTION"; direction = "SHORT";
              sl = Math.max(c.h, prevHigh * 1.001);
            }
            entryPrice = c.c;
          } else if (c.l <= prevLow) {
            if (c.c < prevLow) {
              setup = "LOW BREAKDOWN"; direction = "SHORT";
              sl = Math.max(c.h, prevLow * 1.001);
            } else {
              setup = "LOW SUPPORT"; direction = "LONG";
              sl = Math.min(c.l, prevLow * 0.999);
            }
            entryPrice = c.c;
          }
        }

        if (direction) {
          const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
          const target = direction === "LONG" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
          
          activeTrade = {
            symbol,
            date: today,
            setup,
            direction,
            entryTime: new Date((c.t + 300) * 1000 + IST_OFFSET_MS).toISOString().substr(11, 5),
            entryPrice,
            slPrice: sl,
            targetPrice: target,
            status: "OPEN",
            pnl: 0
          };
        }
      }
    }
    console.log(`${symbol}: ${symbolTrades} trades, PnL: ${(symbolPnl * 100).toFixed(2)}%`);
    totalPnl += symbolPnl;
  }

  console.log("\n--- BACKTEST SUMMARY ---");
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Win Rate: ${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0}%`);
  console.log(`Total Net Return: ${(totalPnl * 100).toFixed(2)}%`);
}

const symbols = ["ANGELONE"];
runBacktest(symbols).catch(console.error);
