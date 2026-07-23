import { fetchCandles } from "./src/routes/stocks.js";
async function run() {
    const data = await fetchCandles("TORNTPHARM", true); // upstox
    const targetDate = "2026-07-20";
    const getISTDateStr = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000 + 300000));
    
    const targetCandles = data.historicalCandles.filter((c: any) => getISTDateStr(c.t) === targetDate);
    const entryPrice = 4935.90;
    const target = 5040.56;
    console.log("Target:", target);
    for (const c of targetCandles) {
        if (c.t >= 1784530000) { 
            console.log("Time:", new Date(c.t*1000).toISOString(), "H:", c.h, "L:", c.l, "C:", c.c);
        }
    }
}
run();
