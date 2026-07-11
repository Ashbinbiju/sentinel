import { fetchCandles } from "./src/routes/stocks.js";

async function run() {
  console.log("Testing Intraday Fetch (Dhan -> Upstox -> MC)...");
  try {
    const data = await fetchCandles("RELIANCE", false);
    console.log("Intraday success:", data?.sessionCandles?.length, "candles");
  } catch (err: any) {
    console.error("Intraday failed:", err.message);
  }

  console.log("Testing Swing Fetch (Upstox -> MC)...");
  try {
    const data = await fetchCandles("RELIANCE", true);
    console.log("Swing success:", data?.sessionCandles?.length, "candles");
  } catch (err: any) {
    console.error("Swing failed:", err.message);
  }
}
run();
