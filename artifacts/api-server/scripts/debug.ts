
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


async function debugData() {
  const candles = await fetchCandles("ANGELONE");
  const d24 = candles.filter(c => getISTDateStr(c.t) === "2026-06-24");
  const d25 = candles.filter(c => getISTDateStr(c.t) === "2026-06-25");
  
  const high24 = Math.max(...d24.map(c => c.h));
  const low24 = Math.min(...d24.map(c => c.l));
  
  console.log("24th June High:", high24);
  console.log("24th June Low:", low24);
  console.log("First 3 candles of 25th:");
  for (let i=0; i<3; i++) {
     if(d25[i]) console.log(d25[i]);
  }
}
debugData().catch(console.error);
