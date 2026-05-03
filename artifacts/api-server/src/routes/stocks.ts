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
const IST_OFFSET_MS = IST_OFFSET_SECS * 1000;

function getISTDateStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function getISTTimeStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16);
}

function getTodayISTDateStr(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
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

  const all: Candle[] = data.t.map((t, i) => ({
    t,
    o: data.o?.[i] ?? 0,
    h: data.h?.[i] ?? 0,
    l: data.l?.[i] ?? 0,
    c: data.c?.[i] ?? 0,
    v: data.v?.[i] ?? 0,
  }));

  let lastTradingDate: string | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].v > 0) {
      lastTradingDate = getISTDateStr(all[i].t);
      break;
    }
  }
  if (!lastTradingDate) return [];

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

/**
 * Compute SL, T1, T2, and smart exit for an entry signal.
 *
 * SL  = 0.4% below VWAP (the key support level), but at least 0.5% below entry.
 * T1  = entry + 1.5 × risk   (1:1.5 R:R — take partial profit)
 * T2  = entry + 2.5 × risk   (1:2.5 R:R — extended target, let runner ride)
 *
 * SmartExit: exit immediately if any 5-min candle closes below VWAP.
 * Once T1 is hit, move SL to breakeven (entry price).
 */
function computeTradeParams(
  entry: number,
  vwap: number,
): {
  sl: number;
  target1: number;
  target2: number;
  riskPct: number;
  smartExit: string;
} {
  // SL = 0.4% below VWAP, but floor at 0.5% below entry
  const slFromVwap = vwap * 0.996;
  const slFloor = entry * 0.995;
  const sl = r2(Math.min(slFromVwap, slFloor));

  const risk = entry - sl;
  const target1 = r2(entry + 1.5 * risk);
  const target2 = r2(entry + 2.5 * risk);
  const riskPct = r2((risk / entry) * 100);

  const smartExit =
    `Exit if 5-min candle closes below VWAP (₹${r2(vwap)}). ` +
    `At T1 (₹${target1}), move SL to entry (₹${r2(entry)}) and trail. ` +
    `Book full profit at T2 (₹${target2}) or exit by 15:15 IST.`;

  return { sl, target1, target2, riskPct, smartExit };
}

function detectCircuitLimit(candles: Candle[]): "upper" | "lower" | null {
  if (candles.length < 3) return null;
  const last3 = candles.slice(-3);
  // All three last candles have identical close → price is frozen at a circuit limit
  const frozen = last3[0].c;
  const allSame = last3.every((c) => Math.abs(c.c - frozen) <= 0.01);
  if (!allSame) return null;
  // Direction: frozen price vs first candle open of the session
  return frozen >= candles[0].o ? "upper" : "lower";
}

interface IndicatorResult {
  vwap: number | null;
  ema20: number | null;
  confirmedClose: number | null;
  entrySignal: boolean | null;
  sl: number | null;
  target1: number | null;
  target2: number | null;
  riskPct: number | null;
  smartExit: string | null;
  indicatorDate: string | null;
  lastCandleTimeIST: string | null;
  sparkline: number[];
  circuitLimit: "upper" | "lower" | null;
  volumeRatio: number | null;
  volumeOk: boolean | null;
}

async function enrichWithIndicators(symbol: string): Promise<IndicatorResult> {
  const empty: IndicatorResult = {
    vwap: null,
    ema20: null,
    confirmedClose: null,
    entrySignal: null,
    sl: null,
    target1: null,
    target2: null,
    riskPct: null,
    smartExit: null,
    indicatorDate: null,
    lastCandleTimeIST: null,
    sparkline: [],
    circuitLimit: null,
    volumeRatio: null,
    volumeOk: null,
  };

  try {
    const candles = await fetchCandles(symbol);
    if (candles.length < 2) return empty;

    const confirmed = candles.slice(0, -1);
    const last = confirmed[confirmed.length - 1];
    const confirmedClose = last.c;

    const vwap = calculateVWAP(confirmed);
    const closes = confirmed.map((c) => c.c);
    const ema20 = calculateEMA(closes);

    // Downsample sparkline to at most 40 points to keep payload lean
    const step = Math.max(1, Math.floor(closes.length / 40));
    const sparkline = closes.filter((_, i) => i % step === 0 || i === closes.length - 1).map(r2);

    const entrySignal =
      vwap !== null && ema20 !== null
        ? confirmedClose > vwap && confirmedClose > ema20
        : null;

    const vwapR = vwap !== null ? r2(vwap) : null;
    const ema20R = ema20 !== null ? r2(ema20) : null;

    let sl: number | null = null;
    let target1: number | null = null;
    let target2: number | null = null;
    let riskPct: number | null = null;
    let smartExit: string | null = null;

    if (entrySignal && vwap !== null) {
      const tradeParams = computeTradeParams(confirmedClose, vwap);
      sl = tradeParams.sl;
      target1 = tradeParams.target1;
      target2 = tradeParams.target2;
      riskPct = tradeParams.riskPct;
      smartExit = tradeParams.smartExit;
    }

    // Volume confirmation: compare last candle volume to session average
    const avgVolume = confirmed.reduce((sum, c) => sum + c.v, 0) / confirmed.length;
    const lastVolume = last.v;
    const volumeRatio = avgVolume > 0 ? r2(lastVolume / avgVolume) : null;
    const volumeOk = volumeRatio !== null ? volumeRatio >= 1.5 : null;

    return {
      vwap: vwapR,
      ema20: ema20R,
      confirmedClose,
      entrySignal,
      sl,
      target1,
      target2,
      riskPct,
      smartExit,
      indicatorDate: getISTDateStr(last.t),
      lastCandleTimeIST: getISTTimeStr(last.t),
      sparkline,
      circuitLimit: detectCircuitLimit(confirmed),
      volumeRatio,
      volumeOk,
    };
  } catch {
    return empty;
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

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
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
    return res.json(
      data.map((item) => ({
        symbol: item.symbol,
        ltp: item.ltp,
        changePct: item.changePct,
      })),
    );
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

    return res.json(
      data.labels.map((name, i) => ({
        name,
        keyword: data.keywords[i],
        changePct: data.datasets[i] ?? 0,
      })),
    );
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
      return res.status(502).json({
        error: `Upstream sector API responded with ${sectorResponse.status}`,
      });
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

    let indicatorDate: string | null = null;
    let lastCandleTimeIST: string | null = null;

    // Candidates for top 5 picks (entry signal stocks across all sectors)
    const topPickCandidates: Array<{
      symbol: string;
      sectorName: string;
      ltp: number;
      changePct: number;
      entry: number;
      sl: number;
      target1: number;
      target2: number;
      riskPct: number;
      smartExit: string;
      vwap: number;
      ema20: number;
      sparkline: number[];
      circuitLimit: "upper" | "lower" | null;
      volumeRatio: number | null;
      volumeOk: boolean | null;
      score: number;
    }> = [];

    const sectorResults = await Promise.all(
      top4.map(async (sector) => {
        try {
          const url = `https://intradayscreener.com/api/indices/index-constituents/${sector.keyword}/1?filter=cash`;
          const r = await fetch(url, { headers: HEADERS });
          if (!r.ok)
            return {
              sectorName: sector.name,
              sectorKeyword: sector.keyword,
              sectorChangePct: sector.changePct,
              stocks: [],
            };

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
          const all: Array<{ symbol: string; ltp: number; changePct: number }> =
            [];
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

          const symbols = filtered.map((s) => s.symbol);
          const indicators = await runWithConcurrency(
            symbols,
            5,
            enrichWithIndicators,
          );

          for (const ind of indicators) {
            if (ind.indicatorDate && !indicatorDate) {
              indicatorDate = ind.indicatorDate;
              lastCandleTimeIST = ind.lastCandleTimeIST;
            }
          }

          const stocks = filtered.map((stock, i) => {
            const ind = indicators[i];

            // Collect entry signal stocks for top picks
            if (
              ind.entrySignal &&
              ind.confirmedClose !== null &&
              ind.sl !== null &&
              ind.target1 !== null &&
              ind.target2 !== null &&
              ind.riskPct !== null &&
              ind.smartExit !== null &&
              ind.vwap !== null &&
              ind.ema20 !== null
            ) {
              // Score: prioritise momentum (changePct) + VWAP proximity (fresher crossover = tighter margin)
              //        + volume tier (high volume = conviction; low volume = noise penalty)
              const vwapMarginPct =
                ((ind.confirmedClose - ind.vwap) / ind.vwap) * 100;
              const volumeBonus =
                ind.volumeRatio === null ? 0
                : ind.volumeRatio >= 1.5 ? 1.5   // strong volume — confirmed breakout
                : ind.volumeRatio >= 1.0 ? 0.4   // average volume — neutral
                : -0.8;                           // weak volume — penalise ranking
              const score =
                stock.changePct * 1.5
                - Math.max(0, vwapMarginPct - 0.5) * 2
                + volumeBonus;

              topPickCandidates.push({
                symbol: stock.symbol,
                sectorName: sector.name,
                ltp: stock.ltp,
                changePct: stock.changePct,
                entry: ind.confirmedClose,
                sl: ind.sl,
                target1: ind.target1,
                target2: ind.target2,
                riskPct: ind.riskPct,
                smartExit: ind.smartExit,
                vwap: ind.vwap,
                ema20: ind.ema20,
                sparkline: ind.sparkline,
                circuitLimit: ind.circuitLimit,
                volumeRatio: ind.volumeRatio,
                volumeOk: ind.volumeOk,
                score,
              });
            }

            return {
              symbol: stock.symbol,
              ltp: stock.ltp,
              changePct: stock.changePct,
              vwap: ind.vwap,
              ema20: ind.ema20,
              confirmedClose: ind.confirmedClose,
              entrySignal: ind.entrySignal,
              sl: ind.sl,
              target1: ind.target1,
              target2: ind.target2,
              riskPct: ind.riskPct,
              smartExit: ind.smartExit,
              sparkline: ind.sparkline,
              circuitLimit: ind.circuitLimit,
              volumeRatio: ind.volumeRatio,
              volumeOk: ind.volumeOk,
            };
          });

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

    // Build top 5 picks — deduplicated, sorted by score
    const seen = new Set<string>();
    const topPicks = topPickCandidates
      .sort((a, b) => b.score - a.score)
      .filter((p) => {
        if (seen.has(p.symbol)) return false;
        seen.add(p.symbol);
        return true;
      })
      .slice(0, 5)
      .map(({ score: _score, ...rest }) => rest);

    const todayIST = getTodayISTDateStr();
    const isLiveSession = indicatorDate === todayIST;

    return res.json({
      fetchedAt: new Date().toISOString(),
      indicatorDate,
      isLiveSession,
      lastCandleTimeIST,
      topPicks,
      sectors: sectorResults,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch momentum picks");
    return res.status(500).json({ error: "Failed to fetch momentum picks" });
  }
});

export default router;
