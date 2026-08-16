import axios from "axios";
import { execSync } from "child_process";

async function run() {
  console.log("Fetching today's top gainers from IntradayScreener...");
  const url = "https://intradayscreener.com/api/trackStocks/cash";
  const res = await axios.get(url, { headers: { Accept: "application/json" } });
  
  const gainers = (res.data.intradayGainers || []).slice(0, 15);
  const symbols = gainers.map((s: any) => s.symbol?.trim());

  console.log(`Running backtest for ${symbols.length} stocks...\n`);
  
  let totalPNL = 0;
  let wins = 0;
  let losses = 0;

  for (const sym of symbols) {
    if (!sym) continue;
    try {
      const output = execSync(`npx tsx src/backtest-single.ts ${sym}`, { encoding: 'utf-8' });
      
      const pnlMatch = output.match(/P&L:\s+₹([-\d.]+)/);
      const outcomeMatch = output.match(/Outcome:\s+(.+)/);
      
      const pnl = pnlMatch ? parseFloat(pnlMatch[1]) : 0;
      const outcome = outcomeMatch ? outcomeMatch[1].trim() : "NO TRADE";
      
      if (outcome.includes("TARGET HIT") || outcome.includes("STILL OPEN")) {
          if (pnl > 0) wins++;
          else if (pnl < 0) losses++;
      } else if (outcome.includes("SL HIT")) {
          losses++;
      }
      
      totalPNL += pnl;

      // Extract the backtest result box
      const lines = output.split('\n');
      
      const entryLine = lines.find(l => l.includes('[ENTRY'));
      if (entryLine) console.log(`  ${entryLine.trim()}`);
      
      const startIdx = lines.findIndex(l => l.includes('BACKTEST RESULT:'));
      if (startIdx >= 0) {
        console.log(lines.slice(startIdx - 1, startIdx + 8).join('\n'));
      } else {
        console.log(`[${sym}] No trades or error.`);
      }
    } catch (e) {
      console.log(`Error running for ${sym}`);
    }
  }
  
  console.log(`\n===================================`);
  console.log(`📊 OVERALL RESULT (5x Leverage, ₹50K cap)`);
  console.log(`Wins: ${wins} | Losses: ${losses}`);
  console.log(`Total P&L: ₹${totalPNL.toFixed(2)}`);
  console.log(`===================================`);
}

run();
