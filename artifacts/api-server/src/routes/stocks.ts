import { Router } from "express";
import { sendTelegramAlerts } from "../notifications.js";
import { SWING_SECTORS, SWING_SECTOR_NAMES } from "../swing-universe.js";
import {
  db,
  pool,
  type Trade,
  type TradeStatus,
  tradesTable,
} from "@workspace/db";
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
const CURRENT_STRATEGY_EFFECTIVE_AT_MS = Date.parse("2026-06-19T09:41:31.000Z");
const MIN_ENTRY_SECTOR_CHANGE_PCT = 0;
const MIN_ENTRY_STOCK_CHANGE_PCT = 0;
const MIN_ENTRY_PRICE = 100;
const MAX_ENTRY_SCAN_SYMBOLS_PER_SECTOR = 4;
const MAX_DAILY_ENTRY_SIGNALS = 10;
const DEFAULT_SWING_PICK_LIMIT = 5;
const SWING_FETCH_LOOKBACK_CALENDAR_DAYS = 560;
const SWING_MIN_PRICE = 100;
const SWING_MIN_SCORE = 70;
const SWING_MIN_SIGNAL_SCORE = 4;
const SWING_MAX_ENTRY_GAP_PCT = 3.0;
const SWING_MIN_AVG_TURNOVER = 10_000_000 * 10;
const SWING_MIN_SECTOR_RELATIVE_STRENGTH = 0.25;
const SWING_MIN_PULLBACK_GAP_PCT = 0.5;
const SWING_MIN_CONSOLIDATION_CANDLES = 3;
const SWING_EXPECTED_HOLD_DAYS = 8;
const SWING_NIFTY_TOKEN = "99926000";
const MAX_SWING_SCAN_JOBS = 8;
const INDICATOR_LOOKBACK_TRADING_DAYS = 7;
const FETCH_LOOKBACK_CALENDAR_DAYS = 14;
const STRUCTURE_TIMEFRAME_SECS = 60 * 60;
const PIVOT_LEFT = 3;
const PIVOT_RIGHT = 3;
const STRUCTURE_SWING_LEN = 3;
const MERGE_ATR_MULT = 0.30;
const ZONE_ATR_MULT = 0.08;
const POWER_CHANNEL_LENGTH = 130;
const POWER_CHANNEL_ATR_PERIOD = 200;
const POWER_CHANNEL_ATR_MULT = 0.5;
const POWER_CHANNEL_SL_BUFFER_MULT = 0.05;
const POWER_CHANNEL_MAX_ENTRY_EXTENSION_MULT = 0.25;
const FRESH_SIGNAL_LOOKBACK_BARS = 2;
const POWER_CHANNEL_CHOP_LOOKBACK_BARS = 8;
const POWER_CHANNEL_MAX_CHOP_ZONE_TOUCHES = 3;
const POWER_CHANNEL_MIN_IMPULSE_BODY_RATIO = 0.35;
const POWER_CHANNEL_MIN_IMPULSE_CLOSE_POSITION = 0.65;
const VOLUME_CONFIRMATION_MULTIPLIER = 1.15;
const SKIP_OPENING_BARS = 2;
const MIN_SIGNAL_RR = 1.2;
const T1_SCALE_OUT_FRACTION = 0.5;
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
let swingTradesTableReady: Promise<void> | null = null;
let activeSwingScanJobId: string | null = null;
const swingScanJobs = new Map<string, SwingScanJob>();

interface SwingUniverseStock {
  symbol: string;
  sectorName: string;
  ltp: number;
  changePct: number;
}

interface SwingCandidate {
  symbol: string;
  sector: string;
  signalTime: string;
  currentPrice: number;
  entryPrice: number;
  sl: number;
  target: number;
  score: number;
  signalScore: number;
  grade: string;
  setup: string;
  entryType: "BREAKOUT" | "PULLBACK";
  reason: string;
  expectedHoldDays: number;
  recentReturn: number;
  relativeStrength: number;
  sectorRelativeStrength: number;
  rvol: number;
  avgTurnover: number;
  entryDistancePct: number;
  rewardRisk: number;
  breakoutQuality: string;
  trendPersistence: number;
  freshBreakoutAge: number | null;
  consolidationCandles: number;
}

interface SwingScannerResult {
  fetchedAt: string;
  date: string;
  selectedSectors: string[];
  sectorCount: number;
  universeCount: number;
  candidateCount: number;
  savedCount: number;
  niftyReturn: number;
  picks: SwingCandidate[];
}

type SwingScanJobStatus = "queued" | "running" | "completed" | "failed";

interface SwingScanJob {
  id: string;
  status: SwingScanJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  selectedSectors: string[];
  sectorCount: number;
  universeCount: number;
  processedCount: number;
  candidateCount: number;
  savedCount: number;
  limit: number;
  message: string;
  error: string | null;
  result: SwingScannerResult | null;
}

type SwingTradeStatus = "WATCHLIST" | "ACTIVE" | "TARGET HIT" | "SL HIT" | "EXIT REVIEW" | "CLOSED";

interface PersistedSwingTrade {
  id: number;
  symbol: string;
  date: string;
  signalTime: string;
  sector: string | null;
  direction: string;
  entryType: "BREAKOUT" | "PULLBACK";
  currentPrice: string;
  entryPrice: string;
  sl: string;
  target: string;
  score: string;
  grade: string;
  setup: string;
  reason: string | null;
  expectedHoldDays: string;
  status: SwingTradeStatus;
  entryHitDate: string | null;
  exitDate: string | null;
  lastPrice: string | null;
  lastCheckedAt: string | null;
}

interface SwingTrackerTrade extends PersistedSwingTrade {
  plPct: number | null;
  daysOpen: number | null;
}

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

function isCurrentStrategySignalTime(signalTime: string): boolean {
  const ms = Date.parse(signalTime);
  return !Number.isNaN(ms) && ms >= CURRENT_STRATEGY_EFFECTIVE_AT_MS;
}

function isCurrentStrategyEntrySignal(signalTime: string): boolean {
  return isCurrentStrategySignalTime(signalTime) && isSignalTimeInEntryWindowIST(signalTime);
}

function filterEntryWindowTrades<T extends { date: string; signalTime: string }>(trades: T[]): T[] {
  const countsByDate = new Map<string, number>();
  return trades.filter((trade) => {
    if (!isCurrentStrategyEntrySignal(trade.signalTime)) return false;

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

interface PowerChannelContext {
  supportTop: number;
  supportBottom: number;
  resistanceTop: number;
  resistanceBottom: number;
  mid: number;
  atrBand: number;
  buyPower: number;
  sellPower: number;
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

function buildPowerChannelContext(candles: Candle[]): PowerChannelContext | null {
  if (candles.length < POWER_CHANNEL_LENGTH) return null;

  const lookback = candles.slice(-POWER_CHANNEL_LENGTH);
  const highestHigh = Math.max(...lookback.map((c) => c.h));
  const lowestLow = Math.min(...lookback.map((c) => c.l));
  if (!Number.isFinite(highestHigh) || !Number.isFinite(lowestLow) || highestHigh <= lowestLow) {
    return null;
  }

  const fallbackAtr = Math.max((candles.at(-1)?.c ?? 1) * 0.003, 0.05);
  const atrBand = Math.max(
    (calculateATR(candles, POWER_CHANNEL_ATR_PERIOD) ?? fallbackAtr) * POWER_CHANNEL_ATR_MULT,
    0.05,
  );
  const buyPower = lookback.filter((c) => c.c > c.o).length;
  const sellPower = lookback.filter((c) => c.c < c.o).length;

  return {
    supportTop: lowestLow + atrBand,
    supportBottom: lowestLow - atrBand,
    resistanceTop: highestHigh + atrBand,
    resistanceBottom: highestHigh - atrBand,
    mid: (highestHigh + lowestLow) / 2,
    atrBand,
    buyPower,
    sellPower,
  };
}

function touchesPowerChannelZone(
  candle: Candle,
  direction: SignalDirection,
  channel: PowerChannelContext,
): boolean {
  return direction === "LONG"
    ? candle.l <= channel.supportTop && candle.h >= channel.supportBottom
    : candle.h >= channel.resistanceBottom && candle.l <= channel.resistanceTop;
}

function hasDirectionalImpulse(candle: Candle, direction: SignalDirection): boolean {
  const range = candle.h - candle.l;
  if (!Number.isFinite(range) || range <= 0) return false;

  const bodyRatio = Math.abs(candle.c - candle.o) / range;
  const closePosition = direction === "LONG"
    ? (candle.c - candle.l) / range
    : (candle.h - candle.c) / range;
  const candleColorOk = direction === "LONG"
    ? candle.c >= candle.o
    : candle.c <= candle.o;

  return candleColorOk &&
    bodyRatio >= POWER_CHANNEL_MIN_IMPULSE_BODY_RATIO &&
    closePosition >= POWER_CHANNEL_MIN_IMPULSE_CLOSE_POSITION;
}

function isPowerChannelChop(
  recentCandles: Candle[],
  direction: SignalDirection,
  channel: PowerChannelContext,
): boolean {
  const signalCandle = recentCandles.at(-1);
  if (!signalCandle) return false;

  const previousTouches = recentCandles
    .slice(0, -1)
    .filter((candle) => touchesPowerChannelZone(candle, direction, channel))
    .length;

  return previousTouches >= POWER_CHANNEL_MAX_CHOP_ZONE_TOUCHES &&
    !hasDirectionalImpulse(signalCandle, direction);
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
  const invalidation = `Exit if price closes halfway back toward SL or hits SL (Rs ${r2(sl)}).`;
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

function buildPowerChannelSignal(
  candle: Candle,
  direction: SignalDirection,
  channel: PowerChannelContext,
): PriceActionSignal | null {
  const entry = candle.c;
  const dir = direction === "LONG" ? 1 : -1;
  const entryExtension = direction === "LONG"
    ? entry - channel.supportTop
    : channel.resistanceBottom - entry;
  const maxEntryExtension = Math.max(
    channel.atrBand * POWER_CHANNEL_MAX_ENTRY_EXTENSION_MULT,
    0.05,
  );
  if (
    !Number.isFinite(entryExtension) ||
    entryExtension < 0 ||
    entryExtension > maxEntryExtension
  ) {
    return null;
  }

  const buffer = Math.max(channel.atrBand * POWER_CHANNEL_SL_BUFFER_MULT, 0.05);
  const sl = direction === "LONG"
    ? channel.supportBottom - buffer
    : channel.resistanceTop + buffer;
  const target2 = direction === "LONG"
    ? channel.resistanceBottom
    : channel.supportTop;

  const validTarget = direction === "LONG" ? target2 > entry : target2 < entry;
  if (!validTarget) return null;

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(target2 - entry);
  const rewardRisk = reward / risk;
  if (!Number.isFinite(risk) || risk <= 0 || !Number.isFinite(rewardRisk) || rewardRisk < MIN_SIGNAL_RR) {
    return null;
  }

  const target1 = entry + (risk * dir);
  const setup = direction === "LONG"
    ? "POWER CHANNEL BUY REACTION"
    : "POWER CHANNEL SELL REJECTION";
  const action = direction === "LONG" ? "BUY" : "SELL";
  const oppositeZone = direction === "LONG" ? "resistance zone" : "support zone";
  const powerText = direction === "LONG"
    ? `Buy Power ${channel.buyPower}`
    : `Sell Power ${channel.sellPower}`;
  const smartExit =
    `${action} ${setup}. ${powerText}. Entry Rs ${r2(entry)}. ` +
    `SL outside the ChartPrime zone at Rs ${r2(sl)}. First scale near Rs ${r2(target1)}; ` +
    `final target is the opposite ${oppositeZone} near Rs ${r2(target2)}. Exit any open trade by 15:15 IST.`;

  return {
    candle,
    confirmedClose: entry,
    direction,
    setup,
    sl: r2(sl),
    target1: r2(target1),
    target2: r2(target2),
    riskPct: r2((risk / entry) * 100),
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

  const latestCandle = sessionCandles.at(-1);
  if (!latestCandle) return null;

  const latestCloseSecs = latestCandle.t + CANDLE_INTERVAL_SECS;
  const maxSignalAgeSecs = CANDLE_INTERVAL_SECS * FRESH_SIGNAL_LOOKBACK_BARS;
  const latestHistoricalCandles = historicalCandles.filter((c) => c.t <= latestCandle.t);
  const channel = buildPowerChannelContext(latestHistoricalCandles);
  if (!channel) return null;

  const historicalIndexByTime = new Map<number, number>();
  historicalCandles.forEach((candle, index) => {
    historicalIndexByTime.set(candle.t, index);
  });

  for (let i = sessionCandles.length - 1; i >= 0; i--) {
    const candle = sessionCandles[i];
    if (getCandleCloseDateIST(candle) !== today || !candleClosesInEntryWindow(candle)) continue;

    const signalAgeSecs = latestCloseSecs - (candle.t + CANDLE_INTERVAL_SECS);
    if (signalAgeSecs > maxSignalAgeSecs) break;

    if (i < SKIP_OPENING_BARS) continue;

    const historicalIndex = historicalIndexByTime.get(candle.t);
    const previousCandle =
      historicalIndex !== undefined && historicalIndex > 0
        ? historicalCandles[historicalIndex - 1]
        : null;
    if (!previousCandle) continue;

    const buyReaction =
      previousCandle.l <= channel.supportTop &&
      candle.l > channel.supportTop;
    const sellRejection =
      previousCandle.h >= channel.resistanceBottom &&
      candle.h < channel.resistanceBottom;
    const recentCandles = sessionCandles.slice(
      Math.max(0, i - POWER_CHANNEL_CHOP_LOOKBACK_BARS),
      i + 1,
    );

    let signal: PriceActionSignal | null = null;
    if (buyReaction) {
      signal = isPowerChannelChop(recentCandles, "LONG", channel)
        ? null
        : buildPowerChannelSignal(candle, "LONG", channel);
    } else if (sellRejection) {
      signal = isPowerChannelChop(recentCandles, "SHORT", channel)
        ? null
        : buildPowerChannelSignal(candle, "SHORT", channel);
    }

    if (signal) {
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
      isCurrentStrategyEntrySignal(trade.signalTime)
    ) ?? null;
    const invalidExistingTrade =
      firstExistingTrade && !isCurrentStrategyEntrySignal(firstExistingTrade.signalTime)
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

    // Volume is displayed as context only; the ChartPrime Power Channel script itself does not filter by volume.
    const volumeRatio = calculateVolumeRatio(confirmedHistorical);
    const volumeOk = volumeRatio !== null ? volumeRatio >= VOLUME_CONFIRMATION_MULTIPLIER : null;

    if (existingTrade) {
      entrySignal = isEntryWindow && (existingTrade.status === "PENDING" || existingTrade.status === "ACTIVE");
      sl = Number(existingTrade.sl);
      target1 = Number(existingTrade.target1);
      target2 = Number(existingTrade.target2);

      const entryPrice = Number(existingTrade.entryPrice);
      direction = target2 < entryPrice || sl > entryPrice ? "SHORT" : "LONG";
      setup = "SAVED POWER CHANNEL SIGNAL";
      const risk = Math.abs(entryPrice - sl);
      const reward = Math.abs(target2 - entryPrice);
      riskPct = r2((risk / entryPrice) * 100);
      rewardRisk = risk > 0 ? r2(reward / risk) : null;
      signalTime = existingTrade.signalTime;
      smartExit = `[SAVED] ${direction} Power Channel setup entered at Rs ${entryPrice}. SL Rs ${sl}; target Rs ${target2}; square off by 15:15 IST.`;

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

function plPctForScaledExit(
  entry: number,
  firstExit: number,
  finalExit: number,
  direction: SignalDirection,
): number {
  const firstLeg = plPctForExit(entry, firstExit, direction) * T1_SCALE_OUT_FRACTION;
  const finalLeg = plPctForExit(entry, finalExit, direction) * (1 - T1_SCALE_OUT_FRACTION);
  return r2(firstLeg + finalLeg);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function avg(values: number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function percentChange(current: number, previous: number | null | undefined): number {
  if (!previous || !Number.isFinite(previous) || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function ensureSwingTradesTable(): Promise<void> {
  if (!swingTradesTableReady) {
    swingTradesTableReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS swing_trades (
          id SERIAL PRIMARY KEY,
          symbol TEXT NOT NULL,
          date TEXT NOT NULL,
          signal_time TIMESTAMPTZ NOT NULL,
          sector TEXT,
          direction TEXT NOT NULL DEFAULT 'LONG',
          entry_type TEXT NOT NULL DEFAULT 'PULLBACK',
          current_price NUMERIC NOT NULL,
          entry_price NUMERIC NOT NULL,
          sl NUMERIC NOT NULL,
          target NUMERIC NOT NULL,
          score NUMERIC NOT NULL,
          grade TEXT NOT NULL,
          setup TEXT NOT NULL,
          reason TEXT,
          expected_hold_days NUMERIC NOT NULL DEFAULT 8,
          status TEXT NOT NULL DEFAULT 'WATCHLIST',
          entry_hit_date TEXT,
          exit_date TEXT,
          last_price NUMERIC,
          last_checked_at TIMESTAMPTZ
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS swing_symbol_date_unique
        ON swing_trades (symbol, date)
      `);
    })();
  }

  return swingTradesTableReady;
}

async function fetchAngelDailyCandles(
  symbol: string,
  tokenOverride?: string,
): Promise<Candle[] | null> {
  if (process.env.ANGEL_MARKET_DATA_ENABLED === "false") return null;

  if (!hasAngelMarketDataCredentials()) {
    if (!angelCredentialsWarningShown) {
      console.warn("[DATA] Angel One market data disabled: missing credentials.");
      angelCredentialsWarningShown = true;
    }
    return null;
  }

  let token = tokenOverride;
  if (!token) {
    const scripMap = await getAngelScripMap();
    token = scripMap.get(normalizeEquitySymbol(symbol));
  }
  if (!token) throw new Error(`No Angel One token found for ${symbol}`);

  const now = new Date();
  const from = new Date(now.getTime() - SWING_FETCH_LOOKBACK_CALENDAR_DAYS * 24 * 3600 * 1000);
  const smartApi = await getAngelSmartApi();
  const response: any = await smartApiLimiters.getCandleData.schedule(() =>
    smartApi.getCandleData({
      exchange: "NSE",
      symboltoken: token,
      interval: "ONE_DAY",
      fromdate: formatAngelDate(from),
      todate: formatAngelDate(now),
    })
  );

  if (!response?.status || !Array.isArray(response.data)) {
    throw new Error(response?.message || "Angel One returned no daily candle data");
  }

  const candles: Candle[] = [];
  for (const row of response.data as AngelCandleRow[]) {
    const epochSecs = parseAngelEpochSecs(row[0]);
    if (epochSecs === null) continue;

    const candle = {
      t: epochSecs,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    };
    if ([candle.o, candle.h, candle.l, candle.c].every((value) => Number.isFinite(value) && value > 0)) {
      candles.push(candle);
    }
  }

  return candles.sort((a, b) => a.t - b.t);
}

async function fetchMoneycontrolDailyCandles(symbol: string): Promise<Candle[] | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - SWING_FETCH_LOOKBACK_CALENDAR_DAYS * 24 * 3600;
  const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(normalizeEquitySymbol(symbol))}&resolution=1D&from=${from}&to=${to}&countback=420&currencyCode=INR`;

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

  return data.t
    .map((t, i) => ({
      t,
      o: data.o?.[i] ?? 0,
      h: data.h?.[i] ?? 0,
      l: data.l?.[i] ?? 0,
      c: data.c?.[i] ?? 0,
      v: data.v?.[i] ?? 0,
    }))
    .filter((c) => [c.o, c.h, c.l, c.c].every((value) => Number.isFinite(value) && value > 0))
    .sort((a, b) => a.t - b.t);
}

async function fetchDailyCandles(symbol: string): Promise<Candle[] | null> {
  try {
    const angelCandles = await fetchAngelDailyCandles(symbol);
    if (angelCandles?.length) return angelCandles;
  } catch (err) {
    console.warn(`[DATA] ${symbol}: Angel One daily candle fetch failed.`, err);
  }

  try {
    const fallbackCandles = await fetchMoneycontrolDailyCandles(symbol);
    if (fallbackCandles?.length) return fallbackCandles;
  } catch (err) {
    console.warn(`[DATA] ${symbol}: Moneycontrol daily candle fetch failed.`, err);
  }

  return null;
}

function normalizeEquitySymbol(symbol: string): string {
  return symbol.toUpperCase().trim().replace(/-EQ$/i, "");
}

async function fetchNiftyDailyReturn(): Promise<number> {
  try {
    const candles = await fetchAngelDailyCandles("NIFTY", SWING_NIFTY_TOKEN);
    const closes = (candles ?? []).map((c) => c.c);
    const last = closes.at(-1);
    const previous = closes.at(-6);
    return last && previous ? percentChange(last, previous) : 0;
  } catch (err) {
    console.warn("[DATA] NIFTY daily return fetch failed.", err);
    return 0;
  }
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return output;

  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    output[i] = ema;
  }
  return output;
}

function smaLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return avg(values.slice(-period));
}

function calculateRsiLast(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = ((avgGain * (period - 1)) + Math.max(diff, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMacd(closes: number[]): { macd: number | null; signal: number | null; histogram: number | null } {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdSeries = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? (ema12[i] as number) - (ema26[i] as number) : null
  );
  const validMacd = macdSeries.filter((value): value is number => value !== null);
  if (validMacd.length < 9) return { macd: null, signal: null, histogram: null };

  const signalSeries = emaSeries(validMacd, 9);
  const macd = validMacd.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  return {
    macd,
    signal,
    histogram: macd !== null && signal !== null ? macd - signal : null,
  };
}

function countConsolidationCandles(candles: Candle[], atr: number, currentPrice: number): number {
  const prior = candles.slice(-9, -1);
  if (prior.length < 3 || atr <= 0) return 0;

  const high = Math.max(...prior.map((c) => c.h));
  const low = Math.min(...prior.map((c) => c.l));
  const bandPct = ((high - low) / currentPrice) * 100;
  if (bandPct <= 4.5) return prior.length;

  return prior.filter((c) => (c.h - c.l) <= atr * 1.15).length;
}

function freshBreakoutAge(candles: Candle[], lookback = 20, maxAge = 3): number | null {
  for (let age = 1; age <= maxAge; age++) {
    const index = candles.length - age;
    if (index < lookback) continue;
    const previousHigh = Math.max(...candles.slice(index - lookback, index).map((c) => c.h));
    if (candles[index].c > previousHigh) return age;
  }
  return null;
}

function sectorMomentumAdjustment(sectorRelativeStrength: number): number {
  if (sectorRelativeStrength > 4) return 2.0;
  if (sectorRelativeStrength > 2) return 1.5;
  if (sectorRelativeStrength > 1) return 1.0;
  if (sectorRelativeStrength < -1) return -1.0;
  return 0.0;
}

function relativeStrengthAdjustment(relativeStrength: number): number {
  if (relativeStrength > 3) return 2.0;
  if (relativeStrength > 1) return 1.0;
  if (relativeStrength < -2) return -2.0;
  return 0.0;
}

function entryDistanceAdjustment(distancePct: number): number {
  if (distancePct <= 1) return 1.5;
  if (distancePct <= 2) return 0.8;
  if (distancePct <= 2.5) return 0.2;
  return 0.0;
}

function liquidityAdjustment(avgTurnover: number): number {
  const turnoverCr = avgTurnover / 10_000_000;
  if (turnoverCr < 20) return 0.0;
  if (turnoverCr < 50) return 0.5;
  if (turnoverCr < 100) return 1.0;
  if (turnoverCr < 250) return 1.5;
  return 2.2;
}

function rvolAdjustment(rvol: number): number {
  if (rvol > 2) return 2.0;
  if (rvol > 1.5) return 1.0;
  return 0.0;
}

function trendPersistenceAdjustment(trendPersistence: number): number {
  const centered = (trendPersistence - 50) / 50;
  return r2(clamp(centered * 0.8, -0.8, 0.8));
}

function breakoutQualityDetails(
  freshAge: number | null,
  consolidationCandles: number,
  rvol: number,
  trendPersistence: number,
  liquidityScore: number,
): { score: number; grade: string } {
  const ageScore = freshAge === 1 ? 40 : freshAge === 2 ? 22 : freshAge === 3 ? 14 : 10;
  const consolidationScore =
    consolidationCandles >= 6 ? 20
      : consolidationCandles >= 4 ? 16
        : consolidationCandles >= 2 ? 10
          : freshAge === 1 ? 8
            : 6;
  const rvolScore =
    rvol >= 2 ? 20
      : rvol >= 1.5 ? 14
        : rvol >= 1 ? 8
          : rvol >= 0.8 ? 5
            : 0;
  const persistenceScore =
    trendPersistence >= 90 ? 30
      : trendPersistence >= 85 ? 28
        : trendPersistence >= 75 ? 20
          : trendPersistence >= 60 ? 12
            : trendPersistence >= 50 ? 8
              : 0;

  let score = ageScore + consolidationScore + rvolScore + persistenceScore;
  let grade = score >= 80 ? "A+" : score >= 70 ? "A" : score >= 48 ? "B+" : score >= 35 ? "B" : "C";
  if (liquidityScore < 0.75 && ["B+", "A", "A+"].includes(grade)) {
    grade = "B";
    score = Math.min(score, 47);
  }
  return { score: r2(score), grade };
}

function normalizeOpportunityScore(rawScore: number): number {
  return r2(100 * (1 - Math.exp(-Math.max(rawScore, 0) / 1.25)));
}

function confidenceGrade(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "B+";
  if (score >= 70) return "B";
  if (score >= 60) return "C+";
  return "C";
}

function analyzeSwingCandidate(
  stock: SwingUniverseStock,
  candles: Candle[],
  niftyReturn: number,
): SwingCandidate | null {
  const validCandles = candles
    .filter((c) => [c.o, c.h, c.l, c.c].every((value) => Number.isFinite(value) && value > 0))
    .sort((a, b) => a.t - b.t);
  if (validCandles.length < 60) return null;

  const last = validCandles.at(-1)!;
  const previous = validCandles.at(-2);
  const currentPrice = r2(last.c);
  if (currentPrice < SWING_MIN_PRICE) return null;

  const closes = validCandles.map((c) => c.c);
  const volumes = validCandles.map((c) => c.v);
  const ema20All = emaSeries(closes, 20);
  const ema50All = emaSeries(closes, 50);
  const ema20 = ema20All.at(-1) ?? null;
  const ema50 = ema50All.at(-1) ?? null;
  const sma50 = smaLast(closes, 50);
  const rsi = calculateRsiLast(closes);
  const macd = calculateMacd(closes);
  const atr = calculateATR(validCandles, 14);
  const avgVolume = avg(volumes.slice(-21, -1));
  if (!atr || !avgVolume || avgVolume <= 0 || !previous || !ema20 || !ema50 || !sma50 || rsi === null) {
    return null;
  }

  const prev20 = validCandles.slice(-21, -1);
  if (prev20.length < 20) return null;

  const prev20High = Math.max(...prev20.map((c) => c.h));
  const avgTurnover = avgVolume * currentPrice;
  const rvol = last.v > 0 ? last.v / avgVolume : 0;
  const recentReturn = percentChange(currentPrice, closes.at(-6));
  const relativeStrength = recentReturn - niftyReturn;
  const sectorRelativeStrength = stock.changePct ? stock.changePct - niftyReturn : 0;
  const latestMovePct = percentChange(currentPrice, previous.c);
  const ema20DistancePct = ((currentPrice - ema20) / ema20) * 100;
  const trendPersistence = (() => {
    const recentCloses = closes.slice(-5);
    const recentEma = ema20All.slice(-5);
    const valid = recentCloses.filter((close, i) => recentEma[i] !== null && close > (recentEma[i] as number));
    return (valid.length / Math.max(1, recentCloses.length)) * 100;
  })();
  const freshAge = freshBreakoutAge(validCandles);
  const consolidationCandles = countConsolidationCandles(validCandles, atr, currentPrice);
  const isBreakout = currentPrice > prev20High || freshAge !== null;
  const trendOk = currentPrice > ema20 && ema20 > ema50 && currentPrice > sma50;

  let signalScore = 0;
  const reasons: string[] = [];

  if (trendOk) {
    signalScore += 1.5;
    reasons.push("trend above EMA20/EMA50");
  }
  if (rsi >= 45 && rsi <= 68) {
    signalScore += 1;
    reasons.push(`RSI ${r2(rsi)}`);
  } else if (rsi >= 35 && rsi < 45) {
    signalScore += 0.5;
    reasons.push(`healthy pullback RSI ${r2(rsi)}`);
  } else if (rsi > 75) {
    signalScore -= 1.5;
    reasons.push("RSI extended");
  }
  if ((macd.histogram ?? 0) > 0) {
    signalScore += 1;
    reasons.push("MACD positive");
  }
  if (rvol > 1.5 && currentPrice >= previous.c) {
    signalScore += 2;
    reasons.push(`RVOL ${r2(rvol)}x`);
  } else if (rvol > 1) {
    signalScore += 0.5;
  } else if (rvol < 0.5) {
    signalScore -= 1;
  }
  if (isBreakout) {
    signalScore += 2;
    reasons.push(freshAge ? `fresh breakout D-${freshAge - 1}` : "breakout");
  }
  if (latestMovePct > 8 || ema20DistancePct > 10) {
    signalScore -= 1.5;
    reasons.push("extension risk");
  }

  if (signalScore < SWING_MIN_SIGNAL_SCORE || (!trendOk && !isBreakout)) return null;

  const entryType: SwingCandidate["entryType"] = isBreakout ? "BREAKOUT" : "PULLBACK";
  const rawEntry = entryType === "BREAKOUT"
    ? Math.max(currentPrice, prev20High) * 1.001
    : currentPrice - (atr * 0.5);
  const entryPrice = r2(rawEntry);
  const entryDistancePct = Math.abs(entryPrice - currentPrice) / currentPrice * 100;
  if (entryDistancePct > SWING_MAX_ENTRY_GAP_PCT) return null;
  if (
    entryType === "PULLBACK" &&
    entryDistancePct < SWING_MIN_PULLBACK_GAP_PCT &&
    consolidationCandles < SWING_MIN_CONSOLIDATION_CANDLES
  ) {
    return null;
  }

  const stopMultiplier = entryType === "BREAKOUT" ? 2.2 : 1.5;
  const sl = r2(Math.max(entryPrice - (atr * stopMultiplier), entryPrice * 0.9));
  const risk = entryPrice - sl;
  if (!Number.isFinite(risk) || risk <= 0) return null;

  const targetMultiplier = entryType === "BREAKOUT" ? 3 : 2.5;
  const target = r2(Math.min(entryPrice + (risk * targetMultiplier), entryPrice * 1.2));
  const rewardRisk = (target - entryPrice) / risk;
  if (!Number.isFinite(rewardRisk) || rewardRisk < 1.8) return null;

  if (avgTurnover < SWING_MIN_AVG_TURNOVER && sectorRelativeStrength < SWING_MIN_SECTOR_RELATIVE_STRENGTH) {
    return null;
  }

  const relativeStrengthScore = relativeStrengthAdjustment(relativeStrength);
  const sectorMomentumScore = sectorMomentumAdjustment(sectorRelativeStrength);
  const liquidityScore = liquidityAdjustment(avgTurnover);
  const rvolScore = rvolAdjustment(rvol);
  const entryScore = entryDistanceAdjustment(entryDistancePct);
  const breakoutBonus = freshAge ? ({ 1: 0.5, 2: 0.3, 3: 0.1 } as Record<number, number>)[freshAge] ?? 0 : 0;
  const trendAdjustment = trendPersistenceAdjustment(trendPersistence);
  const exhaustionPenalty = rvol > 5 && (latestMovePct > 8 || ema20DistancePct > 8)
    ? -clamp(((rvol - 5) * 0.25) + (Math.max(latestMovePct - 8, ema20DistancePct - 8) * 0.15), 0, 2)
    : 0;
  const rawScore =
    (relativeStrengthScore * 0.35) +
    (rvolScore * 0.25) +
    (sectorMomentumScore * 0.20) +
    (liquidityScore * 0.10) +
    (entryScore * 0.10) +
    breakoutBonus +
    trendAdjustment +
    exhaustionPenalty;
  const score = normalizeOpportunityScore(rawScore);
  if (score < SWING_MIN_SCORE) return null;

  const grade = confidenceGrade(score);
  const quality = breakoutQualityDetails(freshAge, consolidationCandles, rvol, trendPersistence, liquidityScore);
  const setup = freshAge
    ? "Fresh Breakout"
    : relativeStrength > 1 && sectorRelativeStrength > 0
      ? "Sector Leader"
      : entryType === "PULLBACK"
        ? "Trend Pullback"
        : "Trend Continuation";

  return {
    symbol: stock.symbol,
    sector: stock.sectorName,
    signalTime: new Date(last.t * 1000).toISOString(),
    currentPrice,
    entryPrice,
    sl,
    target,
    score,
    signalScore: r2(signalScore),
    grade,
    setup,
    entryType,
    reason: reasons.join("; "),
    expectedHoldDays: SWING_EXPECTED_HOLD_DAYS,
    recentReturn: r2(recentReturn),
    relativeStrength: r2(relativeStrength),
    sectorRelativeStrength: r2(sectorRelativeStrength),
    rvol: r2(rvol),
    avgTurnover: Math.round(avgTurnover),
    entryDistancePct: r2(entryDistancePct),
    rewardRisk: r2(rewardRisk),
    breakoutQuality: quality.grade,
    trendPersistence: r2(trendPersistence),
    freshBreakoutAge: freshAge,
    consolidationCandles,
  };
}

function parseRequestedSwingSectors(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  const requested = raw
    .split(",")
    .map((sector) => sector.trim())
    .filter(Boolean);
  if (requested.length === 0) return [...SWING_SECTOR_NAMES];

  const valid = new Map(SWING_SECTOR_NAMES.map((sector) => [sector.toLowerCase(), sector]));
  const selected = requested
    .map((sector) => valid.get(sector.toLowerCase()))
    .filter((sector): sector is (typeof SWING_SECTOR_NAMES)[number] => Boolean(sector));
  return selected.length > 0 ? Array.from(new Set(selected)) : [...SWING_SECTOR_NAMES];
}

function fetchSwingUniverse(selectedSectors: string[]): SwingUniverseStock[] {
  const seen = new Set<string>();
  const stocks: SwingUniverseStock[] = [];

  for (const sector of selectedSectors) {
    const symbols = SWING_SECTORS[sector as keyof typeof SWING_SECTORS] ?? [];
    for (const rawSymbol of symbols) {
      const symbol = normalizeEquitySymbol(rawSymbol);
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      stocks.push({
        symbol,
        sectorName: sector,
        ltp: 0,
        changePct: 0,
      });
    }
  }

  return stocks;
}

function createSwingScanJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneSwingScanJobs() {
  const jobs = [...swingScanJobs.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const job of jobs.slice(MAX_SWING_SCAN_JOBS)) {
    if (job.status !== "running" && job.status !== "queued") {
      swingScanJobs.delete(job.id);
    }
  }
}

function serializeSwingScanJob(job: SwingScanJob) {
  const progressPct = job.universeCount > 0
    ? r2((job.processedCount / job.universeCount) * 100)
    : 0;
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    selectedSectors: job.selectedSectors,
    sectorCount: job.sectorCount,
    universeCount: job.universeCount,
    processedCount: job.processedCount,
    candidateCount: job.candidateCount,
    savedCount: job.savedCount,
    progressPct,
    message: job.message,
    error: job.error,
    result: job.result,
  };
}

async function runSwingScanner(
  selectedSectors: string[],
  universe: SwingUniverseStock[],
  limit: number,
  onProgress?: (processedCount: number, candidateCount: number) => void,
): Promise<SwingScannerResult> {
  const niftyReturn = await fetchNiftyDailyReturn();
  const stockBySymbol = new Map(universe.map((stock) => [stock.symbol, stock]));
  let processedCount = 0;
  let candidateCount = 0;

  const analyzed = await runWithConcurrency(
    universe.map((stock) => stock.symbol),
    2,
    async (symbol) => {
      const stock = stockBySymbol.get(symbol);
      if (!stock) return null;

      let candidate: SwingCandidate | null = null;
      const candles = await fetchDailyCandles(symbol);
      if (candles) {
        candidate = analyzeSwingCandidate(stock, candles, niftyReturn);
      }

      processedCount += 1;
      if (candidate) candidateCount += 1;
      onProgress?.(processedCount, candidateCount);
      return candidate;
    },
  );

  const candidates = analyzed
    .filter((candidate): candidate is SwingCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);
  const picks = limitSwingPicksBySector(candidates, limit);
  const savedCount = await persistSwingCandidates(picks, getTodayISTDateStr());

  return {
    fetchedAt: new Date().toISOString(),
    date: getTodayISTDateStr(),
    selectedSectors,
    sectorCount: selectedSectors.length,
    universeCount: universe.length,
    candidateCount: candidates.length,
    savedCount,
    niftyReturn: r2(niftyReturn),
    picks,
  };
}

function startSwingScanJob(selectedSectors: string[], limit: number): SwingScanJob {
  if (activeSwingScanJobId) {
    const activeJob = swingScanJobs.get(activeSwingScanJobId);
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      return activeJob;
    }
  }

  const universe = fetchSwingUniverse(selectedSectors);
  const now = new Date().toISOString();
  const job: SwingScanJob = {
    id: createSwingScanJobId(),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    selectedSectors,
    sectorCount: selectedSectors.length,
    universeCount: universe.length,
    processedCount: 0,
    candidateCount: 0,
    savedCount: 0,
    limit,
    message: `Queued ${universe.length} symbols across ${selectedSectors.length} sectors.`,
    error: null,
    result: null,
  };

  swingScanJobs.set(job.id, job);
  activeSwingScanJobId = job.id;
  pruneSwingScanJobs();

  void (async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.message = `Scanning ${job.universeCount} symbols.`;

    try {
      const result = await runSwingScanner(selectedSectors, universe, limit, (processed, candidates) => {
        job.processedCount = processed;
        job.candidateCount = candidates;
        job.updatedAt = new Date().toISOString();
        job.message = `Scanned ${processed}/${job.universeCount} symbols.`;
      });
      job.status = "completed";
      job.result = result;
      job.processedCount = result.universeCount;
      job.candidateCount = result.candidateCount;
      job.savedCount = result.savedCount;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.message = `Completed. Saved ${result.savedCount} swing picks.`;
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : "Swing scanner failed";
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.message = "Swing scan failed.";
      console.error("[SWING] Background scanner failed", err);
    } finally {
      if (activeSwingScanJobId === job.id) {
        activeSwingScanJobId = null;
      }
    }
  })();

  return job;
}

function limitSwingPicksBySector(candidates: SwingCandidate[], limit: number): SwingCandidate[] {
  const selected: SwingCandidate[] = [];
  const sectorCounts = new Map<string, number>();

  for (const candidate of candidates) {
    const count = sectorCounts.get(candidate.sector) ?? 0;
    if (count >= 2) continue;
    selected.push(candidate);
    sectorCounts.set(candidate.sector, count + 1);
    if (selected.length >= limit) break;
  }

  return selected.length > 0 ? selected : candidates.slice(0, limit);
}

function dbTimeToIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "");
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
}

function mapSwingTradeRow(row: Record<string, unknown>): PersistedSwingTrade {
  return {
    id: Number(row.id),
    symbol: String(row.symbol),
    date: String(row.date),
    signalTime: dbTimeToIso(row.signal_time),
    sector: row.sector === null || row.sector === undefined ? null : String(row.sector),
    direction: String(row.direction ?? "LONG"),
    entryType: String(row.entry_type ?? "PULLBACK") === "BREAKOUT" ? "BREAKOUT" : "PULLBACK",
    currentPrice: String(row.current_price),
    entryPrice: String(row.entry_price),
    sl: String(row.sl),
    target: String(row.target),
    score: String(row.score),
    grade: String(row.grade),
    setup: String(row.setup),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    expectedHoldDays: String(row.expected_hold_days),
    status: String(row.status ?? "WATCHLIST") as SwingTradeStatus,
    entryHitDate: row.entry_hit_date === null || row.entry_hit_date === undefined ? null : String(row.entry_hit_date),
    exitDate: row.exit_date === null || row.exit_date === undefined ? null : String(row.exit_date),
    lastPrice: row.last_price === null || row.last_price === undefined ? null : String(row.last_price),
    lastCheckedAt: row.last_checked_at === null || row.last_checked_at === undefined ? null : dbTimeToIso(row.last_checked_at),
  };
}

async function persistSwingCandidates(candidates: SwingCandidate[], date: string): Promise<number> {
  await ensureSwingTradesTable();
  let saved = 0;

  for (const candidate of candidates) {
    const result = await pool.query(
      `
        INSERT INTO swing_trades (
          symbol, date, signal_time, sector, direction, entry_type,
          current_price, entry_price, sl, target, score, grade, setup, reason,
          expected_hold_days, status, last_price, last_checked_at
        )
        VALUES (
          $1, $2, $3, $4, 'LONG', $5,
          $6, $7, $8, $9, $10, $11, $12, $13,
          $14, 'WATCHLIST', $15, $16
        )
        ON CONFLICT (symbol, date) DO NOTHING
        RETURNING id
      `,
      [
        candidate.symbol,
        date,
        candidate.signalTime,
        candidate.sector,
        candidate.entryType,
        String(candidate.currentPrice),
        String(candidate.entryPrice),
        String(candidate.sl),
        String(candidate.target),
        String(candidate.score),
        candidate.grade,
        candidate.setup,
        candidate.reason,
        String(candidate.expectedHoldDays),
        String(candidate.currentPrice),
        new Date().toISOString(),
      ],
    );

    saved += result.rowCount ?? 0;
  }

  return saved;
}

function tradingDaysOpen(candles: Candle[], entryHitDate: string | null, latestDate: string | null): number | null {
  if (!entryHitDate || !latestDate) return null;
  return candles.filter((c) => {
    const date = getISTDateStr(c.t);
    return date > entryHitDate && date <= latestDate;
  }).length;
}

async function resolveSwingTrade(trade: PersistedSwingTrade): Promise<SwingTrackerTrade> {
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.sl);
  const target = Number(trade.target);
  let status = trade.status as SwingTradeStatus;
  let entryHitDate = trade.entryHitDate ?? null;
  let exitDate = trade.exitDate ?? null;
  let lastPrice = Number(trade.lastPrice ?? trade.currentPrice);

  const candles = await fetchDailyCandles(trade.symbol).catch(() => null);
  const latestDate = candles?.at(-1) ? getISTDateStr(candles.at(-1)!.t) : null;
  if (candles?.length) {
    lastPrice = r2(candles.at(-1)!.c);
  }

  if (candles?.length && status !== "TARGET HIT" && status !== "SL HIT" && status !== "CLOSED") {
    const postSignalCandles = candles
      .filter((c) => getISTDateStr(c.t) >= trade.date)
      .sort((a, b) => a.t - b.t);

    for (const candle of postSignalCandles) {
      const candleDate = getISTDateStr(candle.t);

      if (status === "WATCHLIST" && !entryHitDate) {
        const entryTouched = trade.entryType === "BREAKOUT"
          ? candle.h >= entry
          : candle.l <= entry;
        if (entryTouched) {
          status = "ACTIVE";
          entryHitDate = candleDate;
          continue;
        }
      }

      if ((status === "ACTIVE" || status === "EXIT REVIEW") && entryHitDate && candleDate > entryHitDate) {
        if (candle.l <= sl) {
          status = "SL HIT";
          exitDate = candleDate;
          break;
        }
        if (candle.h >= target) {
          status = "TARGET HIT";
          exitDate = candleDate;
          break;
        }
      }
    }

    const openDays = tradingDaysOpen(candles, entryHitDate, latestDate);
    if (status === "ACTIVE" && openDays !== null && openDays >= Number(trade.expectedHoldDays)) {
      status = "EXIT REVIEW";
    }
  }

  const lastCheckedAt = new Date().toISOString();
  if (
    status !== trade.status ||
    entryHitDate !== trade.entryHitDate ||
    exitDate !== trade.exitDate ||
    String(lastPrice) !== String(trade.lastPrice ?? "") ||
    !trade.lastCheckedAt
  ) {
    await pool.query(
      `
        UPDATE swing_trades
        SET status = $1,
            entry_hit_date = $2,
            exit_date = $3,
            last_price = $4,
            last_checked_at = $5
        WHERE id = $6
      `,
      [status, entryHitDate, exitDate, String(lastPrice), lastCheckedAt, trade.id],
    );
  }

  const plPct =
    status === "WATCHLIST" ? null
      : status === "TARGET HIT" ? r2(((target - entry) / entry) * 100)
        : status === "SL HIT" ? r2(((sl - entry) / entry) * 100)
          : Number.isFinite(lastPrice) ? r2(((lastPrice - entry) / entry) * 100)
            : null;

  return {
    ...trade,
    status,
    entryHitDate,
    exitDate,
    lastPrice: String(lastPrice),
    lastCheckedAt,
    plPct,
    daysOpen: tradingDaysOpen(candles ?? [], entryHitDate, latestDate),
  };
}

router.get("/swing-scanner", async (req, res) => {
  try {
    await ensureSwingTradesTable();

    const limit = Math.min(10, Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_SWING_PICK_LIMIT), 10) || DEFAULT_SWING_PICK_LIMIT));
    const selectedSectors = parseRequestedSwingSectors(req.query.sectors);
    const job = startSwingScanJob(selectedSectors, limit);

    return res.json(serializeSwingScanJob(job));
  } catch (err) {
    req.log.error({ err }, "Failed to run swing scanner");
    return res.status(500).json({ error: "Failed to run swing scanner" });
  }
});

router.get("/swing-scanner/jobs/:jobId", async (req, res) => {
  const job = swingScanJobs.get(String(req.params.jobId));
  if (!job) {
    return res.status(404).json({ error: "Swing scan job expired. Start a new scan." });
  }
  return res.json(serializeSwingScanJob(job));
});

router.get("/swing-sectors", async (_req, res) => {
  const sectors = SWING_SECTOR_NAMES.map((name) => ({
    name,
    count: SWING_SECTORS[name].length,
  }));
  return res.json({
    totalSectors: sectors.length,
    totalSymbols: sectors.reduce((sum, sector) => sum + sector.count, 0),
    sectors,
  });
});

router.get("/swing-trades", async (req, res) => {
  try {
    await ensureSwingTradesTable();

    const days = Math.min(180, Math.max(1, parseInt(String(req.query.days ?? "45"), 10) || 45));
    const startDate = new Date(Date.now() + IST_OFFSET_MS - days * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const statusFilter = String(req.query.status ?? "all").toUpperCase();

    const tradeRows = await pool.query(
      `
        SELECT id, symbol, date, signal_time, sector, direction, entry_type,
               current_price, entry_price, sl, target, score, grade, setup, reason,
               expected_hold_days, status, entry_hit_date, exit_date, last_price, last_checked_at
        FROM swing_trades
        WHERE date >= $1
        ORDER BY date DESC, signal_time ASC
      `,
      [startDate],
    );
    const trades = tradeRows.rows.map(mapSwingTradeRow);

    const enriched = await runWithConcurrency(
      trades.map((trade) => String(trade.id)),
      2,
      async (id) => {
        const trade = trades.find((item) => String(item.id) === id);
        return trade ? resolveSwingTrade(trade) : null;
      },
    );

    let resolved = enriched.filter((trade): trade is SwingTrackerTrade => trade !== null);
    if (statusFilter !== "ALL") {
      resolved = resolved.filter((trade) => String(trade.status).toUpperCase() === statusFilter);
    }

    const activeStatuses = new Set(["WATCHLIST", "ACTIVE", "EXIT REVIEW"]);
    const summary = {
      total: resolved.length,
      watchlist: resolved.filter((trade) => trade.status === "WATCHLIST").length,
      active: resolved.filter((trade) => trade.status === "ACTIVE").length,
      targetHit: resolved.filter((trade) => trade.status === "TARGET HIT").length,
      slHit: resolved.filter((trade) => trade.status === "SL HIT").length,
      exitReview: resolved.filter((trade) => trade.status === "EXIT REVIEW").length,
      open: resolved.filter((trade) => activeStatuses.has(trade.status)).length,
    };

    return res.json({
      fetchedAt: new Date().toISOString(),
      days,
      summary,
      trades: resolved,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch swing trades");
    return res.status(500).json({ error: "Failed to fetch swing trades" });
  }
});

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
            return stock.ltp >= MIN_ENTRY_PRICE &&
              Math.abs(change) >= MIN_ENTRY_STOCK_CHANGE_PCT &&
              Math.abs(change) < 5.0;
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
              ind.smartExit !== null
            ) {
              // Rank Power Channel setups by RR first, then directional move and volume context.
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
                vwap: ind.vwap ?? 0,
                ema20: ind.ema20 ?? 0,
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
    req.log.error({ err }, "Failed to fetch Power Channel picks");
    return res.status(500).json({ error: "Failed to fetch Power Channel picks" });
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
      // Look at session candles that closed after the signal time (candle length is 5 mins = 300s)
      const postSignalCandles = statusCandles
        .filter(c => (c.t + CANDLE_INTERVAL_SECS) * 1000 > signalTimeMs);
      
      let hitTime: string | null = null;
      
      const target1 = Number(trade.target1);
      const target2 = Number(trade.target2);
      const entryPrice = Number(trade.entryPrice);
      const originalSl = Number(trade.sl);
      const direction = inferTradeDirectionFromPrices(entryPrice, originalSl, target2);
      const hitsTarget = (c: Candle, target: number) =>
        direction === "LONG" ? c.h >= target : c.l <= target;
      const hitsStop = (c: Candle, stop: number) =>
        direction === "LONG" ? c.l <= stop : c.h >= stop;
      
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
      const hitsTarget = (c: Candle, target: number) =>
        direction === "LONG" ? c.h >= target : c.l <= target;
      const hitsStop = (c: Candle, stop: number) =>
        direction === "LONG" ? c.l <= stop : c.h >= stop;

      let status: TradeStatus = "ACTIVE";
      let hitTime: string | null = null;
      let exitPrice: number | null = null;
      let plPctOverride: number | null = null;
      let maxTargetReached = 0;

      for (const c of postSignalCandles) {
        if (maxTargetReached >= 1) {
          if (hitsTarget(c, t2)) {
            status = "TARGET 2 HIT";
            hitTime = getISTTimeStr(c.t);
            exitPrice = t2;
            plPctOverride = plPctForScaledExit(entry, t1, t2, direction);
            break;
          }

          if (hitsStop(c, entry)) {
            status = "T1 HIT & TRAILING SL HIT";
            hitTime = getISTTimeStr(c.t);
            exitPrice = entry;
            plPctOverride = plPctForScaledExit(entry, t1, entry, direction);
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
          plPctOverride = plPctForScaledExit(entry, t1, t2, direction);
          break;
        }

        if (hitsTarget(c, t1)) {
          maxTargetReached = 1;
          status = "TARGET 1 HIT";
          hitTime = getISTTimeStr(c.t);
          exitPrice = t1;
          plPctOverride = plPctForScaledExit(entry, t1, entry, direction);
        }
      }

      const today = getTodayISTDateStr();
      const shouldSquareOff = trade.date < today || (trade.date === today && isIntradaySquareOffTimeIST());
      if (shouldSquareOff && (status === "ACTIVE" || status === "TARGET 1 HIT")) {
        const squareOffCandle = postSignalCandles.at(-1);
        status = "SQUARED OFF";
        hitTime = squareOffCandle ? getISTTimeStr(squareOffCandle.t) : "15:15";
        exitPrice = squareOffCandle?.c ?? exitPrice;
        if (maxTargetReached >= 1 && exitPrice !== null) {
          plPctOverride = plPctForScaledExit(entry, t1, exitPrice, direction);
        }
      }

      const plPct = plPctOverride ?? (exitPrice !== null ? plPctForExit(entry, exitPrice, direction) : null);

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
