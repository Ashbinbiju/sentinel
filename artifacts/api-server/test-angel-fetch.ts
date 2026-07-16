import { fetchAngelCandles } from "./src/routes/stocks.js";

async function main() {
  console.log("Testing Angel One fetchCandles...");
  try {
    const data = await fetchAngelCandles("RELIANCE");
    if (data) {
      console.log(`Success! Fetched ${data.sessionCandles.length} session candles and ${data.historicalCandles.length} historical candles.`);
      console.log(`Last candle:`, data.sessionCandles[data.sessionCandles.length - 1]);
    } else {
      console.log("Failed to fetch data (returned null).");
    }
  } catch (err: any) {
    console.error("Error fetching Angel data:", err.message);
  }
}

main();
