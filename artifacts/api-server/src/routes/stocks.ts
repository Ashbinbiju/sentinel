import { Router } from "express";
import { sendTelegramAlerts } from "../notifications.js";
import { db, tradesTable, type Trade, type TradeStatus } from "@workspace/db";
import { and, eq, gte, desc } from "drizzle-orm";
import { TOTP } from "totp-generator";

const { SmartAPI } = require("smartapi-javascript");

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

interface CandleData {
  sessionCandles: Candle[];
  historicalCandles: Candle[];
  lastTradingDate: string;
}

interface AngelScripMasterRow {
  token: string;
  name: string;
  symbol: string;
  exch_seg: string;
  instrumenttype: string;
}

type AngelCandleRow = [
  string | number,
  string | number,
  string | number,
  string | number,
  string | number,
  string | number,
];

const IST_OFFSET_SECS = 19800; // UTC+5:30
const IST_OFFSET_MS = IST_OFFSET_SECS * 1000;
const CANDLE_INTERVAL_SECS = 5 * 60;
const INDICATOR_LOOKBACK_TRADING_DAYS = 7;
const FETCH_LOOKBACK_CALENDAR_DAYS = 14;
const ANGEL_SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

let angelSmartApi: any | null = null;
let angelLoginPromise: Promise<any> | null = null;
let angelSessionExpiresAt = 0;
let angelScripMapPromise: Promise<Map<string, string>> | null = null;
let angelCredentialsWarningShown = false;

function getISTDateStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function getISTTimeStr(epochSecs: number): string {
  return new Date(epochSecs * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16);
}

function getTodayISTDateStr(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function getNowISTParts(): { h: number; m: number; day: number } {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return {
    h: now.getUTCHours(),
    m: now.getUTCMinutes(),
    day: now.getUTCDay(),
  };
}

function isWeekendISTDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return false;
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

function isIntradaySquareOffTimeIST(): boolean {
  const { h, m, day } = getNowISTParts();
  const isWeekend = day === 0 || day === 6;
  return isWeekend || h > 15 || (h === 15 && m >= 15);
}

function isEntrySignalWindowIST(): boolean {
  const { h, m, day } = getNowISTParts();
  if (day === 0 || day === 6) return false;

  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 15;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hasAngelMarketDataCredentials(): boolean {
  return Boolean(
    process.env.ANGEL_API_KEY &&
      process.env.ANGEL_CLIENT_CODE &&
      process.env.ANGEL_PASSWORD &&
      process.env.ANGEL_TOTP_SECRET,
  );
}

function formatAngelDate(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

function parseAngelEpochSecs(value: string | number): number | null {
  if (typeof value === "number") {
    return Math.floor(value > 1_000_000_000_000 ? value / 1000 : value);
  }

  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T");
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}+05:30`;
  const ms = Date.parse(withTimezone);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function buildCandleData(candles: Candle[]): CandleData | null {
  const validHistorical = [...candles].sort((a, b) => a.t - b.t);
  const tradingDates = Array.from(
    new Set(validHistorical.map((c) => getISTDateStr(c.t))),
  ).slice(-INDICATOR_LOOKBACK_TRADING_DAYS);

  const lastTradingDate = tradingDates.at(-1) ?? null;
  if (!lastTradingDate) return null;

  const tradingDateSet = new Set(tradingDates);
  const historicalCandles = validHistorical.filter((c) =>
    tradingDateSet.has(getISTDateStr(c.t)),
  );
  const sessionCandles = validHistorical.filter(
    (c) => getISTDateStr(c.t) === lastTradingDate,
  );
  return { sessionCandles, historicalCandles, lastTradingDate };
}

function getConfirmedCandles(candles: Candle[]): Candle[] {
  const nowSecs = Math.floor(Date.now() / 1000);
  return candles.filter((c) => c.t + CANDLE_INTERVAL_SECS <= nowSecs);
}

async function getAngelScripMap(): Promise<Map<string, string>> {
  if (!angelScripMapPromise) {
    angelScripMapPromise = (async () => {
      const response = await fetch(ANGEL_SCRIP_MASTER_URL);
      if (!response.ok) {
        throw new Error(`Angel scrip master responded with ${response.status}`);
      }

      const rows = (await response.json()) as AngelScripMasterRow[];
      const map = new Map<string, string>();
      for (const row of rows) {
        if (row.exch_seg === "NSE" && row.instrumenttype === "") {
          map.set(row.name.toUpperCase().trim(), row.token);
          map.set(row.symbol.replace(/-EQ$/i, "").toUpperCase().trim(), row.token);
        }
      }
      console.log(`[DATA] Loaded ${map.size} Angel One NSE equity token aliases.`);
      return map;
    })();
  }

  return angelScripMapPromise;
}

async function getAngelSmartApi(): Promise<any> {
  if (angelSmartApi && Date.now() < angelSessionExpiresAt) return angelSmartApi;
  if (angelLoginPromise) return angelLoginPromise;

  angelLoginPromise = (async () => {
    const clientCode = process.env.ANGEL_CLIENT_CODE;
    const password = process.env.ANGEL_PASSWORD;
    const totpSecret = process.env.ANGEL_TOTP_SECRET;
    const apiKey = process.env.ANGEL_API_KEY;

    if (!clientCode || !password || !totpSecret || !apiKey) {
      throw new Error("Missing Angel One credentials");
    }

    const smartApi = new SmartAPI({ api_key: apiKey });
    const totpInfo = await TOTP.generate(totpSecret);
    const totp = typeof totpInfo === "string" ? totpInfo : totpInfo.otp;
    const session = await smartApi.generateSession(clientCode, password, totp);

    if (!session?.status) {
      throw new Error(session?.message || "Angel One login failed");
    }

    angelSmartApi = smartApi;
    angelSessionExpiresAt = Date.now() + 7 * 60 * 60 * 1000;
    console.log("[DATA] Angel One SmartAPI market-data login successful.");
    return smartApi;
  })();

  try {
    return await angelLoginPromise;
  } finally {
    angelLoginPromise = null;
  }
}

async function fetchAngelCandles(symbol: string): Promise<CandleData | null> {
  if (process.env.ANGEL_MARKET_DATA_ENABLED === "false") return null;

  if (!hasAngelMarketDataCredentials()) {
    if (!angelCredentialsWarningShown) {
      console.warn("[DATA] Angel One market data disabled: missing credentials.");
      angelCredentialsWarningShown = true;
    }
    return null;
  }

  const scripMap = await getAngelScripMap();
  const token = scripMap.get(symbol.toUpperCase().trim());
  if (!token) throw new Error(`No Angel One token found for ${symbol}`);

  const now = new Date();
  const from = new Date(now.getTime() - FETCH_LOOKBACK_CALENDAR_DAYS * 24 * 3600 * 1000);
  const smartApi = await getAngelSmartApi();
  const response = await smartApi.getCandleData({
    exchange: "NSE",
    symboltoken: token,
    interval: "FIVE_MINUTE",
    fromdate: formatAngelDate(from),
    todate: formatAngelDate(now),
  });

  if (!response?.status || !Array.isArray(response.data)) {
    throw new Error(response?.message || "Angel One returned no candle data");
  }

  const candles: Candle[] = [];
  for (const row of response.data as AngelCandleRow[]) {
    const epochSecs = parseAngelEpochSecs(row[0]);
    if (epochSecs === null) continue;

    candles.push({
      t: epochSecs,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    });
  }

  return buildCandleData(candles);
}

async function fetchMoneycontrolCandles(symbol: string): Promise<CandleData | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - FETCH_LOOKBACK_CALENDAR_DAYS * 24 * 3600;
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&countback=600&currencyCode=INR`;

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

  return buildCandleData(all);
}

async function fetchCandles(symbol: string): Promise<CandleData | null> {
  try {
    const angelCandles = await fetchAngelCandles(symbol);
    if (angelCandles) {
      console.log(`[DATA] ${symbol}: using Angel One SmartAPI candles.`);
      return angelCandles;
    }
  } catch (err) {
    console.warn(
      `[DATA] ${symbol}: Angel One candle fetch failed, falling back to Moneycontrol.`,
      err,
    );
  }

  const fallbackCandles = await fetchMoneycontrolCandles(symbol);
  if (fallbackCandles) {
    console.log(`[DATA] ${symbol}: using Moneycontrol fallback candles.`);
  }
  return fallbackCandles;
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
  alertEligible: boolean;
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
    alertEligible: false,
  };

  try {
    const today = getTodayISTDateStr();
    const isTradingDay = !isWeekendISTDate(today);
    const isEntryWindow = isEntrySignalWindowIST();

    // Check DB for existing signal today
    const existingTrades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.symbol, symbol), eq(tradesTable.date, today)))
      .limit(1);

    const existingTrade = existingTrades.length > 0 ? existingTrades[0] : null;

    const candleData = await fetchCandles(symbol);
    if (!candleData) return empty;

    const { sessionCandles, historicalCandles, lastTradingDate } = candleData;

    const confirmedSession = getConfirmedCandles(sessionCandles);
    const confirmedHistorical = getConfirmedCandles(historicalCandles);
    if (confirmedSession.length === 0) return empty;

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
    let alertEligible = false;

    const vwapR = vwap !== null ? r2(vwap) : null;
    const ema20R = ema20 !== null ? r2(ema20) : null;

    // Volume confirmation: compare last candle volume to positive-volume session average.
    // New entries require a real spike, not merely average participation.
    const volumeCandles = confirmedSession.filter((c) => c.v > 0);
    const avgVolume = volumeCandles.length > 0
      ? volumeCandles.reduce((sum, c) => sum + c.v, 0) / volumeCandles.length
      : 0;
    const lastVolume = last.v;
    const volumeRatio = avgVolume > 0 ? r2(lastVolume / avgVolume) : null;
    const volumeOk = volumeRatio !== null ? volumeRatio > 1.5 : null;

    if (existingTrade) {
      entrySignal = isEntryWindow;
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

      // ── Time Cutoff Check ────────────────────────────────────────────────
      // Intraday trades shouldn't be entered after 15:15 IST (09:45 UTC)
      // Angel One blocks new MIS orders after 15:15, so any signals after this are invalid.
      const candleDate = new Date(last.t * 1000);
      const candleHours = candleDate.getUTCHours();
      const candleMins = candleDate.getUTCMinutes();
      const isBeforeCutoff = candleHours < 9 || (candleHours === 9 && candleMins <= 45);

      const entrySignalCandidate =
        (isTradingDay && vwap !== null && ema20 !== null && lastTradingDate === today && isBeforeCutoff)
          ? confirmedClose > vwap && confirmedClose > ema20 && crossedVwapRecently && volumeOk === true
          : null;

      if (entrySignalCandidate && vwap !== null) {
        const tradeParams = computeTradeParams(confirmedClose, vwap);
        sl = tradeParams.sl;
        target1 = tradeParams.target1;
        target2 = tradeParams.target2;
        riskPct = tradeParams.riskPct;
        smartExit = tradeParams.smartExit;
        signalTime = candleDate.toISOString();

        try {
          const inserted = await db.insert(tradesTable).values({
            symbol,
            date: today,
            signalTime,
            entryPrice: String(confirmedClose),
            sl: String(sl),
            target1: String(target1),
            target2: String(target2),
            status: "PENDING"
          }).onConflictDoNothing().returning({ id: tradesTable.id });

          entrySignal = inserted.length > 0;
          alertEligible = inserted.length > 0;
        } catch (dbErr) {
          console.error(`Failed to persist generated trade signal for ${symbol}`, dbErr);
        }

        if (!entrySignal) {
          sl = null;
          target1 = null;
          target2 = null;
          riskPct = null;
          smartExit = null;
          signalTime = null;
        }
      }
    }

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
      alertEligible,
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
  const queue = items.map((item, index) => ({ item, index }));

  async function worker() {
    while (true) {
      const next = queue.shift();
      if (!next) return;
      results[next.index] = await fn(next.item);
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
      alertEligible: boolean;
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
            return change >= 0.3 && change < 2.0;
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
            const curKey = indicatorDate 
              ? `${indicatorDate}T${lastCandleTimeIST ?? "00:00"}`
              : "0000-00-00T00:00";
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
                  : ind.volumeRatio > 1.5 ? 1.5   // strong volume - confirmed breakout
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
                alertEligible: ind.alertEligible,
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
    const rankedTopPicks = topPickCandidates
      .sort((a, b) => b.score - a.score)
      .filter((p) => {
        if (seen.has(p.symbol)) return false;
        seen.add(p.symbol);
        return true;
      })
      .slice(0, 5);

    const todayIST = getTodayISTDateStr();
    const isLiveSession = indicatorDate === todayIST;
    const liveTopPicks = isLiveSession
      ? rankedTopPicks.map(({ score: _score, alertEligible: _alertEligible, ...rest }) => rest)
      : [];
    const alertPicks = isLiveSession
      ? rankedTopPicks
        .filter((pick) => pick.alertEligible)
        .map(({ score: _score, alertEligible: _alertEligible, ...rest }) => rest)
      : [];

    // Fire Telegram alerts for any new signals (non-blocking)
    sendTelegramAlerts(alertPicks, req.log).catch((err) =>
      req.log.error({ err }, "Telegram alert dispatch failed"),
    );

    return res.json({
      fetchedAt: new Date().toISOString(),
      indicatorDate,
      isLiveSession,
      lastCandleTimeIST,
      topPicks: liveTopPicks,
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
      const forceSquareOff = isIntradaySquareOffTimeIST();
      const persistTradeStatus = async (status: TradeStatus): Promise<boolean> => {
        try {
          await db.update(tradesTable)
            .set({ status })
            .where(eq(tradesTable.id, trade.id));
          return true;
        } catch (e) {
          req.log.error({ err: e, symbol: trade.symbol, status }, "Failed to update trade status");
          return false;
        }
      };

      const squareOffOpenTrade = async () => {
        if (trade.status !== "PENDING" && trade.status !== "ACTIVE") return null;

        const persisted = await persistTradeStatus("SQUARED OFF");
        if (!persisted) return { ...trade, hitTime: null };

        return { ...trade, status: "SQUARED OFF" as TradeStatus, hitTime: "15:15" };
      };

      const candleData = await fetchCandles(trade.symbol);
      if (!candleData) return forceSquareOff ? (await squareOffOpenTrade()) ?? { ...trade, hitTime: null } : { ...trade, hitTime: null };
      
      const signalTimeMs = new Date(trade.signalTime).getTime();
      if (Number.isNaN(signalTimeMs)) return forceSquareOff ? (await squareOffOpenTrade()) ?? { ...trade, hitTime: null } : { ...trade, hitTime: null };
      
      // Look at session candles that closed after the signal time (candle length is 5 mins = 300s)
      const postSignalCandles = getConfirmedCandles(candleData.sessionCandles)
        .filter(c => (c.t + CANDLE_INTERVAL_SECS) * 1000 > signalTimeMs);
      
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
      
      let newStatus: TradeStatus = trade.status === "PENDING" ? "ACTIVE" : trade.status;
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
      
      if (forceSquareOff && newStatus === "ACTIVE") {
        newStatus = "SQUARED OFF";
        const lastCandle = postSignalCandles[postSignalCandles.length - 1];
        if (lastCandle) {
          hitTime = getISTTimeStr(lastCandle.t);
        } else {
          hitTime = "15:15";
        }
      }
      
      if (newStatus !== trade.status) {
        const persisted = await persistTradeStatus(newStatus);
        if (!persisted) return { ...trade, hitTime: null };
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

    const candleDataCache = new Map<string, Promise<CandleData | null>>();
    function getCachedCandleData(symbol: string): Promise<CandleData | null> {
      const key = symbol.toUpperCase();
      let cached = candleDataCache.get(key);
      if (!cached) {
        cached = fetchCandles(symbol).catch((err) => {
          req.log.warn({ err, symbol }, "Failed to fetch candles for trade history P&L");
          return null;
        });
        candleDataCache.set(key, cached);
      }
      return cached;
    }

    async function computeSquareOffPlPct(trade: Trade, entry: number): Promise<number | null> {
      const signalTimeMs = new Date(trade.signalTime).getTime();
      if (Number.isNaN(signalTimeMs)) return null;

      const candleData = await getCachedCandleData(trade.symbol);
      if (!candleData) return null;

      const squareOffCandle = candleData.historicalCandles
        .filter((c) =>
          getISTDateStr(c.t) === trade.date &&
          getISTTimeStr(c.t) <= "15:15" &&
          (c.t + CANDLE_INTERVAL_SECS) * 1000 > signalTimeMs
        )
        .at(-1);

      return squareOffCandle ? r2(((squareOffCandle.c - entry) / entry) * 100) : null;
    }

    // Compute estimated P&L % based on the trade's final status.
    // For past sessions the status in the DB is already the final resolved value.
    async function computePlPct(trade: Trade): Promise<number | null> {
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
        case "SQUARED OFF":             return computeSquareOffPlPct(trade, entry);
        default:                        return null;  // ACTIVE / PENDING
      }
    }

    // Group trades by date
    const byDate = new Map<string, (typeof trades)[0][]>();
    for (const trade of trades) {
      if (!byDate.has(trade.date)) byDate.set(trade.date, []);
      byDate.get(trade.date)!.push(trade);
    }

    const daysData = await Promise.all(Array.from(byDate.entries()).map(async ([date, dayTrades]) => {
      const enriched = await Promise.all(dayTrades.map(async (t) => ({ ...t, plPct: await computePlPct(t) })));
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
    }));

    return res.json({ days: daysData });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch trade history");
    return res.status(500).json({ error: "Failed to fetch trade history" });
  }
});

export default router;
