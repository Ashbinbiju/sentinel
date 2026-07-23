import { fetchCandles } from "./src/routes/stocks.js";

function getISTDateStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + 19800000).toISOString().slice(0, 10);
}
function getCandleCloseDateIST(candle: any): string {
  return getISTDateStr(candle.t + 300);
}
function getTodayISTDateStr(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

async function run() {
  try {
    const data = await fetchCandles("GALLANTT", false);
    const today = getTodayISTDateStr();
    console.log("Today:", today);
    console.log("Last Trading Date:", data.lastTradingDate);
    const prevDayCandlesAll = data.historicalCandles.filter(c => getCandleCloseDateIST(c) !== today);
    const prevDates = Array.from(new Set(prevDayCandlesAll.map(c => getCandleCloseDateIST(c)))).sort();
    console.log("Prev dates:", prevDates.slice(-3));
    const lastPrevDate = prevDates.at(-1);
    console.log("lastPrevDate:", lastPrevDate);
    const prevDayCandles = prevDayCandlesAll.filter(c => getCandleCloseDateIST(c) === lastPrevDate);
    
    if (prevDayCandles.length > 0) {
        console.log("prevDayCandles length:", prevDayCandles.length);
        const prevHigh = Math.max(...prevDayCandles.map((c: any) => c.h));
        const prevLow = Math.min(...prevDayCandles.map((c: any) => c.l));
        console.log("prevHigh:", prevHigh, "prevLow:", prevLow);
    }
    console.log("sessionCandles length:", data.sessionCandles.length);
    if (data.sessionCandles.length > 0) {
        const lastCandle = data.sessionCandles[data.sessionCandles.length - 1];
        console.log("Last session candle:", lastCandle);
    }
  } catch (err: any) {
    console.error("Failed:", err.message);
  }
}
run();
