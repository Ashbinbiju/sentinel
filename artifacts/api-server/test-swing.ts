import { config } from "dotenv";
config();
import { fetchSwingUniverse, analyzeSwingCandidate, calculateTrendPersistenceScore, countEntryConsolidationCandles, percentChangeOverLookback, isLateExtendedBreakout } from "./src/routes/stocks.js";
import { fetchCandles } from "./src/candle-fetcher.js";
import { getLatestNiftyReturn } from "./src/nifty.js";

async function run() {
    const universe = fetchSwingUniverse(["All"]);
    console.log("Universe size:", universe.length);
    const nifty = await getLatestNiftyReturn();
    
    // Test for APOLLO, MRF, DLF
    const testSymbols = ["APOLLO", "MRF", "DLF", "NUVAMA", "BAJAJFINSV"];
    for (const sym of testSymbols) {
        const stock = universe.find(s => s.symbol === sym);
        if (!stock) {
            console.log(sym, "Not found in universe");
            continue;
        }
        
        console.log(`\nTesting ${sym}...`);
        const candles = await fetchCandles(sym);
        if (!candles || !candles.historicalCandles.length) {
            console.log(sym, "No candles fetched");
            continue;
        }
        
        const candidate = analyzeSwingCandidate(stock, candles.historicalCandles, nifty);
        if (candidate) {
            console.log(sym, "ACCEPTED:", candidate.score, candidate.riskPct, candidate.rewardRisk);
        } else {
            console.log(sym, "REJECTED by analyzeSwingCandidate");
        }
    }
}

run().catch(console.error).finally(() => process.exit(0));
