import { Router } from "express";
import { sendTelegramAlerts } from "../notifications.js";
import { db, tradesTable, type Trade } from "@workspace/db";
import { and, eq, gte, desc } from "drizzle-orm";

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

async function fetchCandles(symbol: string): Promise<{ sessionCandles: Candle[], historicalCandles: Candle[], lastTradingDate: string } | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 7 * 24 * 3600;
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&countback=390&currencyCode=INR`;

  const response = await fetch(url, { headers: MC_HEADERS });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    s: string;
    t?: number[];
    o?: number[];
    h?: number[];
    l?: number[];
    c?: number[];
    v?: number[];
  };

  if (data.s !== "ok" || !data.t || data.t.length === 0) return null;

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
  if (!lastTradingDate) return null;

  const validHistorical = all.filter((c) => c.v > 0);
  const sessionCandles = validHistorical.filter((c) => getISTDateStr(c.t) === lastTradingDate);

  return { sessionCandles, historicalCandles: validHistorical, lastTradingDate };
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

function detectCircuitLimit(candles: Candle[], prevClose: number): "upper" | "lower" | null {
  if (candles.length < 3) return null;
  const last3 = candles.slice(-3);
  // All three last candles have identical close → price is frozen at a circuit limit
  const frozen = last3[0].c;
  const allSame = last3.every((c) => Math.abs(c.c - frozen) <= 0.01);
  if (!allSame) return null;
  // Direction: frozen price vs previous day's close
  return frozen >= prevClose ? "upper" : "lower";
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
  signalTime: string | null;
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
    signalTime: null,
  };

  try {
    const today = getTodayISTDateStr();

    // Check DB for existing signal today
    const existingTrades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.symbol, symbol), eq(tradesTable.date, today)))
      .limit(1);

    const existingTrade = existingTrades.length > 0 ? existingTrades[0] : null;

    const candleData = await fetchCandles(symbol);
    if (!candleData || candleData.sessionCandles.length < 2) return empty;

    const { sessionCandles, historicalCandles, lastTradingDate } = candleData;

    const confirmedSession = sessionCandles.slice(0, -1);
    const confirmedHistorical = historicalCandles.slice(0, -1);

    const last = confirmedSession[confirmedSession.length - 1];
    let confirmedClose = last.c;

    const vwap = calculateVWAP(confirmedSession);
    const sessionCloses = confirmedSession.map((c) => c.c);
    const historicalCloses = confirmedHistorical.map((c) => c.c);
    const ema20 = calculateEMA(historicalCloses);

    // Downsample sparkline to at most 40 points to keep payload lean
    const step = Math.max(1, Math.floor(sessionCloses.length / 40));
    const sparkline = sessionCloses.filter((_, i) => i % step === 0 || i === sessionCloses.length - 1).map(r2);

    let sl: number | null = null;
    let target1: number | null = null;
    let target2: number | null = null;
    let riskPct: number | null = null;
    let smartExit: string | null = null;
    let signalTime: string | null = null;
    let entrySignal: boolean | null = null;

    const vwapR = vwap !== null ? r2(vwap) : null;
    const ema20R = ema20 !== null ? r2(ema20) : null;

    if (existingTrade) {
      entrySignal = true;
      sl = Number(existingTrade.sl);
      target1 = Number(existingTrade.target1);
      target2 = Number(existingTrade.target2);

      const entryPrice = Number(existingTrade.entryPrice);
      const risk = entryPrice - sl;
      riskPct = r2((risk / entryPrice) * 100);
      smartExit = `[SAVED] Entered at ₹${entryPrice}. Exit if 5-min candle closes below VWAP. At T1 (₹${target1}), move SL to entry.`;
      signalTime = existingTrade.signalTime;

      // Override confirmedClose so the UI shows the saved entry price
      confirmedClose = entryPrice;
    } else {
      // ── Crossover freshness check ──────────────────────────────────────────
      // A purely positional check (price > VWAP) fires even if the stock has
      // been above VWAP since 9:30 AM. We require that at least one of the 3
      // candles immediately before the confirmed close was BELOW VWAP — proving
      // a fresh crossover just occurred rather than a stale position.
      const CROSSOVER_LOOKBACK = 3;
      const priorCandles = confirmedSession.slice(-(CROSSOVER_LOOKBACK + 1), -1);
      const crossedVwapRecently =
        vwap !== null && priorCandles.some((c) => c.c < vwap);

      entrySignal =
        (vwap !== null && ema20 !== null && lastTradingDate === today)
          ? confirmedClose > vwap && confirmedClose > ema20 && crossedVwapRecently
          : null;

      if (entrySignal && vwap !== null) {
        const tradeParams = computeTradeParams(confirmedClose, vwap);
        sl = tradeParams.sl;
        target1 = tradeParams.target1;
        target2 = tradeParams.target2;
        riskPct = tradeParams.riskPct;
        smartExit = tradeParams.smartExit;
        signalTime = new Date().toISOString();

        try {
          await db.insert(tradesTable).values({
            symbol,
            date: today,
            signalTime,
            entryPrice: String(confirmedClose),
            sl: String(sl),
            target1: String(target1),
            target2: String(target2),
            status: "PENDING"
          }).onConflictDoNothing();
        } catch (dbErr) {
          // Log DB error but don't fail the request
          console.error(`Failed to insert trade for ${symbol}`, dbErr);
        }
      }
    }

    // Volume confirmation: compare last candle volume to session average
    const avgVolume = confirmedSession.reduce((sum, c) => sum + c.v, 0) / confirmedSession.length;
    const lastVolume = last.v;
    const volumeRatio = avgVolume > 0 ? r2(lastVolume / avgVolume) : null;
    const volumeOk = volumeRatio !== null ? volumeRatio >= 1.5 : null;

    const sessionStartIndex = confirmedHistorical.findIndex(c => c.t === confirmedSession[0]?.t);
    const prevClose = sessionStartIndex > 0 ? confirmedHistorical[sessionStartIndex - 1].c : (confirmedSession[0]?.o ?? 0);

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
      circuitLimit: detectCircuitLimit(confirmedSession, prevClose),
      volumeRatio,
      volumeOk,
      signalTime,
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
      signalTime: string | null;
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
            if (!ind.indicatorDate) continue;
            // Keep the most recent indicatorDate + lastCandleTimeIST.
            // Both are lexicographically sortable (YYYY-MM-DD and HH:MM),
            // so a plain string comparison is sufficient.
            const indKey = `${ind.indicatorDate}T${ind.lastCandleTimeIST ?? "00:00"}`;
            const curKey = `${indicatorDate ?? ""}T${lastCandleTimeIST ?? "00:00"}`;
            if (indKey > curKey) {
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
                signalTime: ind.signalTime,
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
              signalTime: ind.signalTime,
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

    // Fire Telegram alerts for any new signals (non-blocking)
    sendTelegramAlerts(topPicks, req.log).catch((err) =>
      req.log.error({ err }, "Telegram alert dispatch failed"),
    );

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

// ── GET /stocks/trades/today ──────────────────────────────────────────────────
// Returns all trade signals recorded in the DB for today (IST).
// Used by the UI to show the "Trade Status" widget in the top-right corner.
router.get("/trades/today", async (req, res) => {
  try {
    const today = getTodayISTDateStr();
    let trades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.date, today))
      .orderBy(tradesTable.signalTime);

    // Evaluate dynamic status and hitTime for today's trades
    trades = await Promise.all(trades.map(async (trade) => {
      const candleData = await fetchCandles(trade.symbol);
      if (!candleData) return { ...trade, hitTime: null };
      
      const signalTimeMs = new Date(trade.signalTime).getTime();
      if (Number.isNaN(signalTimeMs)) return { ...trade, hitTime: null };
      
      // Look at session candles that closed after the signal time (candle length is 5 mins = 300s)
      const postSignalCandles = candleData.sessionCandles.filter(c => (c.t + 300) * 1000 > signalTimeMs);
      
      let hitTime: string | null = null;
      
      const target1 = Number(trade.target1);
      const target2 = Number(trade.target2);
      const entryPrice = Number(trade.entryPrice);
      const originalSl = Number(trade.sl);
      
      const isTerminal = trade.status === "TARGET 2 HIT" || trade.status === "SL HIT" || trade.status === "T1 HIT & TRAILING SL HIT";

      if (isTerminal) {
        // Just find the hitTime for the existing terminal status without modifying the status
        if (trade.status === "TARGET 2 HIT") {
          const c = postSignalCandles.find(c => c.h >= target2);
          if (c) hitTime = getISTTimeStr(c.t);
        } else if (trade.status === "SL HIT") {
          const c = postSignalCandles.find(c => c.l <= originalSl);
          if (c) hitTime = getISTTimeStr(c.t);
        } else if (trade.status === "T1 HIT & TRAILING SL HIT") {
          const t1CandleIdx = postSignalCandles.findIndex(c => c.h >= target1);
          if (t1CandleIdx !== -1) {
            const slCandle = postSignalCandles.slice(t1CandleIdx).find(c => c.l <= entryPrice);
            if (slCandle) hitTime = getISTTimeStr(slCandle.t);
          }
        }
        return { ...trade, hitTime };
      }
      
      let newStatus = trade.status === "PENDING" ? "ACTIVE" : trade.status;
      let maxTargetReached = trade.status === "TARGET 1 HIT" ? 1 : 0;
      
      for (const c of postSignalCandles) {
        if (c.h >= target2) {
          newStatus = "TARGET 2 HIT";
          hitTime = getISTTimeStr(c.t);
          break;
        }
        if (c.h >= target1 && maxTargetReached < 1) {
          maxTargetReached = 1;
          newStatus = "TARGET 1 HIT";
          hitTime = getISTTimeStr(c.t);
        }
        
        const currentSl = maxTargetReached >= 1 ? entryPrice : originalSl;
        if (c.l <= currentSl) {
          if (maxTargetReached >= 1) {
             newStatus = "T1 HIT & TRAILING SL HIT";
          } else {
             newStatus = "SL HIT";
          }
          hitTime = getISTTimeStr(c.t);
          break;
        }
      }
      
      const nowIST = new Date(Date.now() + 19800000);
      const isAfterMarket = nowIST.getUTCHours() > 15 || (nowIST.getUTCHours() === 15 && nowIST.getUTCMinutes() >= 15);
      
      if (isAfterMarket && newStatus === "ACTIVE") {
        newStatus = "SQUARED OFF";
        const lastCandle = postSignalCandles[postSignalCandles.length - 1];
        if (lastCandle) {
          hitTime = getISTTimeStr(lastCandle.t);
        } else {
          hitTime = "15:15";
        }
      }
      
      if (newStatus !== trade.status) {
        trade.status = newStatus;
        // Fire and forget DB update
        db.update(tradesTable)
          .set({ status: newStatus })
          .where(eq(tradesTable.id, trade.id))
          .catch((e: unknown) => req.log.error({ err: e, symbol: trade.symbol }, "Failed to update trade status"));
      }
      
      return { ...trade, status: newStatus, hitTime };
    }));

    return res.json({ date: today, trades });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch today's trades");
    return res.status(500).json({ error: "Failed to fetch today's trades" });
  }
});

// ── GET /stocks/trades/history ───────────────────────────────────────────────
// Returns trades from the last N days grouped by date, with estimated P&L.
// Used by the History page to show real trade outcomes from the DB.
router.get("/trades/history", async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30));

    // Compute start date in IST
    const startDate = new Date(Date.now() + IST_OFFSET_MS - days * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);

    const trades = await db
      .select()
      .from(tradesTable)
      .where(gte(tradesTable.date, startDate))
      .orderBy(desc(tradesTable.date), tradesTable.signalTime);

    // Compute estimated P&L % based on the trade's final status.
    // For past sessions the status in the DB is already the final resolved value.
    function computePlPct(trade: Trade): number | null {
      const entry = Number(trade.entryPrice);
      const sl    = Number(trade.sl);
      const t1    = Number(trade.target1);
      const t2    = Number(trade.target2);
      if (!entry) return null;
      switch (trade.status) {
        case "TARGET 2 HIT":            return r2(((t2 - entry) / entry) * 100);
        case "TARGET 1 HIT":            return r2(((t1 - entry) / entry) * 100);
        case "T1 HIT & TRAILING SL HIT": return 0;   // exited at breakeven (entry)
        case "SL HIT":                  return r2(((sl - entry) / entry) * 100);
        default:                        return null;  // ACTIVE / PENDING / SQUARED OFF
      }
    }

    // Group trades by date
    const byDate = new Map<string, (typeof trades)[0][]>();
    for (const trade of trades) {
      if (!byDate.has(trade.date)) byDate.set(trade.date, []);
      byDate.get(trade.date)!.push(trade);
    }

    const daysData = Array.from(byDate.entries()).map(([date, dayTrades]) => {
      const enriched = dayTrades.map((t) => ({ ...t, plPct: computePlPct(t) }));
      const terminal  = enriched.filter((t) => t.plPct !== null);
      const winners   = terminal.filter((t) => (t.plPct ?? 0) > 0).length;
      const losers    = terminal.filter((t) => (t.plPct ?? 0) < 0).length;
      const breakeven = terminal.filter((t) => t.plPct === 0).length;
      const pending   = enriched.filter((t) => t.plPct === null).length;
      return {
        date,
        trades: enriched,
        summary: { total: enriched.length, winners, losers, breakeven, pending },
      };
    });

    return res.json({ days: daysData });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch trade history");
    return res.status(500).json({ error: "Failed to fetch trade history" });
  }
});

export default router;
