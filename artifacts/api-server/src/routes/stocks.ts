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
const INTRADAY_SQUARE_OFF_TIME_IST = "15:15";
const ENTRY_SIGNAL_START_MIN_IST = 9 * 60 + 15;
const ENTRY_SIGNAL_END_MIN_IST = 15 * 60 + 15;
const MIN_ENTRY_SECTOR_CHANGE_PCT = 0;
const MIN_ENTRY_STOCK_CHANGE_PCT = 0;
const MAX_ENTRY_SCAN_SYMBOLS_PER_SECTOR = 4;
const MAX_DAILY_ENTRY_SIGNALS = 10;
const INDICATOR_LOOKBACK_TRADING_DAYS = 7;
const FETCH_LOOKBACK_CALENDAR_DAYS = 14;
const STRUCTURE_TIMEFRAME_SECS = 60 * 60;
const PIVOT_LEFT = 3;
const PIVOT_RIGHT = 3;
const STRUCTURE_SWING_LEN = 3;
const MERGE_ATR_MULT = 0.30;
const ZONE_ATR_MULT = 0.08;
const VOLUME_CONFIRMATION_MULTIPLIER = 1.15;
const SKIP_OPENING_BARS = 2;
const SIGNAL_COOLDOWN_BARS = 5;
const MIN_SIGNAL_RR = 1.2;
const SL_ATR_BUFFER_MULT = 0.12;
const FALLBACK_RISK_REWARD = 1.5;
const ANGEL_SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

type SignalDirection = "LONG" | "SHORT";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SmartApiRateLimiter {
  private nextAvailableAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const waitMs = Math.max(0, this.nextAvailableAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.nextAvailableAt = Date.now() + this.minIntervalMs;
      return task();
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

const smartApiLimiters = {
  loginByPassword: new SmartApiRateLimiter(1100), // Angel limit: 1 request/sec
  getCandleData: new SmartApiRateLimiter(360), // Angel limit: 3/sec and 180/min
};

interface PriceActionSignal {
  candle: Candle;
  confirmedClose: number;
  direction: SignalDirection;
  setup: string;
  sl: number;
  target1: number;
  target2: number;
  riskPct: number;
  rewardRisk: number;
  smartExit: string;
}

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

function getISTMinuteOfDay(epochSecs: number): number {
  const time = getISTTimeStr(epochSecs);
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function getCandleCloseTimeIST(candle: Candle): string {
  return getISTTimeStr(candle.t + CANDLE_INTERVAL_SECS);
}

function getCandleCloseDateIST(candle: Candle): string {
  return getISTDateStr(candle.t + CANDLE_INTERVAL_SECS);
}

function candleClosesBySquareOff(candle: Candle): boolean {
  return getCandleCloseTimeIST(candle) <= INTRADAY_SQUARE_OFF_TIME_IST;
}

function candleClosesInEntryWindow(candle: Candle): boolean {
  const mins = getISTMinuteOfDay(candle.t + CANDLE_INTERVAL_SECS);
  return mins >= ENTRY_SIGNAL_START_MIN_IST && mins <= ENTRY_SIGNAL_END_MIN_IST;
}

function isSignalTimeInEntryWindowIST(signalTime: string): boolean {
  const ms = Date.parse(signalTime);
  if (Number.isNaN(ms)) return false;
  const mins = getISTMinuteOfDay(Math.floor(ms / 1000));
  return mins >= ENTRY_SIGNAL_START_MIN_IST && mins <= ENTRY_SIGNAL_END_MIN_IST;
}

function filterEntryWindowTrades<T extends { date: string; signalTime: string }>(trades: T[]): T[] {
  const countsByDate = new Map<string, number>();
  return trades.filter((trade) => {
    if (!isSignalTimeInEntryWindowIST(trade.signalTime)) return false;

    const count = countsByDate.get(trade.date) ?? 0;
    if (count >= MAX_DAILY_ENTRY_SIGNALS) return false;

    countsByDate.set(trade.date, count + 1);
    return true;
  });
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
  return mins >= ENTRY_SIGNAL_START_MIN_IST && mins <= ENTRY_SIGNAL_END_MIN_IST;
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
  const now = Date.now();
  if (angelSmartApi && now < angelSessionExpiresAt) return angelSmartApi;
  if (angelLoginPromise) {
    if (!angelSmartApi || now < angelSessionExpiresAt) return angelLoginPromise;
    angelLoginPromise = null;
  }

  angelSmartApi = null;
  angelSessionExpiresAt = 0;

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
    const session: any = await smartApiLimiters.loginByPassword.schedule(() =>
      smartApi.generateSession(clientCode, password, totp)
    );

    if (!session?.status) {
      throw new Error(session?.message || "Angel One login failed");
    }

    angelSmartApi = smartApi;
    angelSessionExpiresAt = Date.now() + 7 * 60 * 60 * 1000;
    console.log("[DATA] Angel One SmartAPI market-data login successful.");
    return smartApi;
  })();

  angelLoginPromise = angelLoginPromise.catch((err) => {
    angelSmartApi = null;
    angelSessionExpiresAt = 0;
    angelLoginPromise = null;
    throw err;
  });

  return angelLoginPromise;
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
  const response: any = await smartApiLimiters.getCandleData.schedule(() =>
    smartApi.getCandleData({
      exchange: "NSE",
      symboltoken: token,
      interval: "FIVE_MINUTE",
      fromdate: formatAngelDate(from),
      todate: formatAngelDate(now),
    })
  );

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

function calculateVolumeRatio(candles: Candle[], lookback = 20): number | null {
  const last = candles.at(-1);
  if (!last || last.v <= 0) return null;

  const baselineVolumes = candles
    .slice(0, -1)
    .filter((c) => c.v > 0)
    .slice(-lookback)
    .map((c) => c.v);

  if (baselineVolumes.length < lookback) return null;

  const avgVolume = baselineVolumes.reduce((sum, volume) => sum + volume, 0) / baselineVolumes.length;
  return avgVolume > 0 ? r2(last.v / avgVolume) : null;
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

interface Level {
  price: number;
  touches: number;
}

interface SupportResistanceContext {
  resistanceLevels: Level[];
  supportLevels: Level[];
  zoneHalfWidth: number;
  mergeDistance: number;
}

function trueRange(candle: Candle, prevClose: number | null): number {
  if (prevClose === null) return candle.h - candle.l;
  return Math.max(
    candle.h - candle.l,
    Math.abs(candle.h - prevClose),
    Math.abs(candle.l - prevClose),
  );
}

function calculateATR(candles: Candle[], period = 14): number | null {
  if (candles.length < 2) return null;

  const trs = candles.map((c, i) =>
    trueRange(c, i > 0 ? candles[i - 1].c : null)
  );
  if (trs.length < period) {
    const avg = trs.reduce((sum, tr) => sum + tr, 0) / trs.length;
    return Number.isFinite(avg) && avg > 0 ? avg : null;
  }

  let atr = trs.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;
  }
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function istDateMinuteToEpochSecs(dateStr: string, minuteOfDay: number): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor((Date.UTC(y, m - 1, d, 0, minuteOfDay) - IST_OFFSET_MS) / 1000);
}

function aggregateCandles(candles: Candle[], timeframeSecs: number): Candle[] {
  const timeframeMins = timeframeSecs / 60;
  const buckets = new Map<string, Candle>();

  for (const candle of [...candles].sort((a, b) => a.t - b.t)) {
    const date = getISTDateStr(candle.t);
    const mins = getISTMinuteOfDay(candle.t);
    const relMins = Math.max(0, mins - ENTRY_SIGNAL_START_MIN_IST);
    const bucketIndex = Math.floor(relMins / timeframeMins);
    const bucketStartMins = ENTRY_SIGNAL_START_MIN_IST + bucketIndex * timeframeMins;
    const key = `${date}:${bucketIndex}`;
    const existing = buckets.get(key);

    if (!existing) {
      buckets.set(key, {
        t: istDateMinuteToEpochSecs(date, bucketStartMins),
        o: candle.o,
        h: candle.h,
        l: candle.l,
        c: candle.c,
        v: candle.v,
      });
    } else {
      existing.h = Math.max(existing.h, candle.h);
      existing.l = Math.min(existing.l, candle.l);
      existing.c = candle.c;
      existing.v += candle.v;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

function isPivotHigh(candles: Candle[], index: number, left: number, right: number): boolean {
  if (index < left || index + right >= candles.length) return false;
  const price = candles[index].h;
  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].h >= price) return false;
  }
  return true;
}

function isPivotLow(candles: Candle[], index: number, left: number, right: number): boolean {
  if (index < left || index + right >= candles.length) return false;
  const price = candles[index].l;
  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].l <= price) return false;
  }
  return true;
}

function addLevel(levels: Level[], level: number, maxCount: number, tolerance: number): void {
  for (const existing of levels) {
    if (Math.abs(existing.price - level) <= tolerance) {
      existing.price = ((existing.price * existing.touches) + level) / (existing.touches + 1);
      existing.touches += 1;
      return;
    }
  }

  levels.unshift({ price: level, touches: 1 });
  if (levels.length > maxCount) levels.pop();
}

function nthAbove(levels: Level[], referencePrice: number, rank = 1): number | null {
  const sorted = levels.map((l) => l.price).sort((a, b) => a - b);
  let found = 0;
  for (const level of sorted) {
    if (level > referencePrice) {
      found += 1;
      if (found === rank) return level;
    }
  }
  return null;
}

function nthBelow(levels: Level[], referencePrice: number, rank = 1): number | null {
  const sorted = levels.map((l) => l.price).sort((a, b) => b - a);
  let found = 0;
  for (const level of sorted) {
    if (level < referencePrice) {
      found += 1;
      if (found === rank) return level;
    }
  }
  return null;
}

function buildSupportResistanceContext(candles: Candle[]): SupportResistanceContext | null {
  const htfCandles = aggregateCandles(candles, STRUCTURE_TIMEFRAME_SECS);
  if (htfCandles.length < PIVOT_LEFT + PIVOT_RIGHT + 1) return null;

  const htfAtr = calculateATR(htfCandles) ?? calculateATR(candles);
  const lastClose = candles.at(-1)?.c ?? 1;
  const fallbackAtr = Math.max(lastClose * 0.003, 0.05);
  const atr = htfAtr ?? fallbackAtr;
  const mergeDistance = Math.max(atr * MERGE_ATR_MULT, 0.05);
  const zoneHalfWidth = Math.max(atr * ZONE_ATR_MULT, 0.25);
  const resistanceLevels: Level[] = [];
  const supportLevels: Level[] = [];

  for (let i = PIVOT_LEFT; i < htfCandles.length - PIVOT_RIGHT; i++) {
    if (isPivotHigh(htfCandles, i, PIVOT_LEFT, PIVOT_RIGHT)) {
      addLevel(resistanceLevels, htfCandles[i].h, 36, mergeDistance);
    }
    if (isPivotLow(htfCandles, i, PIVOT_LEFT, PIVOT_RIGHT)) {
      addLevel(supportLevels, htfCandles[i].l, 36, mergeDistance);
    }
  }

  return { resistanceLevels, supportLevels, zoneHalfWidth, mergeDistance };
}

function crossesOver(prev: number, current: number, level: number): boolean {
  return prev <= level && current > level;
}

function crossesUnder(prev: number, current: number, level: number): boolean {
  return prev >= level && current < level;
}

function buildPriceActionSignal(
  candle: Candle,
  direction: SignalDirection,
  setup: string,
  supportOrResistance: number,
  targetZone: number | null,
  zoneHalfWidth: number,
  chartAtr: number,
): PriceActionSignal | null {
  const entry = candle.c;
  const slBuffer = chartAtr * SL_ATR_BUFFER_MULT;
  const dir = direction === "LONG" ? 1 : -1;
  const sl =
    direction === "LONG"
      ? Math.min(candle.l, supportOrResistance - zoneHalfWidth) - slBuffer
      : Math.max(candle.h, supportOrResistance + zoneHalfWidth) + slBuffer;
  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk <= 0) return null;

  const validSrTarget =
    direction === "LONG"
      ? targetZone !== null && targetZone > entry
      : targetZone !== null && targetZone < entry;
  const target2 = validSrTarget
    ? targetZone!
    : entry + (risk * FALLBACK_RISK_REWARD * dir);
  const reward = Math.abs(target2 - entry);
  const rewardRisk = reward / risk;
  if (!Number.isFinite(rewardRisk) || rewardRisk < MIN_SIGNAL_RR) return null;

  const target1 = entry + (risk * dir);
  const riskPct = r2((risk / entry) * 100);
  const action = direction === "LONG" ? "BUY" : "SELL";
  const targetContext = direction === "LONG" ? "next resistance" : "next support";
  const invalidation =
    direction === "LONG"
      ? `Exit if price loses entry zone or hits SL (Rs ${r2(sl)}).`
      : `Exit if price reclaims entry zone or hits SL (Rs ${r2(sl)}).`;
  const smartExit =
    `${action} ${setup}. Entry Rs ${r2(entry)}. ` +
    `${invalidation} First scale near Rs ${r2(target1)}; final target is ${targetContext} near Rs ${r2(target2)}. ` +
    `Exit any open trade by 15:15 IST.`;

  return {
    candle,
    confirmedClose: entry,
    direction,
    setup,
    sl: r2(sl),
    target1: r2(target1),
    target2: r2(target2),
    riskPct,
    rewardRisk: r2(rewardRisk),
    smartExit,
  };
}

interface IndicatorResult {
  vwap: number | null;
  ema20: number | null;
  confirmedClose: number | null;
  entrySignal: boolean | null;
  direction: SignalDirection | null;
  setup: string | null;
  sl: number | null;
  target1: number | null;
  target2: number | null;
  riskPct: number | null;
  rewardRisk: number | null;
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

function findEntrySignalMatch(
  sessionCandles: Candle[],
  historicalCandles: Candle[],
  today: string,
  lastTradingDate: string,
  isTradingDay: boolean,
): PriceActionSignal | null {
  if (!isTradingDay || lastTradingDate !== today) return null;

  let lastStructHigh: number | null = null;
  let lastStructLow: number | null = null;
  let marketBias = 0;
  let lastSignalIndex = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sessionCandles.length; i++) {
    const candle = sessionCandles[i];
    if (getCandleCloseDateIST(candle) !== today || !candleClosesInEntryWindow(candle)) continue;

    const pivotIndex = i - STRUCTURE_SWING_LEN;
    if (isPivotHigh(sessionCandles, pivotIndex, STRUCTURE_SWING_LEN, STRUCTURE_SWING_LEN)) {
      lastStructHigh = sessionCandles[pivotIndex].h;
    }
    if (isPivotLow(sessionCandles, pivotIndex, STRUCTURE_SWING_LEN, STRUCTURE_SWING_LEN)) {
      lastStructLow = sessionCandles[pivotIndex].l;
    }

    const prevClose = i > 0 ? sessionCandles[i - 1].c : candle.o;
    const breakUpStruct = lastStructHigh !== null && crossesOver(prevClose, candle.c, lastStructHigh);
    const breakDownStruct = lastStructLow !== null && crossesUnder(prevClose, candle.c, lastStructLow);
    if (breakUpStruct) marketBias = 1;
    if (breakDownStruct) marketBias = -1;

    if (i < SKIP_OPENING_BARS || i - lastSignalIndex <= SIGNAL_COOLDOWN_BARS) continue;

    const sessionThroughCandle = sessionCandles.filter((c) => c.t <= candle.t);
    const historicalThroughCandle = historicalCandles.filter((c) => c.t <= candle.t);
    const srContext = buildSupportResistanceContext(historicalThroughCandle);
    if (!srContext) continue;

    const vwap = calculateVWAP(sessionThroughCandle);
    const ema20 = calculateEMA(historicalThroughCandle.map((c) => c.c));
    const volumeRatio = calculateVolumeRatio(historicalThroughCandle);
    const chartAtr = calculateATR(historicalThroughCandle) ?? Math.max(candle.c * 0.003, 0.05);
    const volumeOk = volumeRatio === null || volumeRatio >= VOLUME_CONFIRMATION_MULTIPLIER;
    if (vwap === null || ema20 === null || !volumeOk) continue;

    const buyTrendOk = candle.c > ema20 && candle.c > vwap;
    const sellTrendOk = candle.c < ema20 && candle.c < vwap;
    const buyBiasAllowed = marketBias >= 0;
    const sellBiasAllowed = marketBias <= 0;
    const { resistanceLevels, supportLevels, zoneHalfWidth } = srContext;
    const r1 = nthAbove(resistanceLevels, candle.c, 1);
    const s1 = nthBelow(supportLevels, candle.c, 1);
    const r1Signal = nthAbove(resistanceLevels, prevClose, 1);
    const s1Signal = nthBelow(supportLevels, prevClose, 1);

    const body = Math.abs(candle.c - candle.o);
    const upperWick = candle.h - Math.max(candle.o, candle.c);
    const lowerWick = Math.min(candle.o, candle.c) - candle.l;
    const nearSupport = s1 !== null && candle.l <= s1 + zoneHalfWidth && candle.c > s1;
    const nearResistance = r1 !== null && candle.h >= r1 - zoneHalfWidth && candle.c < r1;

    const bullishRejection =
      buyBiasAllowed &&
      buyTrendOk &&
      nearSupport &&
      candle.c > candle.o &&
      lowerWick > body;
    const bearishRejection =
      sellBiasAllowed &&
      sellTrendOk &&
      nearResistance &&
      candle.c < candle.o &&
      upperWick > body;
    const breakout =
      buyBiasAllowed &&
      buyTrendOk &&
      r1Signal !== null &&
      crossesOver(prevClose, candle.c, r1Signal + zoneHalfWidth) &&
      candle.c > candle.o;
    const breakdown =
      sellBiasAllowed &&
      sellTrendOk &&
      s1Signal !== null &&
      crossesUnder(prevClose, candle.c, s1Signal - zoneHalfWidth) &&
      candle.c < candle.o;

    let signal: PriceActionSignal | null = null;
    if (bullishRejection && s1 !== null) {
      signal = buildPriceActionSignal(
        candle,
        "LONG",
        "SUPPORT BUY REJECTION",
        s1,
        r1,
        zoneHalfWidth,
        chartAtr,
      );
    } else if (breakout && r1Signal !== null) {
      signal = buildPriceActionSignal(
        candle,
        "LONG",
        marketBias === 1 ? "BOS UP + RESISTANCE BREAKOUT" : "RESISTANCE BREAKOUT",
        r1Signal,
        r1,
        zoneHalfWidth,
        chartAtr,
      );
    } else if (bearishRejection && r1 !== null) {
      signal = buildPriceActionSignal(
        candle,
        "SHORT",
        "RESISTANCE SELL REJECTION",
        r1,
        s1,
        zoneHalfWidth,
        chartAtr,
      );
    } else if (breakdown && s1Signal !== null) {
      signal = buildPriceActionSignal(
        candle,
        "SHORT",
        marketBias === -1 ? "BOS DOWN + SUPPORT BREAKDOWN" : "SUPPORT BREAKDOWN",
        s1Signal,
        s1,
        zoneHalfWidth,
        chartAtr,
      );
    }

    if (signal) {
      lastSignalIndex = i;
      return signal;
    }
  }

  return null;
}

async function enrichWithIndicators(symbol: string): Promise<IndicatorResult> {
  const empty: IndicatorResult = {
    vwap: null,
    ema20: null,
    confirmedClose: null,
    entrySignal: null,
    direction: null,
    setup: null,
    sl: null,
    target1: null,
    target2: null,
    riskPct: null,
    rewardRisk: null,
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

    const firstExistingTrade = existingTrades[0] ?? null;
    const existingTrade = existingTrades.find((trade) =>
      isSignalTimeInEntryWindowIST(trade.signalTime)
    ) ?? null;
    const invalidExistingTrade =
      firstExistingTrade && !isSignalTimeInEntryWindowIST(firstExistingTrade.signalTime)
        ? firstExistingTrade
        : null;

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
    let rewardRisk: number | null = null;
    let smartExit: string | null = null;
    let signalTime: string | null = null;
    let entrySignal: boolean | null = null;
    let direction: SignalDirection | null = null;
    let setup: string | null = null;
    let alertEligible = false;

    const vwapR = vwap !== null ? r2(vwap) : null;
    const ema20R = ema20 !== null ? r2(ema20) : null;

    // Volume confirmation mirrors the S/R script: latest volume >= 1.15x recent average.
    const volumeRatio = calculateVolumeRatio(confirmedHistorical);
    const volumeOk = volumeRatio !== null ? volumeRatio >= VOLUME_CONFIRMATION_MULTIPLIER : null;

    if (existingTrade) {
      entrySignal = isEntryWindow && (existingTrade.status === "PENDING" || existingTrade.status === "ACTIVE");
      sl = Number(existingTrade.sl);
      target1 = Number(existingTrade.target1);
      target2 = Number(existingTrade.target2);

      const entryPrice = Number(existingTrade.entryPrice);
      direction = target2 < entryPrice || sl > entryPrice ? "SHORT" : "LONG";
      setup = "SAVED PRICE ACTION S/R SIGNAL";
      const risk = Math.abs(entryPrice - sl);
      const reward = Math.abs(target2 - entryPrice);
      riskPct = r2((risk / entryPrice) * 100);
      rewardRisk = risk > 0 ? r2(reward / risk) : null;
      signalTime = existingTrade.signalTime;
      smartExit = `[SAVED] ${direction} S/R setup entered at Rs ${entryPrice}. SL Rs ${sl}; target Rs ${target2}; square off by 15:15 IST.`;

      // Override confirmedClose so the UI shows the saved entry price
      confirmedClose = entryPrice;
    } else {
      const entryMatch = findEntrySignalMatch(
        confirmedSession,
        confirmedHistorical,
        today,
        lastTradingDate,
        isTradingDay,
      );
      if (entryMatch) {
        sl = entryMatch.sl;
        target1 = entryMatch.target1;
        target2 = entryMatch.target2;
        riskPct = entryMatch.riskPct;
        rewardRisk = entryMatch.rewardRisk;
        smartExit = entryMatch.smartExit;
        direction = entryMatch.direction;
        setup = entryMatch.setup;
        signalTime = new Date((entryMatch.candle.t + CANDLE_INTERVAL_SECS) * 1000).toISOString();
        confirmedClose = entryMatch.confirmedClose;

        try {
          const entryWindowTrades = filterEntryWindowTrades(
            await db
              .select()
              .from(tradesTable)
              .where(eq(tradesTable.date, today))
              .orderBy(tradesTable.signalTime)
          );

          if (entryWindowTrades.length >= MAX_DAILY_ENTRY_SIGNALS) {
            entrySignal = false;
          } else if (invalidExistingTrade) {
            await db.update(tradesTable)
              .set({
                signalTime,
                entryPrice: String(entryMatch.confirmedClose),
                sl: String(sl),
                target1: String(target1),
                target2: String(target2),
                status: "PENDING",
              })
              .where(eq(tradesTable.id, invalidExistingTrade.id));
            entrySignal = true;
            alertEligible = isEntryWindow;
          } else {
            const inserted = await db.insert(tradesTable).values({
              symbol,
              date: today,
              signalTime,
              entryPrice: String(entryMatch.confirmedClose),
              sl: String(sl),
              target1: String(target1),
              target2: String(target2),
              status: "PENDING"
            }).onConflictDoNothing().returning({ id: tradesTable.id });

            entrySignal = inserted.length > 0;
            alertEligible = inserted.length > 0 && isEntryWindow;
          }
        } catch (dbErr) {
          console.error(`Failed to persist generated trade signal for ${symbol}`, dbErr);
        }

        if (!entrySignal) {
          sl = null;
          target1 = null;
          target2 = null;
          riskPct = null;
          rewardRisk = null;
          smartExit = null;
          direction = null;
          setup = null;
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
      direction,
      setup,
      sl,
      target1,
      target2,
      riskPct,
      rewardRisk,
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

function inferTradeDirectionFromPrices(entry: number, sl: number, target2: number): SignalDirection {
  return target2 < entry || sl > entry ? "SHORT" : "LONG";
}

function plPctForExit(entry: number, exit: number, direction: SignalDirection): number {
  return direction === "LONG"
    ? r2(((exit - entry) / entry) * 100)
    : r2(((entry - exit) / entry) * 100);
}

function entryInvalidationHalfWidth(candleData: CandleData, signalTimeMs: number): number | null {
  const historicalThroughSignal = candleData.historicalCandles.filter(
    (c) => (c.t + CANDLE_INTERVAL_SECS) * 1000 <= signalTimeMs,
  );
  return buildSupportResistanceContext(historicalThroughSignal)?.zoneHalfWidth ?? null;
}

function isEntryInvalidated(
  candle: Candle,
  entry: number,
  direction: SignalDirection,
  zoneHalfWidth: number | null,
): boolean {
  if (zoneHalfWidth === null) return false;
  return direction === "LONG"
    ? candle.c < entry - zoneHalfWidth
    : candle.c > entry + zoneHalfWidth;
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
      .filter((sector) => Math.abs(sector.changePct) >= MIN_ENTRY_SECTOR_CHANGE_PCT)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
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
      rewardRisk: number;
      direction: SignalDirection;
      setup: string;
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
            return Math.abs(change) >= MIN_ENTRY_STOCK_CHANGE_PCT && Math.abs(change) < 5.0;
          })
            .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
            .slice(0, MAX_ENTRY_SCAN_SYMBOLS_PER_SECTOR);

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
              ind.rewardRisk !== null &&
              ind.direction !== null &&
              ind.setup !== null &&
              ind.smartExit !== null &&
              ind.vwap !== null &&
              ind.ema20 !== null
            ) {
              // Rank S/R setups by RR first, then directional move and volume.
              const directionalMove =
                ind.direction === "LONG" ? stock.changePct : -stock.changePct;
              const priceActionVolumeBonus =
                ind.volumeRatio === null ? 0
                  : ind.volumeRatio >= VOLUME_CONFIRMATION_MULTIPLIER ? 1.0
                    : ind.volumeRatio >= 1.0 ? 0.25
                      : -0.8;
              const priceActionScore =
                ind.rewardRisk * 2
                + Math.max(0, directionalMove) * 0.8
                + priceActionVolumeBonus;

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
                rewardRisk: ind.rewardRisk,
                direction: ind.direction,
                setup: ind.setup,
                smartExit: ind.smartExit,
                vwap: ind.vwap,
                ema20: ind.ema20,
                sparkline: ind.sparkline,
                circuitLimit: ind.circuitLimit,
                volumeRatio: ind.volumeRatio,
                volumeOk: ind.volumeOk,
                signalTime: ind.signalTime,
                alertEligible: ind.alertEligible,
                score: priceActionScore,
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
              direction: ind.direction,
              setup: ind.setup,
              sl: ind.sl,
              target1: ind.target1,
              target2: ind.target2,
              riskPct: ind.riskPct,
              rewardRisk: ind.rewardRisk,
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
    req.log.error({ err }, "Failed to fetch price-action picks");
    return res.status(500).json({ error: "Failed to fetch price-action picks" });
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
    trades = filterEntryWindowTrades(trades);

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
        if (trade.status !== "PENDING" && trade.status !== "ACTIVE" && trade.status !== "TARGET 1 HIT") return null;

        const persisted = await persistTradeStatus("SQUARED OFF");
        if (!persisted) return { ...trade, hitTime: null };

        return { ...trade, status: "SQUARED OFF" as TradeStatus, hitTime: "15:15" };
      };

      const candleData = await fetchCandles(trade.symbol);
      if (!candleData) return forceSquareOff ? (await squareOffOpenTrade()) ?? { ...trade, hitTime: null } : { ...trade, hitTime: null };
      
      const signalTimeMs = new Date(trade.signalTime).getTime();
      if (Number.isNaN(signalTimeMs)) return forceSquareOff ? (await squareOffOpenTrade()) ?? { ...trade, hitTime: null } : { ...trade, hitTime: null };
      
      const confirmedSessionCandles = getConfirmedCandles(candleData.sessionCandles);
      const statusCandles = forceSquareOff
        ? confirmedSessionCandles.filter(candleClosesBySquareOff)
        : confirmedSessionCandles;
      const vwapByCandleStart = new Map<number, number>();
      for (let i = 0; i < statusCandles.length; i++) {
        const vwapAtCandle = calculateVWAP(statusCandles.slice(0, i + 1));
        if (vwapAtCandle !== null) vwapByCandleStart.set(statusCandles[i].t, vwapAtCandle);
      }

      // Look at session candles that closed after the signal time (candle length is 5 mins = 300s)
      const postSignalCandles = statusCandles
        .filter(c => (c.t + CANDLE_INTERVAL_SECS) * 1000 > signalTimeMs);
      
      let hitTime: string | null = null;
      
      const target1 = Number(trade.target1);
      const target2 = Number(trade.target2);
      const entryPrice = Number(trade.entryPrice);
      const originalSl = Number(trade.sl);
      const direction = inferTradeDirectionFromPrices(entryPrice, originalSl, target2);
      const invalidationHalfWidth = entryInvalidationHalfWidth(candleData, signalTimeMs);
      const hitsTarget = (c: Candle, target: number) =>
        direction === "LONG" ? c.h >= target : c.l <= target;
      const hitsStop = (c: Candle, stop: number) =>
        direction === "LONG" ? c.l <= stop : c.h >= stop;
      const vwapExitHit = (c: Candle) => {
        const candleVwap = vwapByCandleStart.get(c.t);
        if (candleVwap === undefined) return false;
        return direction === "LONG" ? c.c < candleVwap : c.c > candleVwap;
      };
      
      let newStatus: TradeStatus = "ACTIVE";
      let maxTargetReached = 0;
      
      for (const c of postSignalCandles) {
        if (maxTargetReached >= 1) {
          if (hitsTarget(c, target2)) {
            newStatus = "TARGET 2 HIT";
            hitTime = getISTTimeStr(c.t);
            break;
          }

          if (hitsStop(c, entryPrice)) {
            newStatus = "T1 HIT & TRAILING SL HIT";
            hitTime = getISTTimeStr(c.t);
            break;
          }

          continue;
        }

        if (hitsStop(c, originalSl)) {
          newStatus = "SL HIT";
          hitTime = getISTTimeStr(c.t);
          break;
        }

        if (hitsTarget(c, target2)) {
          newStatus = "TARGET 2 HIT";
          hitTime = getISTTimeStr(c.t);
          break;
        }
        if (maxTargetReached < 1 && isEntryInvalidated(c, entryPrice, direction, invalidationHalfWidth)) {
          newStatus = "ENTRY INVALID";
          hitTime = getISTTimeStr(c.t);
          break;
        }
        if (hitsTarget(c, target1) && maxTargetReached < 1) {
          maxTargetReached = 1;
          newStatus = "TARGET 1 HIT";
          hitTime = getISTTimeStr(c.t);
        }
      }
      
      if (forceSquareOff && (newStatus === "ACTIVE" || newStatus === "TARGET 1 HIT")) {
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
      
      return { ...trade, status: newStatus, direction, hitTime };
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

    const trades = filterEntryWindowTrades(await db
      .select()
      .from(tradesTable)
      .where(gte(tradesTable.date, startDate))
      .orderBy(desc(tradesTable.date), tradesTable.signalTime));

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

    function getTradeExitCandles(candleData: CandleData, trade: Trade, signalTimeMs: number): Candle[] {
      return candleData.historicalCandles
        .filter((c) =>
          getCandleCloseDateIST(c) === trade.date &&
          candleClosesBySquareOff(c) &&
          (c.t + CANDLE_INTERVAL_SECS) * 1000 > signalTimeMs
        )
        .sort((a, b) => a.t - b.t);
    }

    async function resolveHistoricalTradeOutcome(trade: Trade): Promise<{
      status: TradeStatus;
      direction: SignalDirection;
      hitTime: string | null;
      plPct: number | null;
    }> {
      const entry = Number(trade.entryPrice);
      const sl    = Number(trade.sl);
      const t1    = Number(trade.target1);
      const t2    = Number(trade.target2);
      const direction = inferTradeDirectionFromPrices(entry, sl, t2);
      if (!entry || !Number.isFinite(sl) || !Number.isFinite(t1) || !Number.isFinite(t2)) {
        return { status: trade.status as TradeStatus, direction, hitTime: null, plPct: null };
      }

      const signalTimeMs = new Date(trade.signalTime).getTime();
      if (Number.isNaN(signalTimeMs)) {
        return { status: trade.status as TradeStatus, direction, hitTime: null, plPct: null };
      }

      const candleData = await getCachedCandleData(trade.symbol);
      if (!candleData) {
        return { status: trade.status as TradeStatus, direction, hitTime: null, plPct: null };
      }

      const postSignalCandles = getTradeExitCandles(candleData, trade, signalTimeMs);
      const invalidationHalfWidth = entryInvalidationHalfWidth(candleData, signalTimeMs);
      const hitsTarget = (c: Candle, target: number) =>
        direction === "LONG" ? c.h >= target : c.l <= target;
      const hitsStop = (c: Candle, stop: number) =>
        direction === "LONG" ? c.l <= stop : c.h >= stop;

      let status: TradeStatus = "ACTIVE";
      let hitTime: string | null = null;
      let exitPrice: number | null = null;
      let maxTargetReached = 0;

      for (const c of postSignalCandles) {
        if (maxTargetReached >= 1) {
          if (hitsTarget(c, t2)) {
            status = "TARGET 2 HIT";
            hitTime = getISTTimeStr(c.t);
            exitPrice = t2;
            break;
          }

          if (hitsStop(c, entry)) {
            status = "T1 HIT & TRAILING SL HIT";
            hitTime = getISTTimeStr(c.t);
            exitPrice = entry;
            break;
          }

          continue;
        }

        if (hitsStop(c, sl)) {
          status = "SL HIT";
          hitTime = getISTTimeStr(c.t);
          exitPrice = sl;
          break;
        }

        if (hitsTarget(c, t2)) {
          status = "TARGET 2 HIT";
          hitTime = getISTTimeStr(c.t);
          exitPrice = t2;
          break;
        }

        if (isEntryInvalidated(c, entry, direction, invalidationHalfWidth)) {
          status = "ENTRY INVALID";
          hitTime = getISTTimeStr(c.t);
          exitPrice = c.c;
          break;
        }

        if (hitsTarget(c, t1)) {
          maxTargetReached = 1;
          status = "TARGET 1 HIT";
          hitTime = getISTTimeStr(c.t);
          exitPrice = t1;
        }
      }

      const today = getTodayISTDateStr();
      const shouldSquareOff = trade.date < today || (trade.date === today && isIntradaySquareOffTimeIST());
      if (shouldSquareOff && (status === "ACTIVE" || status === "TARGET 1 HIT")) {
        const squareOffCandle = postSignalCandles.at(-1);
        status = "SQUARED OFF";
        hitTime = squareOffCandle ? getISTTimeStr(squareOffCandle.t) : "15:15";
        exitPrice = squareOffCandle?.c ?? exitPrice;
      }

      const plPct = exitPrice !== null ? plPctForExit(entry, exitPrice, direction) : null;

      if (status !== trade.status) {
        try {
          await db.update(tradesTable)
            .set({ status })
            .where(eq(tradesTable.id, trade.id));
        } catch (e) {
          req.log.error({ err: e, symbol: trade.symbol, status }, "Failed to update corrected history trade status");
        }
      }

      return { status, direction, hitTime, plPct };
    }

    // Group trades by date
    const byDate = new Map<string, (typeof trades)[0][]>();
    for (const trade of trades) {
      if (!byDate.has(trade.date)) byDate.set(trade.date, []);
      byDate.get(trade.date)!.push(trade);
    }

    const daysData = await Promise.all(Array.from(byDate.entries()).map(async ([date, dayTrades]) => {
      const enriched = await Promise.all(dayTrades.map(async (t) => {
        const outcome = await resolveHistoricalTradeOutcome(t);
        return {
          ...t,
          status: outcome.status,
          direction: outcome.direction,
          hitTime: outcome.hitTime,
          plPct: outcome.plPct,
        };
      }));
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
