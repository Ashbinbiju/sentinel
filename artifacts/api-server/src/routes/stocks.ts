import { Router } from "express";

const router = Router();

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://intradayscreener.com/sector-performance",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

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

const IST_OFFSET_SECS = 19800; // UTC+5:30

function getISTDateStr(epochSecs: number): string {
  return new Date((epochSecs + IST_OFFSET_SECS) * 1000).toISOString().slice(0, 10);
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  // Wide 7-day window so we always catch the last trading session regardless of holidays
  const to = Math.floor(Date.now() / 1000);
  const from = to - 7 * 24 * 3600;
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&countback=78&currencyCode=INR`;

  const response = await fetch(url, { headers: MC_HEADERS });
  if (!response.ok) return [];

  const data = (await response.json()) as {
    s: string;
    t?: number[];
    o?: number[];
    h?: number[];
    l?: number[];
    c?: number[];
    v?: number[];
  };

  if (data.s !== "ok" || !data.t || data.t.length === 0) return [];

  // Build full candle list
  const all: Candle[] = data.t.map((t, i) => ({
    t,
    o: data.o?.[i] ?? 0,
    h: data.h?.[i] ?? 0,
    l: data.l?.[i] ?? 0,
    c: data.c?.[i] ?? 0,
    v: data.v?.[i] ?? 0,
  }));

  // Find the most recent IST date that has non-zero volume (= actual trading session)
  let lastTradingDate: string | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].v > 0) {
      lastTradingDate = getISTDateStr(all[i].t);
      break;
    }
  }
  if (!lastTradingDate) return [];

  // Return only candles from that trading session
  return all.filter((c) => c.v > 0 && getISTDateStr(c.t) === lastTradingDate);
}

function calculateVWAP(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  let tpvSum = 0;
  let volSum = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    tpvSum += tp * c.v;
    volSum += c.v;
  }
  return volSum > 0 ? tpvSum / volSum : null;
}

function calculateEMA(closes: number[], period = 20): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

async function enrichWithIndicators(symbol: string): Promise<{
  vwap: number | null;
  ema20: number | null;
  confirmedClose: number | null;
  entrySignal: boolean | null;
}> {
  try {
    const candles = await fetchCandles(symbol);

    // Need at least 2 candles: one confirmed + one current
    if (candles.length < 2) {
      return { vwap: null, ema20: null, confirmedClose: null, entrySignal: null };
    }

    // Use all candles except the last (incomplete) for calculation
    const confirmed = candles.slice(0, -1);
    const confirmedClose = confirmed[confirmed.length - 1].c;

    const vwap = calculateVWAP(confirmed);
    const closes = confirmed.map((c) => c.c);
    const ema20 = calculateEMA(closes);

    const entrySignal =
      vwap !== null && ema20 !== null
        ? confirmedClose > vwap && confirmedClose > ema20
        : null;

    return {
      vwap: vwap !== null ? Math.round(vwap * 100) / 100 : null,
      ema20: ema20 !== null ? Math.round(ema20 * 100) / 100 : null,
      confirmedClose,
      entrySignal,
    };
  } catch {
    return { vwap: null, ema20: null, confirmedClose: null, entrySignal: null };
  }
}

async function runWithConcurrency<T>(
  items: string[],
  concurrency: number,
  fn: (item: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

router.get("/market-indices", async (req, res) => {
  try {
    const ts = Date.now();
    const response = await fetch(
      `https://intradayscreener.com/api/indices/indexData?_=${ts}`,
      { headers: HEADERS },
    );
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Upstream responded with ${response.status}` });
    }
    const data = (await response.json()) as Array<{
      symbol: string;
      ltp: number;
      changePct: number;
    }>;
    const indices = data.map((item) => ({
      symbol: item.symbol,
      ltp: item.ltp,
      changePct: item.changePct,
    }));
    return res.json(indices);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch market indices");
    return res.status(500).json({ error: "Failed to fetch market indices" });
  }
});

router.get("/sectors", async (req, res) => {
  try {
    const response = await fetch(
      "https://intradayscreener.com/api/indices/sectorData/1",
      { headers: HEADERS },
    );
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Upstream responded with ${response.status}` });
    }
    const data = (await response.json()) as {
      labels: string[];
      keywords: string[];
      datasets: number[];
    };

    const sectors = data.labels.map((name, i) => ({
      name,
      keyword: data.keywords[i],
      changePct: data.datasets[i] ?? 0,
    }));

    return res.json(sectors);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch sectors");
    return res.status(500).json({ error: "Failed to fetch sector data" });
  }
});

router.get("/momentum-picks", async (req, res) => {
  try {
    const sectorResponse = await fetch(
      "https://intradayscreener.com/api/indices/sectorData/1",
      { headers: HEADERS },
    );
    if (!sectorResponse.ok) {
      return res
        .status(502)
        .json({ error: `Upstream sector API responded with ${sectorResponse.status}` });
    }
    const sectorData = (await sectorResponse.json()) as {
      labels: string[];
      keywords: string[];
      datasets: number[];
    };

    const allSectors = sectorData.labels.map((name, i) => ({
      name,
      keyword: sectorData.keywords[i],
      changePct: sectorData.datasets[i] ?? 0,
    }));

    const top4 = [...allSectors]
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 4);

    const sectorResults = await Promise.all(
      top4.map(async (sector) => {
        try {
          const url = `https://intradayscreener.com/api/indices/index-constituents/${sector.keyword}/1?filter=cash`;
          const r = await fetch(url, { headers: HEADERS });
          if (!r.ok) return { ...sector, stocks: [] };

          const constituentData = (await r.json()) as {
            indexConstituents?: Array<{
              symbol: string;
              ltp: number;
              changePct: number;
            }>;
            nonIndexConstituents?: Array<{
              symbol: string;
              ltp: number;
              changePct: number;
            }>;
          };

          const seen = new Set<string>();
          const all: Array<{ symbol: string; ltp: number; changePct: number }> = [];
          for (const stock of [
            ...(constituentData.indexConstituents ?? []),
            ...(constituentData.nonIndexConstituents ?? []),
          ]) {
            if (!seen.has(stock.symbol)) {
              seen.add(stock.symbol);
              all.push(stock);
            }
          }

          const filtered = all.filter((stock) => {
            const change = stock.changePct ?? 0;
            return change >= 0.3 && change < 3.0;
          });

          // Enrich each stock with VWAP + EMA20 signals (concurrency limit: 5)
          const symbols = filtered.map((s) => s.symbol);
          const indicators = await runWithConcurrency(symbols, 5, enrichWithIndicators);

          const stocks = filtered.map((stock, i) => ({
            symbol: stock.symbol,
            ltp: stock.ltp,
            changePct: stock.changePct,
            ...indicators[i],
          }));

          return {
            sectorName: sector.name,
            sectorKeyword: sector.keyword,
            sectorChangePct: sector.changePct,
            stocks,
          };
        } catch {
          return {
            sectorName: sector.name,
            sectorKeyword: sector.keyword,
            sectorChangePct: sector.changePct,
            stocks: [],
          };
        }
      }),
    );

    return res.json({
      fetchedAt: new Date().toISOString(),
      sectors: sectorResults,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch momentum picks");
    return res.status(500).json({ error: "Failed to fetch momentum picks" });
  }
});

export default router;
