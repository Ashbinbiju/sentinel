
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


async function debugData2() {
  const candles = await fetchCandles("ANGELONE");
  const d25 = candles.filter(c => getISTDateStr(c.t) === "2026-06-25");
  
  if (d25.length > 0) {
    const high25 = Math.max(...d25.map(c => c.h));
    const low25 = Math.min(...d25.map(c => c.l));
    const open25 = d25[0].o;
    
    console.log("25th June Open (First Candle):", open25);
    console.log("25th June High (Whole Day):", high25);
    console.log("25th June Low (Whole Day):", low25);
    
    // Find when it hit the high
    const highCandles = d25.filter(c => c.h === high25);
    console.log("Candles that hit the high:", highCandles.map(c => ({
        time: new Date((c.t + 300) * 1000 + 19800 * 1000).toISOString().substr(11, 5),
        h: c.h
    })));
  }
}
debugData2().catch(console.error);
