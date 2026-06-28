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
const SWING_MAX_RISK_PCT = 6.0;
const SWING_MIN_REWARD_RISK = 1.5;
const SWING_MIN_AVG_TURNOVER = 10_000_000 * 10;
const SWING_PUBLIC_SHARE_MIN_TURNOVER = 10_000_000 * 20;
const SWING_MIN_SECTOR_RELATIVE_STRENGTH = 0.25;
const SWING_MIN_PULLBACK_GAP_PCT = 0.5;
const SWING_MIN_CONSOLIDATION_CANDLES = 3;
const SWING_EXPECTED_HOLD_DAYS = 8;
const SWING_ENTRY_VALID_TRADING_DAYS = 2;
const SWING_MIN_TRIGGER_CLOSE_BUFFER_PCT = 0.05;
const SWING_NIFTY_TOKEN = "99926000";
const MAX_SWING_SCAN_JOBS = 8;
const DD_MIN_TOP_PICK_SCORE = 5;
const DD_MAX_RANKED_ENTRY_GAP_PERCENT = 3.0;
const DD_OPPORTUNITY_SCORE_CURVE_SCALE = 1.75;
const DD_TARGET_RISK_REWARD = 1.8;
const DD_TARGET_MAX_GAIN_PCT = 8.0;
const DD_TARGET_NEUTRAL_MAX_GAIN_PCT = 6.0;
const DD_EXHAUSTION_RVOL_THRESHOLD = 5.0;
const DD_EXHAUSTION_EMA20_DISTANCE_THRESHOLD = 8.0;
const DD_EXHAUSTION_DAILY_MOVE_THRESHOLD = 8.0;
const DD_LATE_BREAKOUT_20D_RETURN_THRESHOLD = 35.0;
const DD_LATE_BREAKOUT_40D_RETURN_THRESHOLD = 60.0;
const DD_LATE_BREAKOUT_EMA20_DISTANCE_THRESHOLD = 8.0;
const DD_OVEREXTENDED_20D_RETURN_THRESHOLD = 30.0;
const DD_OVEREXTENDED_40D_RETURN_THRESHOLD = 50.0;
const DD_OVEREXTENDED_EMA20_DISTANCE_THRESHOLD = 10.0;
const DD_OVEREXTENDED_LATEST_MOVE_THRESHOLD = 8.0;
const DD_MAX_EXHAUSTION_RANKING_PENALTY = 2.0;
const SWING_MIN_INDEX_DAILY_ADX = 25.0;
const SWING_STRONG_RS55 = 70.0;
const SWING_MIN_ACCEPTABLE_RS55 = 50.0;
const SWING_MIN_ACCEPTABLE_TECHNICAL_RVOL = 0.80;
const SWING_MIN_FALLBACK_TECHNICAL_RVOL = 1.0;
const SWING_INTRADAY_STRUCTURE_LOOKBACK = 6;
const MARKET_STATS_URL = "https://brkpoint.in/api/market-stats";
const MARKET_STATS_CACHE_TTL_MS = 15 * 60 * 1000;
const INDUSTRY_STRENGTH_URL = "https://www.brkpoint.in/api/brkview/industry-strength-analysis";
const INDUSTRY_STRENGTH_FALLBACK_URL = "https://brkpoint.in/api/brkview/industry-strength-analysis";
const INDUSTRY_STRENGTH_CACHE_TTL_MS = 15 * 60 * 1000;
const INDEX_TREND_URL = "https://www.brkpoint.in/api/indextrend";
const INDEX_TREND_CACHE_TTL_MS = 5 * 60 * 1000;
const TECHNICAL_INDICATORS_URL = "https://www.brkpoint.in/api/technical-indicators";
const TECHNICAL_INDICATORS_CACHE_TTL_MS = 5 * 60 * 1000;
const INSIDER_TRADING_URL = "https://www.brkpoint.in/api/insider-trading";
const INSIDER_TRADING_CACHE_TTL_MS = 30 * 60 * 1000;
const INSIDER_ACTIVITY_LOOKBACK_DAYS = 30;
const INSIDER_ACTIVITY_MIN_VALUE = 5_000_000; // Rs 50 lakh
const INSIDER_ACTIVITY_SIGNIFICANT_VALUE = 10_000_000; // Rs 1 crore
const INSIDER_ACTIVITY_MAJOR_VALUE = 50_000_000; // Rs 5 crore
const INSIDER_BUY_SCORE_CAP = 0.50;
const INSIDER_SELL_SCORE_CAP = -0.70;
const MARKET_REGIME_BULL_BREADTH_THRESHOLD = 60.0;
const MARKET_REGIME_WEAK_BREADTH_THRESHOLD = 50.0;
const STRICT_WEAK_MARKET_SIGNAL_BREADTH_THRESHOLD = 30.0;
const WEAK_MARKET_REGIME_SCORE_MULTIPLIER = 0.90;
const WEAK_INDUSTRY_ADVANCE_RATIO_THRESHOLD = 0.20;
const WEAK_INDUSTRY_BREADTH_PENALTY = -0.30;
const POSITIVE_INDUSTRY_AVG_CHANGE_THRESHOLD = 0.40;
const STRONG_INDUSTRY_AVG_CHANGE_THRESHOLD = 1.00;
const WEAK_INDUSTRY_AVG_CHANGE_THRESHOLD = -0.50;
const VERY_WEAK_INDUSTRY_AVG_CHANGE_THRESHOLD = -1.00;
const POSITIVE_INDUSTRY_AVG_CHANGE_BONUS = 0.12;
const STRONG_INDUSTRY_AVG_CHANGE_BONUS = 0.25;
const WEAK_INDUSTRY_AVG_CHANGE_PENALTY = -0.15;
const VERY_WEAK_INDUSTRY_AVG_CHANGE_PENALTY = -0.30;
const INDUSTRY_STRENGTH_BONUS_CAP = 0.45;
const INDUSTRY_STRENGTH_PENALTY_CAP = -0.55;
const INDUSTRY_STRENGTH_MIN_FULL_WEIGHT_STOCKS = 8;
const INDUSTRY_STRENGTH_MIN_PARTIAL_WEIGHT_STOCKS = 5;
const BANK_WEAK_MARKET_SECTOR_SCORE_PENALTY = -0.40;
const SWING_INDEX_TREND_BULLISH_BONUS = 0.25;
const SWING_INDEX_TREND_NEUTRAL_PENALTY = -0.10;
const SWING_INDEX_TREND_BEARISH_PENALTY = -0.55;
const INTRADAY_INDEX_ALIGNED_SCORE_BONUS = 0.70;
const INTRADAY_INDEX_CAUTION_SCORE_PENALTY = -0.75;
const TECHNICAL_SCORE_BONUS_CAP = 0.85;
const TECHNICAL_SCORE_PENALTY_CAP = -1.10;
const DD_RANKING_WEIGHTS = {
  relativeStrength: 0.35,
  rvol: 0.25,
  sector: 0.20,
  liquidity: 0.10,
  entry: 0.10,
};
const MARKET_STATS_INDUSTRY_ALIASES: Record<string, string> = {
  Auto: "Automobile and Auto Components",
  Bank: "Financial Services",
  Finance: "Financial Services",
  Insurance: "Financial Services",
  ConstructionMaterials: "Construction Materials",
  CapitalGoods: "Capital Goods",
  Chemicals: "Chemicals",
  FMCG: "Fast Moving Consumer Goods",
  Healthcare: "Healthcare",
  IT: "Information Technology",
  ConsumerDurables: "Consumer Durables",
  Jewellery: "Consumer Durables",
  Electricals: "Capital Goods",
  Agri: "Agricultural Food & other Products",
  Hospitality: "Consumer Services",
  "Consumer Services": "Consumer Services",
  Retail: "Consumer Services",
  Textiles: "Textiles",
  Industrial_Gases_Fuels: "Oil Gas & Consumable Fuels",
  Logistics: "Services",
  Trading: "Services",
  Aviation: "Services",
  Alcohol: "Fast Moving Consumer Goods",
  Plastic: "Chemicals",
  ShipBuilding: "Capital Goods",
  Defence: "Capital Goods",
  Media: "Media Entertainment & Publication",
  Footwear: "Consumer Durables",
  Manufacturing: "Capital Goods",
  Infrastructure: "Construction",
  Paper: "Forest Materials",
  ContainersPackaging: "Forest Materials",
  PhotographicProducts: "Consumer Durables",
  Metals: "Metals & Mining",
  OilGas: "Oil Gas & Consumable Fuels",
  Power: "Power",
  RealEstate: "Realty",
  Telecom: "Telecommunication",
};
const INDUSTRY_STRENGTH_EXTRA_ALIASES: Record<string, string[]> = {
  Power: ["Utilities"],
  OilGas: ["Energy", "Oil Gas & Consumable Fuels"],
  Media: ["Media Entertainment & Publication"],
  ConstructionMaterials: ["Construction Materials"],
  RealEstate: ["Realty"],
  IT: ["Information Technology"],
  Auto: ["Automobile and Auto Components"],
};
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
let marketStatsCache: { fetchedAt: number; payload: MarketStatsPayload | null } | null = null;
let industryStrengthCache: { fetchedAt: number; payload: IndustryStrengthPayload | null } | null = null;
let indexTrendCache: { fetchedAt: number; payload: IndexTrendPayload | null } | null = null;
let technicalIndicatorsCache: { fetchedAt: number; rows: TechnicalIndicatorRow[] } | null = null;
let insiderTradingCache: { fetchedAt: number; rows: InsiderTradingRow[] } | null = null;

interface SwingUniverseStock {
  symbol: string;
  sectorName: string;
  ltp: number;
  changePct: number;
}

type DdSwingSetupType =
  | "fresh_breakout"
  | "sector_leader_continuation"
  | "mean_reversion_bounce"
  | "high_rvol_explosive"
  | "slow_institutional_trend"
  | "trend_continuation";

type InsiderActivityDirection = "Buy" | "Sell" | "Mixed" | "None";
type IndexTrendDirection = "Bullish" | "Bearish" | "Neutral" | "Unknown";
type MarketAlignmentStatus = "ALIGNED" | "CAUTION" | "BLOCKED" | "UNKNOWN";
type TechnicalTrendDirection = "Bullish" | "Bearish" | "Neutral" | "Unknown";

interface SwingCandidate {
  symbol: string;
  sector: string;
  tradeDate: string;
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
  riskPct: number;
  rewardRisk: number;
  breakoutQuality: string;
  trendPersistence: number;
  freshBreakoutAge: number | null;
  consolidationCandles: number;
  setupType: DdSwingSetupType;
  latestMovePct: number;
  ema20DistancePct: number;
  liquidityScore: number;
  intradaySignal: string;
  swingSignal: string;
  shortTermSignal: string;
  longTermSignal: string;
  breakoutSignal: string;
  ichimokuTrend: string;
  marketRegime: "Bull" | "Neutral" | "Weak" | "Unknown";
  marketBreadthPct: number | null;
  industryAdvanceRatio: number | null;
  industryBreadthText: string | null;
  weakMarketSignalDowngrade: boolean;
  indexTrendIndex: string | null;
  indexTrendDirection: IndexTrendDirection;
  indexTrendText: string | null;
  indexTrendScoreAdjustment: number;
  technicalStage: string | null;
  technicalScoreAdjustment: number;
  technicalIndicatorText: string | null;
  technicalRs55: number | null;
  technicalVolumeRatio: number | null;
  technicalAboveEma200: boolean | null;
  technicalMacdTrend: TechnicalTrendDirection;
  technicalAdxTrend: TechnicalTrendDirection;
  insiderActivity: InsiderActivityDirection;
  insiderScoreAdjustment: number;
  insiderActivityText: string | null;
  insiderTransactionValue: number | null;
  insiderTransactionDate: string | null;
  insiderCategory: string | null;
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
  marketRegime: MarketRegimeSnapshot["marketRegime"];
  marketBreadthPct: number | null;
  diagnostics: SwingScannerDiagnostics;
  picks: SwingCandidate[];
}

interface SwingScannerDiagnostics {
  rawCandidates: number;
  finalCandidates: number;
  availableCandidates: number;
  excludedOpenSymbols: number;
  technicalIndicatorSymbols: number;
  technicalDataAvailable: boolean;
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

interface MarketStatsIndustryRow {
  Industry?: string;
  total?: number;
  advancing?: number;
  declining?: number;
  unchanged?: number;
  totalChange?: number;
  avgChange?: number;
}

interface MarketStatsPayload {
  breadth?: {
    total?: number;
    advancing?: number;
    declining?: number;
  };
  industry?: MarketStatsIndustryRow[];
}

interface IndustryStrengthRotationPattern {
  pattern?: string;
  description?: string;
  signal?: string;
  confidence?: string;
}

interface IndustryStrengthRow {
  industry?: string;
  total_stocks?: number | string;
  advance_percentage?: number | string;
  overall_trend?: string;
  day_performance_change?: number | string;
  week_performance_change?: number | string;
  month_performance_change?: number | string;
  day_strength?: string;
  week_strength?: string;
  month_strength?: string;
  current_avg_change?: number | string;
  advance_decline_ratio?: number | string;
  top_gainer?: string;
  top_gainer_change?: number | string;
  top_loser?: string;
  top_loser_change?: number | string;
  rotation_pattern?: IndustryStrengthRotationPattern;
  momentum_score?: number | string;
}

interface IndustryStrengthPayload {
  industries?: IndustryStrengthRow[];
}

interface IndustryStrengthImpact {
  adjustment: number;
  text: string | null;
  source: "brkview" | "market_stats" | "none";
}

interface IndexTrendBlock {
  timestamp?: string;
  interval?: string;
  symbol?: string;
  close_price?: number;
  indicators?: Record<string, number | string | null | undefined>;
  analysis?: {
    "15m_trend"?: string;
    "1h_trend"?: string;
    "1d_trend"?: string;
    ADX_analysis?: {
      value?: number;
      direction?: string;
      trend_strength_classification?: string;
      di_spread?: number;
    };
    MACD_analysis?: {
      crossover?: string;
      momentum?: string;
      histogram?: number;
    };
    EMA_analysis?: {
      price_vs_21ema?: string;
      price_vs_50ema?: string;
      ema_crossovers?: {
        golden_cross?: boolean;
        death_cross?: boolean;
      };
    };
    Supertrend_analysis?: {
      signal?: string;
    };
    trend_strength?: string;
  };
  validation?: {
    uptrend_conditions_met?: boolean;
    downtrend_conditions_met?: boolean;
    strong_uptrend_conditions_met?: boolean;
    strong_downtrend_conditions_met?: boolean;
  };
}

interface IndexTrendPayload {
  nif_min15trend?: IndexTrendBlock;
  bnf_min15trend?: IndexTrendBlock;
  nif_hr1trend?: IndexTrendBlock;
  bnf_hr1trend?: IndexTrendBlock;
  nif_day1trend?: IndexTrendBlock;
  bnf_day1trend?: IndexTrendBlock;
}

interface IntradayMarketAlignment {
  status: MarketAlignmentStatus;
  scoreAdjustment: number;
  text: string | null;
  indexName: "NIFTY" | "BANKNIFTY" | null;
}

type ScannerWarningCode =
  | "NO_CANDLE_DATA"
  | "NO_CONFIRMED_CANDLES"
  | "DB_PERSIST_FAILED"
  | "INDICATOR_ENRICH_FAILED"
  | "SECTOR_SCAN_FAILED";

interface ScannerWarning {
  symbol: string | null;
  sectorName: string | null;
  code: ScannerWarningCode;
  message: string;
}

interface SwingIndexTrendImpact {
  indexName: "NIFTY" | "BANKNIFTY" | null;
  direction: IndexTrendDirection;
  scoreAdjustment: number;
  text: string | null;
}

interface TechnicalIndicatorRow {
  tradingsymbol?: string;
  live_price?: number | string;
  high_52w?: number | string;
  low_52w?: number | string;
  stage?: string | null;
  rsi?: number | string | null;
  rs_55?: number | string | null;
  ema20?: number | string | null;
  ema50?: number | string | null;
  ema200?: number | string | null;
  adx?: number | string | null;
  plusdi?: number | string | null;
  minusdi?: number | string | null;
  consolidation_range?: string | null;
  volume_ratio?: number | string | null;
  adx_trend?: string | null;
  volume_trend?: string | null;
  macd_trend?: string | null;
  above_ema20?: boolean | null;
  above_ema50?: boolean | null;
  above_ema200?: boolean | null;
  next_target?: number | string | null;
  stop_loss?: number | string | null;
  MTF?: string | null;
  FNO?: string | null;
  price_source?: string | null;
}

interface TechnicalIndicatorsPayload {
  success?: boolean;
  data?: TechnicalIndicatorRow[];
  totalCount?: number;
  lastUpdated?: string;
  redis_available?: boolean;
}

interface TechnicalIndicatorImpact {
  stage: string | null;
  scoreAdjustment: number;
  text: string | null;
  rs55: number | null;
  volumeRatio: number | null;
  aboveEma200: boolean | null;
  macdTrend: TechnicalTrendDirection;
  adxTrend: TechnicalTrendDirection;
}

interface InsiderTradingRow {
  symbol?: string;
  company_name?: string;
  category?: string;
  acquirer_name?: string;
  transaction_type?: string;
  transaction_value?: number | string;
  shares_transacted?: number | string;
  percentage_prior?: number | string;
  percentage_post?: number | string;
  BROADCASTE_date?: string;
  BROADCASTE_date_raw?: string;
  transaction_date_from?: string;
  date_of_intimation?: string;
  mode_of_acquisition?: string;
  fetched_at?: string;
}

interface InsiderActivityImpact {
  activity: InsiderActivityDirection;
  scoreAdjustment: number;
  text: string | null;
  transactionValue: number | null;
  transactionDate: string | null;
  category: string | null;
}

interface MarketRegimeSnapshot {
  marketRegime: "Bull" | "Neutral" | "Weak" | "Unknown";
  marketBreadthAbove: number | null;
  marketBreadthTotal: number | null;
  marketBreadthPct: number | null;
  marketBreadthSource: "brkpoint_market_stats" | "unavailable";
  niftyAboveEma20: boolean | null;
  niftyAboveEma50: boolean | null;
  marketStats: MarketStatsPayload | null;
}

type SwingTradeStatus = "WATCHLIST" | "ACTIVE" | "TARGET HIT" | "SL HIT" | "EXIT REVIEW" | "CLOSED" | "EXPIRED";
const OPEN_SWING_TRADE_STATUSES: SwingTradeStatus[] = ["WATCHLIST", "ACTIVE", "EXIT REVIEW"];

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
  indexTrendIndex: string | null;
  indexTrendDirection: IndexTrendDirection | null;
  indexTrendText: string | null;
  indexTrendScoreAdjustment: string;
  technicalStage: string | null;
  technicalScoreAdjustment: string;
  technicalIndicatorText: string | null;
  technicalRs55: string | null;
  technicalVolumeRatio: string | null;
  technicalAboveEma200: boolean | null;
  technicalMacdTrend: TechnicalTrendDirection | null;
  technicalAdxTrend: TechnicalTrendDirection | null;
  insiderActivity: InsiderActivityDirection | null;
  insiderScoreAdjustment: string;
  insiderActivityText: string | null;
  insiderTransactionValue: string | null;
  insiderTransactionDate: string | null;
  insiderCategory: string | null;
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
  return mins >= 555 && mins <= 690;
}

function isSignalTimeInEntryWindowIST(signalTime: string): boolean {
  const ms = Date.parse(signalTime);
  if (Number.isNaN(ms)) return false;
  const mins = getISTMinuteOfDay(Math.floor(ms / 1000));
  return mins >= ENTRY_SIGNAL_START_MIN_IST && mins <= ENTRY_SIGNAL_END_MIN_IST;
}

function getISTDateAndMinuteFromIso(value: string): { date: string; minute: number } | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;

  const ist = new Date(ms + IST_OFFSET_MS);
  return {
    date: ist.toISOString().slice(0, 10),
    minute: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

function swingEntryDateIsEligible(candleDate: string, signalTime: string, fallbackSignalDate: string): boolean {
  const signal = getISTDateAndMinuteFromIso(signalTime);
  if (!signal) return candleDate > fallbackSignalDate;
  if (candleDate < signal.date) return false;
  if (candleDate > signal.date) return true;

  return signal.minute <= ENTRY_SIGNAL_START_MIN_IST;
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

function build1DStrategySignal(
  candle: Candle,
  direction: SignalDirection,
  setup: string,
  sl: number,
): PriceActionSignal | null {
  const entry = candle.c;
  
  const risk = Math.max(Math.abs(entry - sl), entry * 0.001); 
  const dir = direction === "LONG" ? 1 : -1;
  const target1 = entry + (risk * 2 * dir);
  const target2 = target1;
  
  const rewardRisk = 2.0;
  const riskPct = r2((risk / entry) * 100);
  
  const action = direction === "LONG" ? "BUY" : "SELL";
  const smartExit =
    `${action} . Entry Rs ${entry.toFixed(2)}. ` +
    `SL at Rs ${sl.toFixed(2)}. Target Rs ${target1.toFixed(2)}. ` +
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
  warning: ScannerWarning | null;
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
  marketAlignment: MarketAlignmentStatus;
  marketAlignmentText: string | null;
  marketTrendScoreAdjustment: number;
  marketTrendIndex: "NIFTY" | "BANKNIFTY" | null;
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

  const tradingDates = Array.from(
    new Set(historicalCandles.map((c) => getISTDateStr(c.t))),
  );
  if (tradingDates.length < 2) return null;
  
  const prevDate = tradingDates[tradingDates.length - 2];
  const prevCandles = historicalCandles.filter((c) => getISTDateStr(c.t) === prevDate);
  if (prevCandles.length === 0) return null;

  const prevDayHigh = Math.max(...prevCandles.map((c) => c.h));
  const prevDayLow = Math.min(...prevCandles.map((c) => c.l));

  for (let i = sessionCandles.length - 1; i >= 0; i--) {
    const candle = sessionCandles[i];
    if (getCandleCloseDateIST(candle) !== today || !candleClosesInEntryWindow(candle)) continue;

    const signalAgeSecs = latestCloseSecs - (candle.t + CANDLE_INTERVAL_SECS);
    if (signalAgeSecs > maxSignalAgeSecs) break;

    let direction: SignalDirection | null = null;
    let setup = "";
    let sl = 0;

if (i === 0) {
      if (candle.o < prevDayLow * 0.999) {
        direction = "SHORT";
        setup = "1D LOW GAP DOWN";
        sl = candle.h;
      } else if (candle.o > prevDayHigh * 1.001) {
        direction = "LONG";
        setup = "1D HIGH GAP UP";
        sl = candle.l;
      }
    }

if (!direction) {
      const TOUCH_BUFFER_PCT = 0.0075; // 0.75% buffer for touches
      if (candle.h >= prevDayHigh * (1 - TOUCH_BUFFER_PCT)) {
        if (candle.c > prevDayHigh) {
          direction = "LONG";
          setup = "1D HIGH BREAKOUT";
          sl = Math.min(candle.l, prevDayHigh * 0.999);
        } else {
          direction = "SHORT";
          setup = "1D HIGH REJECTION";
          sl = Math.max(candle.h, prevDayHigh * 1.001);
        }
      } else if (candle.l <= prevDayLow * (1 + TOUCH_BUFFER_PCT)) {
        if (candle.c < prevDayLow) {
          direction = "SHORT";
          setup = "1D LOW BREAKDOWN";
          sl = Math.max(candle.h, prevDayLow * 1.001);
        } else {
          direction = "LONG";
          setup = "1D LOW SUPPORT";
          sl = Math.min(candle.l, prevDayLow * 0.999);
        }
      }
    }

    if (direction) {
      return build1DStrategySignal(candle, direction, setup, sl);
    }
  }

  return null;
}

function unknownErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "Unknown error");
}

function scannerWarning(
  symbol: string | null,
  sectorName: string | null | undefined,
  code: ScannerWarningCode,
  message: string,
): ScannerWarning {
  return {
    symbol,
    sectorName: sectorName ?? null,
    code,
    message,
  };
}

async function enrichWithIndicators(
  symbol: string,
  sectorName?: string,
  indexTrend?: IndexTrendPayload | null,
): Promise<IndicatorResult> {
  const empty: IndicatorResult = {
    warning: null,
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
    marketAlignment: "UNKNOWN",
    marketAlignmentText: null,
    marketTrendScoreAdjustment: 0,
    marketTrendIndex: null,
  };
  const withWarning = (warning: ScannerWarning): IndicatorResult => ({
    ...empty,
    warning,
  });

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
    if (!candleData) {
      return withWarning(scannerWarning(
        symbol,
        sectorName,
        "NO_CANDLE_DATA",
        "No candle data returned from Angel One or Moneycontrol.",
      ));
    }

    const { sessionCandles, historicalCandles, lastTradingDate } = candleData;

    const confirmedSession = getConfirmedCandles(sessionCandles);
    const confirmedHistorical = getConfirmedCandles(historicalCandles);
    if (confirmedSession.length === 0) {
      return withWarning(scannerWarning(
        symbol,
        sectorName,
        "NO_CONFIRMED_CANDLES",
        "Candle feed returned no fully closed candles for the current session.",
      ));
    }

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
    let marketAlignment: IntradayMarketAlignment = {
      status: "UNKNOWN",
      scoreAdjustment: 0,
      text: null,
      indexName: null,
    };

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
      marketAlignment = intradayIndexTrendAlignment(sectorName ?? "", direction, indexTrend ?? null);
      if (marketAlignment.status === "BLOCKED") {
        entrySignal = false;
        alertEligible = false;
      }

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
        marketAlignment = intradayIndexTrendAlignment(sectorName ?? "", entryMatch.direction, indexTrend ?? null);

        if (marketAlignment.status === "BLOCKED") {
          entrySignal = false;
        } else try {
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
          return withWarning(scannerWarning(
            symbol,
            sectorName,
            "DB_PERSIST_FAILED",
            `Failed to save generated trade signal: ${unknownErrorMessage(dbErr)}`,
          ));
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
      warning: null,
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
      marketAlignment: marketAlignment.status,
      marketAlignmentText: marketAlignment.text,
      marketTrendScoreAdjustment: r2(marketAlignment.scoreAdjustment),
      marketTrendIndex: marketAlignment.indexName,
    };
  } catch (err) {
    return withWarning(scannerWarning(
      symbol,
      sectorName,
      "INDICATOR_ENRICH_FAILED",
      `Indicator enrichment failed: ${unknownErrorMessage(err)}`,
    ));
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

function calculateSwingRecentReturn(candles: Candle[], lookback = 5): number | null {
  const validCandles = candles
    .filter((c) => [c.o, c.h, c.l, c.c].every((value) => Number.isFinite(value) && value > 0))
    .sort((a, b) => a.t - b.t);
  if (validCandles.length < 2) return null;
  const closes = validCandles.map((c) => c.c);
  const windowStart = closes.at(-lookback) ?? closes.at(0);
  const latest = closes.at(-1);
  if (!latest || !windowStart) return null;
  return percentChange(latest, windowStart);
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
      await pool.query(`
        ALTER TABLE swing_trades
        ADD COLUMN IF NOT EXISTS index_trend_index TEXT,
        ADD COLUMN IF NOT EXISTS index_trend_direction TEXT,
        ADD COLUMN IF NOT EXISTS index_trend_text TEXT,
        ADD COLUMN IF NOT EXISTS index_trend_score_adjustment NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS technical_stage TEXT,
        ADD COLUMN IF NOT EXISTS technical_score_adjustment NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS technical_indicator_text TEXT,
        ADD COLUMN IF NOT EXISTS technical_rs55 NUMERIC,
        ADD COLUMN IF NOT EXISTS technical_volume_ratio NUMERIC,
        ADD COLUMN IF NOT EXISTS technical_above_ema200 BOOLEAN,
        ADD COLUMN IF NOT EXISTS technical_macd_trend TEXT,
        ADD COLUMN IF NOT EXISTS technical_adx_trend TEXT,
        ADD COLUMN IF NOT EXISTS insider_activity TEXT,
        ADD COLUMN IF NOT EXISTS insider_score_adjustment NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS insider_activity_text TEXT,
        ADD COLUMN IF NOT EXISTS insider_transaction_value NUMERIC,
        ADD COLUMN IF NOT EXISTS insider_transaction_date TEXT,
        ADD COLUMN IF NOT EXISTS insider_category TEXT
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

async function fetchMarketStats(): Promise<MarketStatsPayload | null> {
  if (marketStatsCache && Date.now() - marketStatsCache.fetchedAt < MARKET_STATS_CACHE_TTL_MS) {
    return marketStatsCache.payload;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(MARKET_STATS_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = payload && typeof payload === "object" ? payload as MarketStatsPayload : null;
    marketStatsCache = { fetchedAt: Date.now(), payload: parsed };
    return parsed;
  } catch (err) {
    console.warn("[SWING] Failed to fetch market stats breadth.", err);
    marketStatsCache = { fetchedAt: Date.now(), payload: null };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchIndustryStrengthAnalysis(): Promise<IndustryStrengthPayload | null> {
  if (
    industryStrengthCache &&
    Date.now() - industryStrengthCache.fetchedAt < INDUSTRY_STRENGTH_CACHE_TTL_MS
  ) {
    return industryStrengthCache.payload;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let authFailureStatus: number | null = null;
    for (const url of [INDUSTRY_STRENGTH_URL, INDUSTRY_STRENGTH_FALLBACK_URL]) {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json, text/plain, */*",
        },
        signal: controller.signal,
      });
      if ([401, 403].includes(response.status)) {
        authFailureStatus = response.status;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const parsed = payload && typeof payload === "object" ? payload as IndustryStrengthPayload : null;
      industryStrengthCache = { fetchedAt: Date.now(), payload: parsed };
      return parsed;
    }

    console.info(
      `[SWING] Industry strength provider returned HTTP ${authFailureStatus ?? 401}; continuing without industry-strength enrichment.`,
    );
    industryStrengthCache = { fetchedAt: Date.now(), payload: null };
    return null;
  } catch (err) {
    console.warn("[SWING] Failed to fetch industry strength analysis; continuing without industry-strength enrichment.", err);
    industryStrengthCache = { fetchedAt: Date.now(), payload: null };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "1"].includes(text)) return true;
  if (["false", "no", "0"].includes(text)) return false;
  return null;
}

async function fetchTechnicalIndicatorRows(): Promise<TechnicalIndicatorRow[]> {
  if (
    technicalIndicatorsCache &&
    Date.now() - technicalIndicatorsCache.fetchedAt < TECHNICAL_INDICATORS_CACHE_TTL_MS
  ) {
    return technicalIndicatorsCache.rows;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${TECHNICAL_INDICATORS_URL}?nocache=${Date.now()}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as TechnicalIndicatorsPayload;
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    technicalIndicatorsCache = { fetchedAt: Date.now(), rows };
    return rows;
  } catch (err) {
    console.warn("[SWING] Failed to fetch technical indicator context.", err);
    technicalIndicatorsCache = { fetchedAt: Date.now(), rows: [] };
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTechnicalTrend(value: unknown): TechnicalTrendDirection {
  const text = String(value ?? "").trim().toLowerCase();
  if (/bull|positive|up/.test(text)) return "Bullish";
  if (/bear|negative|down/.test(text)) return "Bearish";
  if (/neutral|flat|range|consolidation/.test(text)) return "Neutral";
  return "Unknown";
}

function technicalStageAdjustment(stage: string | null): number {
  const normalized = String(stage ?? "").toLowerCase().replace(/\s+/g, "");
  if (normalized === "stage2") return 0.45;
  if (normalized === "stage1") return -0.15;
  if (normalized === "stage3") return -0.30;
  if (normalized === "stage4") return -0.85;
  return 0;
}

function technicalRsAdjustment(rs55: number | null): number {
  if (rs55 === null) return 0;
  if (rs55 >= SWING_STRONG_RS55) return 0.30;
  if (rs55 >= 55) return 0.15;
  if (rs55 < 25) return -0.45;
  if (rs55 < 40) return -0.25;
  if (rs55 < 50) return -0.10;
  return 0;
}

function technicalEmaAdjustment(row: TechnicalIndicatorRow): number {
  const above20 = booleanOrNull(row.above_ema20);
  const above50 = booleanOrNull(row.above_ema50);
  const above200 = booleanOrNull(row.above_ema200);
  let score = 0;
  if (above20 === true) score += 0.07;
  if (above20 === false) score -= 0.12;
  if (above50 === true) score += 0.10;
  if (above50 === false) score -= 0.18;
  if (above200 === true) score += 0.20;
  if (above200 === false) score -= 0.35;
  return score;
}

function technicalAdxAdjustment(row: TechnicalIndicatorRow, adxTrend: TechnicalTrendDirection): number {
  const adx = numberOrNull(row.adx);
  const plusDi = numberOrNull(row.plusdi);
  const minusDi = numberOrNull(row.minusdi);
  const diBullish = plusDi !== null && minusDi !== null ? plusDi > minusDi : adxTrend === "Bullish";
  const diBearish = plusDi !== null && minusDi !== null ? minusDi > plusDi : adxTrend === "Bearish";

  if (adx === null) return 0;
  if (adx >= 25 && diBullish) return 0.22;
  if (adx >= 20 && diBullish) return 0.10;
  if (adx >= 20 && diBearish) return -0.25;
  if (adx < 15) return -0.10;
  return 0;
}

function technicalVolumeAdjustment(volumeRatio: number | null): number {
  if (volumeRatio === null) return 0;
  if (volumeRatio >= 2) return 0.25;
  if (volumeRatio >= 1) return 0.10;
  if (volumeRatio < 0.30) return -0.35;
  if (volumeRatio < 0.50) return -0.25;
  if (volumeRatio < 0.80) return -0.10;
  return 0;
}

function technicalMacdAdjustment(macdTrend: TechnicalTrendDirection): number {
  if (macdTrend === "Bullish") return 0.15;
  if (macdTrend === "Bearish") return -0.20;
  return 0;
}

function technicalVolumeTrendAdjustment(volumeTrend: string | null | undefined): number {
  const text = String(volumeTrend ?? "").toLowerCase();
  if (/range|consolidation/.test(text)) return -0.15;
  if (/accumulation|breakout|expansion/.test(text)) return 0.10;
  return 0;
}

function technicalIndicatorText(row: TechnicalIndicatorRow, macdTrend: TechnicalTrendDirection, adxTrend: TechnicalTrendDirection): string {
  const stage = row.stage ? String(row.stage) : "stage ?";
  const rs55 = numberOrNull(row.rs_55);
  const volumeRatio = numberOrNull(row.volume_ratio);
  const above20 = booleanOrNull(row.above_ema20);
  const above50 = booleanOrNull(row.above_ema50);
  const above200 = booleanOrNull(row.above_ema200);
  const yesNo = (value: boolean | null) => value === null ? "?" : value ? "Y" : "N";
  const parts = [
    `Tech ${stage}`,
    rs55 !== null ? `RS55 ${r2(rs55)}` : null,
    `EMA20/50/200 ${yesNo(above20)}/${yesNo(above50)}/${yesNo(above200)}`,
    volumeRatio !== null ? `RVOL ${r2(volumeRatio)}x` : null,
    macdTrend !== "Unknown" ? `MACD ${macdTrend}` : null,
    adxTrend !== "Unknown" ? `ADX ${adxTrend}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join("; ");
}

function technicalIndicatorImpact(row: TechnicalIndicatorRow): TechnicalIndicatorImpact {
  const rs55 = numberOrNull(row.rs_55);
  const volumeRatio = numberOrNull(row.volume_ratio);
  const macdTrend = normalizeTechnicalTrend(row.macd_trend);
  const adxTrend = normalizeTechnicalTrend(row.adx_trend);
  const rawAdjustment =
    technicalStageAdjustment(row.stage ?? null) +
    technicalRsAdjustment(rs55) +
    technicalEmaAdjustment(row) +
    technicalAdxAdjustment(row, adxTrend) +
    technicalVolumeAdjustment(volumeRatio) +
    technicalMacdAdjustment(macdTrend) +
    technicalVolumeTrendAdjustment(row.volume_trend);

  return {
    stage: row.stage ? String(row.stage) : null,
    scoreAdjustment: r2(clamp(rawAdjustment, TECHNICAL_SCORE_PENALTY_CAP, TECHNICAL_SCORE_BONUS_CAP)),
    text: technicalIndicatorText(row, macdTrend, adxTrend),
    rs55,
    volumeRatio,
    aboveEma200: booleanOrNull(row.above_ema200),
    macdTrend,
    adxTrend,
  };
}

function passesSwingTechnicalLeadershipGate(
  candidate: SwingCandidate,
  technicalImpact: TechnicalIndicatorImpact | null,
  technicalDataAvailable: boolean,
): boolean {
  if (!technicalDataAvailable) {
    return candidate.rvol >= SWING_MIN_FALLBACK_TECHNICAL_RVOL;
  }

  if (!technicalImpact) {
    return candidate.rvol >= SWING_MIN_FALLBACK_TECHNICAL_RVOL;
  }

  const rs55 = technicalImpact?.rs55 ?? null;
  const rvol = technicalImpact?.volumeRatio ?? candidate.rvol;
  const stage = String(technicalImpact?.stage ?? "").toLowerCase().replace(/\s+/g, "");
  if (stage === "stage4") return false;
  if (rs55 !== null && rs55 < SWING_MIN_ACCEPTABLE_RS55) return false;
  if (rvol < SWING_MIN_ACCEPTABLE_TECHNICAL_RVOL) return false;

  return true;
}

function buildTechnicalIndicatorMap(rows: TechnicalIndicatorRow[]): Map<string, TechnicalIndicatorImpact> {
  const output = new Map<string, TechnicalIndicatorImpact>();
  for (const row of rows) {
    const symbol = normalizeEquitySymbol(String(row.tradingsymbol ?? ""));
    if (!symbol) continue;
    output.set(symbol, technicalIndicatorImpact(row));
  }
  return output;
}

async function fetchTechnicalIndicatorMap(): Promise<Map<string, TechnicalIndicatorImpact>> {
  const rows = await fetchTechnicalIndicatorRows();
  return buildTechnicalIndicatorMap(rows);
}

async function fetchIndexTrendPayload(): Promise<IndexTrendPayload | null> {
  if (indexTrendCache && Date.now() - indexTrendCache.fetchedAt < INDEX_TREND_CACHE_TTL_MS) {
    return indexTrendCache.payload;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(INDEX_TREND_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = payload && typeof payload === "object" ? payload as IndexTrendPayload : null;
    indexTrendCache = { fetchedAt: Date.now(), payload: parsed };
    return parsed;
  } catch (err) {
    console.warn("[SWING] Failed to fetch index trend context.", err);
    indexTrendCache = { fetchedAt: Date.now(), payload: null };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sectorUsesBankNifty(sector: string | null | undefined): boolean {
  const text = String(sector ?? "").replace(/[_-]+/g, " ").toLowerCase();
  return /(bank|financial|finance|fin service|finservice|fin nifty|finnifty|insurance|nbfc)/.test(text);
}

function indexTrendBlockFor(
  payload: IndexTrendPayload | null,
  sector: string,
  timeframe: "15m" | "1h" | "1d",
): IndexTrendBlock | null {
  if (!payload) return null;
  const bank = sectorUsesBankNifty(sector);
  if (timeframe === "15m") return bank ? payload.bnf_min15trend ?? null : payload.nif_min15trend ?? null;
  if (timeframe === "1h") return bank ? payload.bnf_hr1trend ?? null : payload.nif_hr1trend ?? null;
  return bank ? payload.bnf_day1trend ?? null : payload.nif_day1trend ?? null;
}

function indexNameForSector(sector: string | null | undefined): "NIFTY" | "BANKNIFTY" {
  return sectorUsesBankNifty(sector) ? "BANKNIFTY" : "NIFTY";
}

function trendLabelFromBlock(block: IndexTrendBlock | null): string | null {
  if (!block?.analysis) return null;
  return block.analysis["15m_trend"] ??
    block.analysis["1h_trend"] ??
    block.analysis["1d_trend"] ??
    null;
}

function indexTrendDirection(block: IndexTrendBlock | null): IndexTrendDirection {
  if (!block) return "Unknown";
  const label = String(trendLabelFromBlock(block) ?? "").toLowerCase();
  if (label.includes("strong uptrend") || label.includes("potential uptrend") || /\buptrend\b/.test(label)) {
    return "Bullish";
  }
  if (label.includes("strong downtrend") || label.includes("potential downtrend") || /\bdowntrend\b/.test(label)) {
    return "Bearish";
  }
  if (label.includes("neutral") || label.includes("consolidation")) return "Neutral";

  const validation = block.validation;
  if (validation?.strong_uptrend_conditions_met || validation?.uptrend_conditions_met) return "Bullish";
  if (validation?.strong_downtrend_conditions_met || validation?.downtrend_conditions_met) return "Bearish";

  const supertrend = Number(block.indicators?.Supertrend);
  if (Number.isFinite(supertrend) && supertrend > 0) return "Bullish";
  if (Number.isFinite(supertrend) && supertrend < 0) return "Bearish";
  return "Unknown";
}

function indexTrendAdxText(block: IndexTrendBlock | null): string {
  const adx = numberOrNull(block?.analysis?.ADX_analysis?.value);
  return adx !== null ? `, ADX ${r2(adx)}` : "";
}

function indexTrendAdxValue(block: IndexTrendBlock | null): number | null {
  return numberOrNull(block?.analysis?.ADX_analysis?.value);
}

function indexTrendSummary(indexName: string, timeframe: string, block: IndexTrendBlock | null): string | null {
  if (!block) return null;
  const label = trendLabelFromBlock(block) ?? indexTrendDirection(block);
  return `${indexName} ${timeframe} ${label}${indexTrendAdxText(block)}`;
}

function intradayIndexTrendAlignment(
  sector: string,
  direction: SignalDirection,
  payload: IndexTrendPayload | null,
): IntradayMarketAlignment {
  const indexName = indexNameForSector(sector);
  const min15 = indexTrendBlockFor(payload, sector, "15m");
  const hr1 = indexTrendBlockFor(payload, sector, "1h");
  const min15Direction = indexTrendDirection(min15);
  const hr1Direction = indexTrendDirection(hr1);
  const expected: IndexTrendDirection = direction === "LONG" ? "Bullish" : "Bearish";
  const opposite: IndexTrendDirection = direction === "LONG" ? "Bearish" : "Bullish";
  const directions = [min15Direction, hr1Direction].filter((value) => value !== "Unknown");
  const expectedCount = directions.filter((value) => value === expected).length;
  const oppositeCount = directions.filter((value) => value === opposite).length;
  const neutralCount = directions.filter((value) => value === "Neutral").length;
  const summaries = [
    indexTrendSummary(indexName, "15m", min15),
    indexTrendSummary(indexName, "1h", hr1),
  ].filter((item): item is string => Boolean(item));
  const text = summaries.length ? summaries.join("; ") : null;

  if (directions.length === 0) {
    return { status: "UNKNOWN", scoreAdjustment: 0, text, indexName };
  }
  if (oppositeCount >= 2) {
    return {
      status: "BLOCKED",
      scoreAdjustment: INTRADAY_INDEX_CAUTION_SCORE_PENALTY * 2,
      text: `${text ?? indexName} - blocked: index trend is opposite`,
      indexName,
    };
  }
  if (expectedCount >= 2) {
    return { status: "ALIGNED", scoreAdjustment: INTRADAY_INDEX_ALIGNED_SCORE_BONUS, text, indexName };
  }
  if (expectedCount === 1 && oppositeCount === 0) {
    return { status: "ALIGNED", scoreAdjustment: INTRADAY_INDEX_ALIGNED_SCORE_BONUS * 0.5, text, indexName };
  }
  if (neutralCount > 0 || oppositeCount > 0) {
    return { status: "CAUTION", scoreAdjustment: INTRADAY_INDEX_CAUTION_SCORE_PENALTY, text, indexName };
  }
  return { status: "UNKNOWN", scoreAdjustment: 0, text, indexName };
}

function swingIndexTrendImpact(sector: string, payload: IndexTrendPayload | null): SwingIndexTrendImpact {
  const indexName = indexNameForSector(sector);
  const day = indexTrendBlockFor(payload, sector, "1d");
  const direction = indexTrendDirection(day);
  const text = indexTrendSummary(indexName, "daily", day);
  const scoreAdjustment =
    direction === "Bullish" ? SWING_INDEX_TREND_BULLISH_BONUS
      : direction === "Bearish" ? SWING_INDEX_TREND_BEARISH_PENALTY
        : direction === "Neutral" ? SWING_INDEX_TREND_NEUTRAL_PENALTY
          : 0;

  return {
    indexName,
    direction,
    scoreAdjustment,
    text,
  };
}

function blocksSwingMarketTrendGate(sector: string, payload: IndexTrendPayload | null): boolean {
  const day = indexTrendBlockFor(payload, sector, "1d");
  const direction = indexTrendDirection(day);
  const adx = indexTrendAdxValue(day);
  return direction === "Bearish" && adx !== null && adx >= SWING_MIN_INDEX_DAILY_ADX;
}

async function fetchInsiderTradingRows(): Promise<InsiderTradingRow[]> {
  if (insiderTradingCache && Date.now() - insiderTradingCache.fetchedAt < INSIDER_TRADING_CACHE_TTL_MS) {
    return insiderTradingCache.rows;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(INSIDER_TRADING_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload as InsiderTradingRow[] : [];
    insiderTradingCache = { fetchedAt: Date.now(), rows };
    return rows;
  } catch (err) {
    console.warn("[SWING] Failed to fetch insider trading activity.", err);
    insiderTradingCache = { fetchedAt: Date.now(), rows: [] };
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function insiderTransactionDirection(row: InsiderTradingRow): Exclude<InsiderActivityDirection, "Mixed" | "None"> | null {
  const text = `${row.transaction_type ?? ""} ${row.mode_of_acquisition ?? ""}`.toLowerCase();
  if (/\b(sell|sale|sold|dispos|market sale)\b/.test(text)) return "Sell";
  if (/\b(buy|bought|purchase|purchas|acquir|allot)\b/.test(text)) return "Buy";
  return null;
}

function parseInsiderDateMs(row: InsiderTradingRow): number | null {
  for (const value of [
    row.transaction_date_from,
    row.date_of_intimation,
    row.BROADCASTE_date,
    row.fetched_at,
  ]) {
    const ms = Date.parse(String(value ?? ""));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function roleWeightForInsiderCategory(category: string | null): number {
  const text = String(category ?? "").toLowerCase();
  if (/(promoter|director|key managerial|kmp|whole time|managing director)/.test(text)) return 1.15;
  if (/connected/.test(text)) return 1.0;
  return 0.90;
}

function insiderValueScore(value: number, direction: "Buy" | "Sell", category: string | null): number {
  if (!Number.isFinite(value) || value < INSIDER_ACTIVITY_MIN_VALUE) return 0;

  let base = 0.15;
  if (value >= INSIDER_ACTIVITY_MAJOR_VALUE) {
    base = 0.50;
  } else if (value >= INSIDER_ACTIVITY_SIGNIFICANT_VALUE) {
    base = 0.30;
  }

  const weighted = base * roleWeightForInsiderCategory(category);
  return direction === "Sell" ? -weighted : weighted;
}

function formatInsiderValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  const crore = value / 10_000_000;
  return crore >= 1 ? `Rs ${r2(crore)} Cr` : `Rs ${r2(value / 100_000)} L`;
}

function formatShortISTDateFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const ist = new Date(ms + IST_OFFSET_MS);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]}`;
}

function insiderDateStringFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return getISTDateStr(Math.floor(ms / 1000));
}

function buildInsiderActivityMap(rows: InsiderTradingRow[]): Map<string, InsiderActivityImpact> {
  const cutoffMs = Date.now() - INSIDER_ACTIVITY_LOOKBACK_DAYS * 24 * 3600 * 1000;
  const grouped = new Map<string, Array<{
    direction: "Buy" | "Sell";
    score: number;
    value: number;
    dateMs: number | null;
    category: string | null;
  }>>();

  for (const row of rows) {
    const symbol = normalizeEquitySymbol(String(row.symbol ?? ""));
    if (!symbol) continue;

    const direction = insiderTransactionDirection(row);
    if (!direction) continue;

    const dateMs = parseInsiderDateMs(row);
    if (dateMs !== null && dateMs < cutoffMs) continue;

    const value = numberOrNull(row.transaction_value) ?? 0;
    const category = row.category ? String(row.category) : null;
    const score = insiderValueScore(value, direction, category);
    if (score === 0) continue;

    const bucket = grouped.get(symbol) ?? [];
    bucket.push({ direction, score, value, dateMs, category });
    grouped.set(symbol, bucket);
  }

  const output = new Map<string, InsiderActivityImpact>();
  for (const [symbol, impacts] of grouped.entries()) {
    const rawAdjustment = impacts.reduce((sum, impact) => sum + impact.score, 0);
    const scoreAdjustment = r2(clamp(rawAdjustment, INSIDER_SELL_SCORE_CAP, INSIDER_BUY_SCORE_CAP));
    const hasBuy = impacts.some((impact) => impact.direction === "Buy");
    const hasSell = impacts.some((impact) => impact.direction === "Sell");
    const activity: InsiderActivityDirection = hasBuy && hasSell ? "Mixed" : hasSell ? "Sell" : "Buy";
    const primary = impacts
      .slice()
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || (b.dateMs ?? 0) - (a.dateMs ?? 0))[0];
    const dateText = formatShortISTDateFromMs(primary?.dateMs ?? null);
    const categoryText = primary?.category ? `, ${primary.category}` : "";
    const text = primary
      ? `Insider ${primary.direction} ${formatInsiderValue(primary.value)}${categoryText}${dateText ? `, ${dateText}` : ""}`
      : null;

    output.set(symbol, {
      activity,
      scoreAdjustment,
      text,
      transactionValue: primary?.value ?? null,
      transactionDate: insiderDateStringFromMs(primary?.dateMs ?? null),
      category: primary?.category ?? null,
    });
  }

  return output;
}

async function fetchInsiderActivityMap(): Promise<Map<string, InsiderActivityImpact>> {
  const rows = await fetchInsiderTradingRows();
  return buildInsiderActivityMap(rows);
}

async function fetchNiftyRegimeSnapshot(): Promise<{ niftyAboveEma20: boolean | null; niftyAboveEma50: boolean | null }> {
  try {
    const candles = await fetchAngelDailyCandles("NIFTY", SWING_NIFTY_TOKEN);
    const closes = (candles ?? []).map((c) => c.c);
    const latest = closes.at(-1);
    const ema20 = emaSeries(closes, 20).at(-1) ?? null;
    const ema50 = emaSeries(closes, 50).at(-1) ?? null;
    return {
      niftyAboveEma20: latest !== undefined && ema20 !== null ? latest > ema20 : null,
      niftyAboveEma50: latest !== undefined && ema50 !== null ? latest > ema50 : null,
    };
  } catch (err) {
    console.warn("[SWING] NIFTY regime snapshot failed.", err);
    return { niftyAboveEma20: null, niftyAboveEma50: null };
  }
}

function marketStatsBreadthSummary(marketStats: MarketStatsPayload | null): {
  above: number | null;
  total: number | null;
  pct: number | null;
  source: MarketRegimeSnapshot["marketBreadthSource"];
} {
  const breadth = marketStats?.breadth;
  const total = numberOrNull(breadth?.total);
  const advancing = numberOrNull(breadth?.advancing);
  if (!total || total <= 0 || advancing === null) {
    return { above: null, total: null, pct: null, source: "unavailable" };
  }
  return {
    above: advancing,
    total,
    pct: (advancing / total) * 100,
    source: "brkpoint_market_stats",
  };
}

function marketRegimeFromInputs(
  niftySnapshot: { niftyAboveEma20: boolean | null; niftyAboveEma50: boolean | null },
  breadthPct: number | null,
): MarketRegimeSnapshot["marketRegime"] {
  if (niftySnapshot.niftyAboveEma20 === null || niftySnapshot.niftyAboveEma50 === null) {
    if (breadthPct !== null && breadthPct < MARKET_REGIME_WEAK_BREADTH_THRESHOLD) return "Weak";
    return "Unknown";
  }
  if (
    niftySnapshot.niftyAboveEma20 &&
    niftySnapshot.niftyAboveEma50 &&
    (breadthPct === null || breadthPct >= MARKET_REGIME_BULL_BREADTH_THRESHOLD)
  ) {
    return "Bull";
  }
  if (
    (!niftySnapshot.niftyAboveEma20 && !niftySnapshot.niftyAboveEma50) ||
    (breadthPct !== null && breadthPct < MARKET_REGIME_WEAK_BREADTH_THRESHOLD)
  ) {
    return "Weak";
  }
  return "Neutral";
}

async function fetchMarketRegimeSnapshot(): Promise<MarketRegimeSnapshot> {
  const [marketStats, niftySnapshot] = await Promise.all([
    fetchMarketStats(),
    fetchNiftyRegimeSnapshot(),
  ]);
  const breadth = marketStatsBreadthSummary(marketStats);
  return {
    marketRegime: marketRegimeFromInputs(niftySnapshot, breadth.pct),
    marketBreadthAbove: breadth.above,
    marketBreadthTotal: breadth.total,
    marketBreadthPct: breadth.pct,
    marketBreadthSource: breadth.source,
    niftyAboveEma20: niftySnapshot.niftyAboveEma20,
    niftyAboveEma50: niftySnapshot.niftyAboveEma50,
    marketStats,
  };
}

function marketRegimeScoreMultiplier(marketRegime: MarketRegimeSnapshot["marketRegime"]): number {
  return marketRegime === "Weak" ? WEAK_MARKET_REGIME_SCORE_MULTIPLIER : 1.0;
}

function industryLookupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function sectorIndustryLookupNames(sector: string): string[] {
  return Array.from(new Set([
    sector,
    MARKET_STATS_INDUSTRY_ALIASES[sector],
    ...(INDUSTRY_STRENGTH_EXTRA_ALIASES[sector] ?? []),
  ].filter((value): value is string => Boolean(value))));
}

function marketStatsIndustryLookup(marketStats: MarketStatsPayload | null): Map<string, MarketStatsIndustryRow> {
  const lookup = new Map<string, MarketStatsIndustryRow>();
  for (const row of marketStats?.industry ?? []) {
    if (row.Industry) lookup.set(row.Industry, row);
  }
  return lookup;
}

function marketStatsForSector(
  sector: string,
  marketStats: MarketStatsPayload | null,
): MarketStatsIndustryRow | null {
  const industryName = MARKET_STATS_INDUSTRY_ALIASES[sector] ?? sector;
  return marketStatsIndustryLookup(marketStats).get(industryName) ?? null;
}

function marketStatsSectorText(sector: string, marketStats: MarketStatsPayload | null): string | null {
  const stats = marketStatsForSector(sector, marketStats);
  const total = numberOrNull(stats?.total);
  const advancing = numberOrNull(stats?.advancing);
  if (!total || total <= 0 || advancing === null) return null;
  const avgChange = numberOrNull(stats?.avgChange);
  const avgChangeText = avgChange !== null ? `, Avg: ${r2(avgChange)}%` : "";
  return `${sector} Advance Breadth: ${Math.round(advancing)}/${Math.round(total)}${avgChangeText}`;
}

function marketStatsSectorAdvanceRatio(sector: string, marketStats: MarketStatsPayload | null): number | null {
  const stats = marketStatsForSector(sector, marketStats);
  const total = numberOrNull(stats?.total);
  const advancing = numberOrNull(stats?.advancing);
  if (!total || total <= 0 || advancing === null) return null;
  return advancing / total;
}

function marketStatsSectorAvgChange(sector: string, marketStats: MarketStatsPayload | null): number | null {
  const stats = marketStatsForSector(sector, marketStats);
  return numberOrNull(stats?.avgChange);
}

function industryBreadthPenalty(advanceRatio: number | null): number {
  if (advanceRatio === null) return 0.0;
  return advanceRatio < WEAK_INDUSTRY_ADVANCE_RATIO_THRESHOLD ? WEAK_INDUSTRY_BREADTH_PENALTY : 0.0;
}

function industryAvgChangeAdjustment(avgChange: number | null): number {
  if (avgChange === null) return 0.0;
  if (avgChange >= STRONG_INDUSTRY_AVG_CHANGE_THRESHOLD) return STRONG_INDUSTRY_AVG_CHANGE_BONUS;
  if (avgChange >= POSITIVE_INDUSTRY_AVG_CHANGE_THRESHOLD) return POSITIVE_INDUSTRY_AVG_CHANGE_BONUS;
  if (avgChange <= VERY_WEAK_INDUSTRY_AVG_CHANGE_THRESHOLD) return VERY_WEAK_INDUSTRY_AVG_CHANGE_PENALTY;
  if (avgChange <= WEAK_INDUSTRY_AVG_CHANGE_THRESHOLD) return WEAK_INDUSTRY_AVG_CHANGE_PENALTY;
  return 0.0;
}

function industryStrengthLookup(payload: IndustryStrengthPayload | null): Map<string, IndustryStrengthRow> {
  const lookup = new Map<string, IndustryStrengthRow>();
  for (const row of payload?.industries ?? []) {
    if (row.industry) lookup.set(industryLookupKey(row.industry), row);
  }
  return lookup;
}

function industryStrengthForSector(
  sector: string,
  payload: IndustryStrengthPayload | null,
): IndustryStrengthRow | null {
  const lookup = industryStrengthLookup(payload);
  for (const name of sectorIndustryLookupNames(sector)) {
    const row = lookup.get(industryLookupKey(name));
    if (row) return row;
  }
  return null;
}

function rotationSignalAdjustment(rotation: IndustryStrengthRotationPattern | undefined): number {
  const signal = String(rotation?.signal ?? rotation?.pattern ?? "").trim().toUpperCase();
  const confidence = String(rotation?.confidence ?? "").trim().toLowerCase();
  const confidenceMultiplier = confidence === "high" ? 1 : confidence === "medium" ? 0.7 : 0.35;
  if (/(BULL|BUY|POSITIVE|LEADING|ACCUMUL)/.test(signal)) return 0.18 * confidenceMultiplier;
  if (/(BEAR|SELL|NEGATIVE|LAGGING|DISTRIB)/.test(signal)) return -0.22 * confidenceMultiplier;
  return 0.0;
}

function industryStockCountWeight(totalStocks: number | null): number {
  if (totalStocks === null) return 1.0;
  if (totalStocks < INDUSTRY_STRENGTH_MIN_PARTIAL_WEIGHT_STOCKS) return 0.45;
  if (totalStocks < INDUSTRY_STRENGTH_MIN_FULL_WEIGHT_STOCKS) return 0.70;
  return 1.0;
}

function industryStrengthAdjustment(row: IndustryStrengthRow): number {
  const totalStocks = numberOrNull(row.total_stocks);
  const advancePct = numberOrNull(row.advance_percentage);
  const day = numberOrNull(row.day_performance_change);
  const week = numberOrNull(row.week_performance_change);
  const month = numberOrNull(row.month_performance_change);
  const currentAvg = numberOrNull(row.current_avg_change);
  const momentum = numberOrNull(row.momentum_score);
  const trend = String(row.overall_trend ?? "").trim().toLowerCase();

  let score = 0.0;
  if (advancePct !== null) {
    if (advancePct >= 75) score += 0.16;
    else if (advancePct >= 60) score += 0.08;
    else if (advancePct <= 30) score -= 0.22;
    else if (advancePct <= 40) score -= 0.12;
  }
  if (day !== null) {
    if (day >= 1.0) score += 0.08;
    else if (day <= -1.0) score -= 0.10;
  }
  if (week !== null) {
    if (week >= 1.0) score += 0.08;
    else if (week <= -2.0) score -= 0.12;
    else if (week <= -1.0) score -= 0.06;
  }
  if (month !== null) {
    if (month >= 5.0) score += 0.18;
    else if (month >= 2.0) score += 0.10;
    else if (month <= -3.0) score -= 0.18;
    else if (month <= -1.0) score -= 0.08;
  }
  if (currentAvg !== null) {
    if (currentAvg >= 1.0) score += 0.08;
    else if (currentAvg <= -1.0) score -= 0.10;
  }
  if (momentum !== null) {
    if (momentum >= 2.0) score += 0.12;
    else if (momentum >= 0.75) score += 0.06;
    else if (momentum <= -2.0) score -= 0.15;
    else if (momentum <= -0.75) score -= 0.08;
  }
  if (/positive|bull/.test(trend)) score += 0.05;
  if (/negative|bear/.test(trend)) score -= 0.07;
  score += rotationSignalAdjustment(row.rotation_pattern);

  return r2(clamp(
    score * industryStockCountWeight(totalStocks),
    INDUSTRY_STRENGTH_PENALTY_CAP,
    INDUSTRY_STRENGTH_BONUS_CAP,
  ));
}

function industryStrengthImpact(
  sector: string,
  payload: IndustryStrengthPayload | null,
  fallbackAvgChange: number | null,
): IndustryStrengthImpact {
  const row = industryStrengthForSector(sector, payload);
  if (!row) {
    const fallbackAdjustment = industryAvgChangeAdjustment(fallbackAvgChange);
    return {
      adjustment: r2(fallbackAdjustment),
      text: fallbackAvgChange !== null
        ? `Market stats avg ${r2(fallbackAvgChange)}%; sector avg adjustment ${r2(fallbackAdjustment)}`
        : null,
      source: fallbackAvgChange !== null ? "market_stats" : "none",
    };
  }

  const totalStocks = numberOrNull(row.total_stocks);
  const advancePct = numberOrNull(row.advance_percentage);
  const day = numberOrNull(row.day_performance_change);
  const week = numberOrNull(row.week_performance_change);
  const month = numberOrNull(row.month_performance_change);
  const momentum = numberOrNull(row.momentum_score);
  const rotationSignal = row.rotation_pattern?.signal ?? row.rotation_pattern?.pattern ?? "NEUTRAL";
  const confidence = row.rotation_pattern?.confidence ?? "n/a";
  const adjustment = industryStrengthAdjustment(row);
  const text = [
    row.industry ? `Industry ${row.industry}` : `Industry ${sector}`,
    totalStocks !== null ? `${Math.round(totalStocks)} stocks` : null,
    advancePct !== null ? `adv ${r2(advancePct)}%` : null,
    day !== null ? `day ${r2(day)}%` : null,
    week !== null ? `week ${r2(week)}%` : null,
    month !== null ? `month ${r2(month)}%` : null,
    momentum !== null ? `momentum ${r2(momentum)}` : null,
    `rotation ${rotationSignal}/${confidence}`,
    `sector strength adjustment ${r2(adjustment)}`,
  ].filter((part): part is string => Boolean(part)).join("; ");

  return { adjustment, text, source: "brkview" };
}

function bankWeakMarketSectorPenalty(candidate: SwingCandidate, marketRegime: MarketRegimeSnapshot): number {
  if (candidate.sector.trim().toLowerCase() !== "bank") return 0.0;
  return marketRegime.niftyAboveEma20 === false && marketRegime.niftyAboveEma50 === false
    ? BANK_WEAK_MARKET_SECTOR_SCORE_PENALTY
    : 0.0;
}

function isStrictWeakMarketContext(marketRegime: MarketRegimeSnapshot): boolean {
  return (
    marketRegime.marketBreadthPct !== null &&
    marketRegime.marketBreadthPct < STRICT_WEAK_MARKET_SIGNAL_BREADTH_THRESHOLD &&
    marketRegime.niftyAboveEma20 === false &&
    marketRegime.niftyAboveEma50 === false
  );
}

function downgradeBuySignalForWeakMarket(value: string): string {
  const signal = value.trim();
  if (signal === "Strong Buy") return "Buy";
  if (signal === "Buy") return "Hold";
  return value;
}

function downgradeIntradaySignalForWeakMarket(value: string): string {
  return value.trim() === "Strong Buy" ? "Buy" : value;
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

function calculateMacd(
  closes: number[],
  fast = 8,
  slow = 17,
  signalPeriod = 9,
): { macd: number | null; signal: number | null; histogram: number | null; series: number[] } {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdSeries = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? (emaFast[i] as number) - (emaSlow[i] as number) : null
  );
  const validMacd = macdSeries.filter((value): value is number => value !== null);
  if (validMacd.length < signalPeriod) return { macd: null, signal: null, histogram: null, series: validMacd };

  const signalSeries = emaSeries(validMacd, signalPeriod);
  const macd = validMacd.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  return {
    macd,
    signal,
    histogram: macd !== null && signal !== null ? macd - signal : null,
    series: validMacd,
  };
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function rollingMeanLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return avg(values.slice(-period));
}

function calculateBollingerLast(closes: number[], period = 20, dev = 2): { upper: number | null; middle: number | null; lower: number | null } {
  if (closes.length < period) return { upper: null, middle: null, lower: null };
  const window = closes.slice(-period);
  const middle = avg(window);
  if (middle === null) return { upper: null, middle: null, lower: null };
  const deviation = std(window);
  return {
    upper: middle + deviation * dev,
    middle,
    lower: middle - deviation * dev,
  };
}

function calculateDonchianLast(candles: Candle[], period = 20): { upper: number | null; lower: number | null; middle: number | null } {
  if (candles.length < period) return { upper: null, lower: null, middle: null };
  const window = candles.slice(-period);
  const upper = Math.max(...window.map((c) => c.h));
  const lower = Math.min(...window.map((c) => c.l));
  return { upper, lower, middle: (upper + lower) / 2 };
}

function calculateIchimokuLast(candles: Candle[]): { tenkan: number | null; kijun: number | null; spanA: number | null; spanB: number | null } {
  const midpoint = (period: number): number | null => {
    if (candles.length < period) return null;
    const window = candles.slice(-period);
    return (Math.max(...window.map((c) => c.h)) + Math.min(...window.map((c) => c.l))) / 2;
  };
  const tenkan = midpoint(9);
  const kijun = midpoint(26);
  const spanB = midpoint(52);
  return {
    tenkan,
    kijun,
    spanA: tenkan !== null && kijun !== null ? (tenkan + kijun) / 2 : null,
    spanB,
  };
}

function calculateCmfLast(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  let mfvSum = 0;
  let volumeSum = 0;
  for (const candle of candles.slice(-period)) {
    const range = candle.h - candle.l;
    if (range === 0) continue;
    const multiplier = ((candle.c - candle.l) - (candle.h - candle.c)) / range;
    mfvSum += multiplier * candle.v;
    volumeSum += candle.v;
  }
  return volumeSum ? mfvSum / volumeSum : null;
}

function calculateObvSeries(candles: Candle[]): number[] {
  const output: number[] = [];
  let obv = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      output.push(0);
      continue;
    }
    if (candles[i].c > candles[i - 1].c) obv += candles[i].v;
    else if (candles[i].c < candles[i - 1].c) obv -= candles[i].v;
    output.push(obv);
  }
  return output;
}

function calculateVptSeries(candles: Candle[]): number[] {
  const output: number[] = [];
  let vpt = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0 || candles[i - 1].c === 0) {
      output.push(vpt);
      continue;
    }
    vpt += candles[i].v * ((candles[i].c - candles[i - 1].c) / candles[i - 1].c);
    output.push(vpt);
  }
  return output;
}

function calculateCmoLast(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  const diffs = closes.slice(1).map((close, i) => close - closes[i]);
  const window = diffs.slice(-period);
  const up = window.reduce((sum, diff) => sum + Math.max(diff, 0), 0);
  const down = window.reduce((sum, diff) => sum + Math.abs(Math.min(diff, 0)), 0);
  return up + down === 0 ? 0 : 100 * ((up - down) / (up + down));
}

function calculateTrixLast(closes: number[], period = 15): { current: number | null; previous: number | null } {
  const ema1 = emaSeries(closes, period).map((value) => value ?? NaN);
  const valid1 = ema1.filter((value) => Number.isFinite(value));
  const ema2 = emaSeries(valid1, period).map((value) => value ?? NaN);
  const valid2 = ema2.filter((value) => Number.isFinite(value));
  const ema3 = emaSeries(valid2, period).filter((value): value is number => value !== null);
  if (ema3.length < 2) return { current: null, previous: null };
  const trix = ema3.map((value, i) => i === 0 ? null : ((value - ema3[i - 1]) / ema3[i - 1]) * 100);
  return {
    current: trix.at(-1) ?? null,
    previous: trix.at(-2) ?? null,
  };
}

function calculateUltimateOscLast(candles: Candle[]): number | null {
  if (candles.length < 29) return null;
  const bp: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].c;
    bp.push(candles[i].c - Math.min(candles[i].l, prevClose));
    tr.push(Math.max(candles[i].h, prevClose) - Math.min(candles[i].l, prevClose));
  }
  const avgWindow = (period: number): number | null => {
    const bpSum = bp.slice(-period).reduce((sum, value) => sum + value, 0);
    const trSum = tr.slice(-period).reduce((sum, value) => sum + value, 0);
    return trSum ? bpSum / trSum : null;
  };
  const a7 = avgWindow(7);
  const a14 = avgWindow(14);
  const a28 = avgWindow(28);
  return a7 !== null && a14 !== null && a28 !== null ? 100 * ((4 * a7 + 2 * a14 + a28) / 7) : null;
}

function calculateAdxLast(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    ));
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let trSmooth = trs.slice(0, period).reduce((sum, value) => sum + value, 0);
  let plusSmooth = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let minusSmooth = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dxValues: number[] = [];
  for (let i = period; i < trs.length; i++) {
    trSmooth = trSmooth - (trSmooth / period) + trs[i];
    plusSmooth = plusSmooth - (plusSmooth / period) + plusDm[i];
    minusSmooth = minusSmooth - (minusSmooth / period) + minusDm[i];
    const plusDi = trSmooth ? 100 * (plusSmooth / trSmooth) : 0;
    const minusDi = trSmooth ? 100 * (minusSmooth / trSmooth) : 0;
    const denom = plusDi + minusDi;
    dxValues.push(denom ? 100 * (Math.abs(plusDi - minusDi) / denom) : 0);
  }
  if (dxValues.length < period) return null;
  let adx = dxValues.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
  }
  return adx;
}

function detectDivergence(closes: number[], rsiSeries: Array<number | null>): "Bullish Divergence" | "Bearish Divergence" | "No Divergence" {
  const recentCloses = closes.slice(-5);
  const recentRsi = rsiSeries.slice(-5);
  if (recentCloses.length < 5 || recentRsi.some((value) => value === null)) return "No Divergence";
  const rsi = recentRsi as number[];
  const priceHighPos = recentCloses.indexOf(Math.max(...recentCloses));
  const priceLowPos = recentCloses.indexOf(Math.min(...recentCloses));
  const rsiHighPos = rsi.indexOf(Math.max(...rsi));
  const rsiLowPos = rsi.indexOf(Math.min(...rsi));
  const lastPos = recentCloses.length - 1;
  const bullish = priceLowPos > rsiLowPos && recentCloses[priceLowPos] < recentCloses[lastPos] && rsi[rsiLowPos] < rsi[lastPos];
  const bearish = priceHighPos < rsiHighPos && recentCloses[priceHighPos] > recentCloses[lastPos] && rsi[rsiHighPos] > rsi[lastPos];
  return bullish ? "Bullish Divergence" : bearish ? "Bearish Divergence" : "No Divergence";
}

function countConsolidationCandles(candles: Candle[], lookback = 8, maxRangePct = 3.0, endOffset = 0): number {
  const endPosition = candles.length - endOffset;
  if (endPosition < lookback) return 0;
  const window = candles.slice(0, endPosition).slice(-lookback);
  let count = 0;
  for (const candle of [...window].reverse()) {
    if (candle.c <= 0) break;
    const candleRangePct = ((candle.h - candle.l) / candle.c) * 100;
    if (candleRangePct <= maxRangePct) count += 1;
    else break;
  }
  return count;
}

function countEntryConsolidationCandles(candles: Candle[], breakoutAge: number | null): number {
  if (breakoutAge !== null && breakoutAge >= 1 && breakoutAge <= 3) {
    return countConsolidationCandles(candles, 8, 3.0, breakoutAge);
  }
  return countConsolidationCandles(candles);
}

function calculateTrendPersistenceScore(candles: Candle[], lookback = 5): number {
  if (candles.length < lookback) return 0;
  const window = candles.slice(-lookback);
  const closeLocations = window.map((c) => {
    const range = c.h - c.l;
    return range ? clamp((c.c - c.l) / range, 0, 1) : 0;
  });
  const closeLocation = closeLocations.reduce((sum, value) => sum + value, 0) / closeLocations.length;
  const changes = window.slice(1).map((c, i) => c.c - window[i].c);
  const advancingCloseRate = changes.filter((change) => change > 0).length / Math.max(1, changes.length);
  const pathLength = changes.reduce((sum, change) => sum + Math.abs(change), 0);
  const smoothness = pathLength ? clamp(Math.abs(window.at(-1)!.c - window[0].c) / pathLength, 0, 1) : 0;
  return r2(((closeLocation * 0.45) + (advancingCloseRate * 0.35) + (smoothness * 0.20)) * 100);
}

function freshBreakoutAge(candles: Candle[], lookback = 20, maxAge = 3): number | null {
  if (candles.length < lookback + maxAge + 2) return null;
  for (let age = 1; age <= maxAge; age++) {
    const breakoutIndex = candles.length - age;
    const previousIndex = breakoutIndex - 1;
    const priorStart = breakoutIndex - lookback;
    const previousPriorStart = previousIndex - lookback;
    if (priorStart < 0 || previousPriorStart < 0) continue;
    const priorHigh = Math.max(...candles.slice(priorStart, breakoutIndex).map((c) => c.h));
    const previousPriorHigh = Math.max(...candles.slice(previousPriorStart, previousIndex).map((c) => c.h));
    const breakoutClose = candles[breakoutIndex].c;
    const previousClose = candles[previousIndex].c;
    if (breakoutClose > priorHigh && previousClose <= previousPriorHigh) return age;
  }
  return null;
}

function percentChangeOverLookback(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const latest = closes.at(-1);
  const previous = closes.at(-(lookback + 1));
  return latest !== undefined && previous !== undefined ? percentChange(latest, previous) : null;
}

function isLateExtendedBreakout(
  freshAge: number | null,
  return20Pct: number | null,
  return40Pct: number | null,
  ema20DistancePct: number,
  consolidationCandles: number,
): boolean {
  if (freshAge === null) return false;
  if (ema20DistancePct < DD_LATE_BREAKOUT_EMA20_DISTANCE_THRESHOLD) return false;

  const return20 = return20Pct ?? 0;
  const return40 = return40Pct ?? 0;
  const shortRunIsTooHot = return20 >= DD_LATE_BREAKOUT_20D_RETURN_THRESHOLD;
  const mediumRunIsTooHot = return40 >= DD_LATE_BREAKOUT_40D_RETURN_THRESHOLD;
  const thinBaseAfterRun = return20 >= 25 && consolidationCandles < 5;

  return shortRunIsTooHot || mediumRunIsTooHot || thinBaseAfterRun;
}

function isOverextendedSwingSetup(
  return20Pct: number | null,
  return40Pct: number | null,
  ema20DistancePct: number,
  consolidationCandles: number,
  latestMovePct: number,
): boolean {
  const return20 = return20Pct ?? 0;
  const return40 = return40Pct ?? 0;
  const hasTightBase = consolidationCandles >= 5;
  const shortRunIsExtended = return20 >= DD_OVEREXTENDED_20D_RETURN_THRESHOLD;
  const mediumRunIsExtended = return40 >= DD_OVEREXTENDED_40D_RETURN_THRESHOLD;
  const farFromMean = ema20DistancePct >= DD_OVEREXTENDED_EMA20_DISTANCE_THRESHOLD;
  const freshSpike = latestMovePct >= DD_OVEREXTENDED_LATEST_MOVE_THRESHOLD;

  if ((shortRunIsExtended || mediumRunIsExtended) && !hasTightBase) return true;
  if ((shortRunIsExtended || mediumRunIsExtended) && farFromMean) return true;
  if (freshSpike && !hasTightBase) return true;
  return false;
}

function swingEntryTouchIndex(
  candles: Candle[],
  entry: number,
  entryType: "BREAKOUT" | "PULLBACK",
): number {
  return candles.findIndex((candle) =>
    entryType === "BREAKOUT" ? candle.h >= entry : candle.l <= entry
  );
}

function hasBullish15mStructureAtEntry(
  candles: Candle[],
  entryIndex: number,
  entry: number,
  entryType: "BREAKOUT" | "PULLBACK",
): boolean {
  const window = candles.slice(
    Math.max(0, entryIndex - SWING_INTRADAY_STRUCTURE_LOOKBACK + 1),
    entryIndex + 1,
  );
  if (window.length < 4) return false;

  let higherHighs = 0;
  let higherLows = 0;
  for (let i = 1; i < window.length; i += 1) {
    if (window[i].h >= window[i - 1].h) higherHighs += 1;
    if (window[i].l >= window[i - 1].l) higherLows += 1;
  }

  const requiredPairs = Math.max(2, Math.ceil((window.length - 1) * 0.6));
  const closeProgress = window.at(-1)!.c > window[0].c;
  const triggerIsNotWeakClose = window.at(-1)!.c >= ((window.at(-1)!.h + window.at(-1)!.l) / 2);
  const triggerCandle = window.at(-1)!;
  const minConfirmedClose = entry * (1 + (SWING_MIN_TRIGGER_CLOSE_BUFFER_PCT / 100));
  const triggerConfirmedEntry =
    entryType === "BREAKOUT"
      ? triggerCandle.c >= minConfirmedClose
      : triggerCandle.c >= entry;

  return (
    higherHighs >= requiredPairs &&
    higherLows >= requiredPairs &&
    closeProgress &&
    triggerIsNotWeakClose &&
    triggerConfirmedEntry
  );
}

function passesSwingIntradayEntryStructure(
  candleData: CandleData | null,
  entryDate: string,
  entry: number,
  entryType: "BREAKOUT" | "PULLBACK",
): boolean {
  if (!candleData) return false;
  const intradayCandles = aggregateCandles(
    getConfirmedCandles(candleData.historicalCandles)
      .filter((candle) => getISTDateStr(candle.t) === entryDate),
    15 * 60,
  );
  const entryIndex = swingEntryTouchIndex(intradayCandles, entry, entryType);
  return entryIndex >= 0 && hasBullish15mStructureAtEntry(intradayCandles, entryIndex, entry, entryType);
}

function linearRegressionSlopeAndR2(values: number[]): { slope: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  const cov = xs.reduce((sum, x, i) => sum + ((x - meanX) * (values[i] - meanY)), 0);
  const varX = xs.reduce((sum, x) => sum + ((x - meanX) ** 2), 0);
  const varY = values.reduce((sum, y) => sum + ((y - meanY) ** 2), 0);
  const slope = varX ? cov / varX : 0;
  const corr = varX && varY ? cov / Math.sqrt(varX * varY) : 0;
  return { slope, r2: corr ** 2 };
}

function detectAdvancedPattern(candles: Candle[], ema50: number | null, window = 20): { action: "BUY" | "STRONG BUY"; pattern: string; desc: string; breakoutLevel: number } | null {
  if (candles.length < window + 5) return null;
  const recent = candles.slice(-window);
  const currentClose = recent.at(-1)!.c;
  if (ema50 !== null && currentClose < ema50) return null;
  const avgVol = avg(recent.map((c) => c.v)) ?? 0;
  if (recent.at(-1)!.v < avgVol * 0.5) return null;

  const highs = recent.map((c) => c.h);
  const lows = recent.map((c) => c.l);
  const avgHigh = avg(highs.slice(-5)) ?? 0;
  const resistanceVariance = std(highs.slice(-5)) ** 2;
  const isResistanceFlat = resistanceVariance < currentClose * 0.005;
  const { slope, r2: regressionR2 } = linearRegressionSlopeAndR2(lows);
  const isDemandIncreasing = slope > 0.05 && regressionR2 > 0.6;
  const nearResistance = currentClose >= avgHigh * 0.98;
  if (isResistanceFlat && isDemandIncreasing && nearResistance) {
    return {
      pattern: "Increasing Demand",
      action: "BUY",
      desc: "Higher lows into resistance (Ascending Triangle). Buyers absorbing supply.",
      breakoutLevel: avgHigh,
    };
  }

  const supportWindow = candles.slice(-(window + 10), -5);
  if (supportWindow.length) {
    const recentSupport = Math.min(...supportWindow.map((c) => c.l));
    const recentLow = Math.min(...recent.map((c) => c.l));
    const currentOpen = recent.at(-1)!.o;
    if (
      recentLow < recentSupport &&
      currentClose > recentSupport &&
      currentClose > currentOpen &&
      (recentSupport - recentLow) / recentSupport < 0.03
    ) {
      return {
        pattern: "Fake-out Reversal",
        action: "STRONG BUY",
        desc: "Liquidity sweep below support followed by strong rejection (Bear Trap).",
        breakoutLevel: currentClose,
      };
    }
  }
  return null;
}

function calculatePsarLast(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  let rising = candles[1].c >= candles[0].c;
  let af = 0.02;
  let ep = rising ? candles[0].h : candles[0].l;
  let psar = rising ? candles[0].l : candles[0].h;
  for (let i = 1; i < candles.length; i++) {
    psar = psar + af * (ep - psar);
    if (rising) {
      psar = Math.min(psar, candles[i - 1].l, i > 1 ? candles[i - 2].l : candles[i - 1].l);
      if (candles[i].l < psar) {
        rising = false;
        psar = ep;
        ep = candles[i].l;
        af = 0.02;
      } else if (candles[i].h > ep) {
        ep = candles[i].h;
        af = Math.min(af + 0.02, 0.2);
      }
    } else {
      psar = Math.max(psar, candles[i - 1].h, i > 1 ? candles[i - 2].h : candles[i - 1].h);
      if (candles[i].h > psar) {
        rising = true;
        psar = ep;
        ep = candles[i].h;
        af = 0.02;
      } else if (candles[i].l < ep) {
        ep = candles[i].l;
        af = Math.min(af + 0.02, 0.2);
      }
    }
  }
  return psar;
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

function swingRiskAdjustment(riskPct: number): number {
  if (riskPct <= 3) return 0.6;
  if (riskPct <= 4.5) return 0.25;
  if (riskPct <= SWING_MAX_RISK_PCT) return 0.0;
  return -2.0;
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
  return r2(100 * (1 - Math.exp(-Math.max(rawScore, 0) / DD_OPPORTUNITY_SCORE_CURVE_SCALE)));
}

function confidenceGrade(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "B+";
  if (score >= 70) return "B";
  if (score >= 60) return "C+";
  return "C";
}

type DdRecommendationSignal = "Strong Buy" | "Buy" | "Hold" | "Sell" | "Strong Sell";

interface DdRecommendation {
  buyAt: number | null;
  stopLoss: number | null;
  target: number | null;
  entryType: "Breakout" | "Pullback" | "Choppy" | "Standard" | "Unavailable";
  score: number;
  buyScore: number;
  sellScore: number;
  intraday: DdRecommendationSignal;
  swing: DdRecommendationSignal;
  shortTerm: DdRecommendationSignal;
  longTerm: DdRecommendationSignal;
  meanReversion: DdRecommendationSignal;
  breakout: DdRecommendationSignal;
  ichimokuTrend: DdRecommendationSignal;
  majorTrendConflict: boolean;
  notes: string[];
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function calculateRsiSeries(closes: number[], period: number): Array<number | null> {
  return closes.map((_, index) => {
    if (index < period) return null;
    return calculateRsiLast(closes.slice(0, index + 1), period);
  });
}

function calculateKeltnerLast(
  closes: number[],
  candles: Candle[],
): { upper: number | null; middle: number | null; lower: number | null } {
  const middle = emaSeries(closes, 20).at(-1) ?? null;
  const atr = calculateATR(candles, 10);
  if (middle === null || atr === null) return { upper: null, middle, lower: null };
  return {
    upper: middle + (2 * atr),
    middle,
    lower: middle - (2 * atr),
  };
}

function calculateFibLevels(candles: Candle[]): number[] {
  const recentSwing = candles.slice(-50);
  if (recentSwing.length < 2) return [];
  const high = Math.max(...recentSwing.map((c) => c.h));
  const low = Math.min(...recentSwing.map((c) => c.l));
  const diff = high - low;
  if (!Number.isFinite(diff) || diff <= 0) return [];
  return [
    high - (diff * 0.236),
    high - (diff * 0.382),
    high - (diff * 0.5),
    high - (diff * 0.618),
  ];
}

function calculateDdBuyAt(
  currentClose: number,
  atr: number | null,
  adx: number | null,
  upperBand: number | null,
  volume: number,
  avgVolume: number | null,
): { buyAt: number | null; entryType: DdRecommendation["entryType"] } {
  if (atr !== null) {
    let volConfirm = true;
    if (avgVolume !== null && Number.isFinite(avgVolume) && avgVolume > 0) {
      volConfirm = volume >= avgVolume * 1.2;
    }

    if ((adx ?? 0) > 25) {
      if (volConfirm) {
        return {
          buyAt: r2((upperBand !== null ? Math.max(currentClose, upperBand) : currentClose) * (upperBand !== null ? 1.001 : 1.002)),
          entryType: "Breakout",
        };
      }
      return {
        buyAt: r2(currentClose - (0.2 * atr)),
        entryType: "Pullback",
      };
    }

    if ((adx ?? 0) > 20) {
      return {
        buyAt: r2(currentClose - (0.5 * atr)),
        entryType: "Pullback",
      };
    }

    return { buyAt: null, entryType: "Choppy" };
  }

  return {
    buyAt: r2(currentClose * 0.995),
    entryType: "Standard",
  };
}

function calculateDdStopLoss(atr: number | null, entryPrice: number | null, atrMultiplier = 1.5): number | null {
  if (atr === null || entryPrice === null) return null;
  let stopLoss = entryPrice - (atrMultiplier * atr);
  if (stopLoss > entryPrice) stopLoss = entryPrice - atr;
  return r2(stopLoss);
}

function calculateDdTarget(
  adx: number | null,
  entryPrice: number | null,
  stopLoss: number | null,
  riskRewardRatio = DD_TARGET_RISK_REWARD,
): number | null {
  if (entryPrice === null || stopLoss === null) return null;
  const risk = entryPrice - stopLoss;
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const isStrongTrend = (adx ?? 0) > 25;
  const adjustedRatio = isStrongTrend ? riskRewardRatio : Math.min(riskRewardRatio, 1.8);
  const maxGainPct = isStrongTrend ? DD_TARGET_MAX_GAIN_PCT : DD_TARGET_NEUTRAL_MAX_GAIN_PCT;
  return r2(Math.min(entryPrice + (risk * adjustedRatio), entryPrice * (1 + (maxGainPct / 100))));
}

function isBuyRecommendation(value: DdRecommendationSignal | string | null | undefined): boolean {
  return typeof value === "string" && value.includes("Buy");
}

function ddSwingSignalForGrade(grade: string): "Strong Buy" | "Buy" | "WATCHLIST" | "AVOID" {
  const normalized = grade.trim().toUpperCase();
  if (normalized === "A+" || normalized === "A") return "Strong Buy";
  if (normalized === "B+" || normalized === "B") return "Buy";
  if (normalized === "C") return "AVOID";
  if (normalized === "D") return "AVOID";
  return "WATCHLIST";
}

function gradeMeetsMinimum(grade: string, minimumGrade: string): boolean {
  const order = ["D", "C", "C+", "B", "B+", "A", "A+"];
  const gradeIndex = order.indexOf(grade.trim().toUpperCase());
  const minimumIndex = order.indexOf(minimumGrade.trim().toUpperCase());
  return gradeIndex >= 0 && minimumIndex >= 0 && gradeIndex >= minimumIndex;
}

function isPublicShareSwingPick(candidate: SwingCandidate): boolean {
  const displayedSwingSignal = ddSwingSignalForGrade(candidate.grade);
  return (
    gradeMeetsMinimum(candidate.grade, "B") &&
    (displayedSwingSignal === "Buy" || displayedSwingSignal === "Strong Buy") &&
    candidate.avgTurnover >= SWING_PUBLIC_SHARE_MIN_TURNOVER &&
    candidate.liquidityScore >= 0.5
  );
}

function setupTypeLabel(setupType: DdSwingSetupType): string {
  return {
    fresh_breakout: "Fresh Breakout",
    sector_leader_continuation: "Sector Leader",
    mean_reversion_bounce: "Mean Reversion Bounce",
    high_rvol_explosive: "High RVOL",
    slow_institutional_trend: "Slow Institutional Trend",
    trend_continuation: "Trend Continuation",
  }[setupType];
}

function expectedHoldDaysForSetup(setupType: DdSwingSetupType): number {
  return {
    fresh_breakout: 5,
    sector_leader_continuation: 8,
    mean_reversion_bounce: 3,
    high_rvol_explosive: 2,
    slow_institutional_trend: 15,
    trend_continuation: 8,
  }[setupType] ?? SWING_EXPECTED_HOLD_DAYS;
}

function classifyDdSetupType(
  candidate: SwingCandidate,
  freshBreakoutBonus: number,
  sectorLeaderAdjustment: number,
): DdSwingSetupType {
  if (candidate.reason.includes("Mean_Reversion Buy")) return "mean_reversion_bounce";
  if (candidate.rvol >= DD_EXHAUSTION_RVOL_THRESHOLD) return "high_rvol_explosive";
  if (freshBreakoutBonus > 0) return "fresh_breakout";
  if (sectorLeaderAdjustment > 0.25) return "sector_leader_continuation";
  if (candidate.trendPersistence >= 75 && candidate.avgTurnover >= 100_000_000) return "slow_institutional_trend";
  return "trend_continuation";
}

function freshBreakoutBonus(freshAge: number | null): number {
  if (freshAge === 1) return 0.5;
  if (freshAge === 2) return 0.3;
  if (freshAge === 3) return 0.1;
  return 0.0;
}

function sectorExhaustionPenalty(sectorPerformancePct: number): number {
  return sectorPerformancePct > 10 ? -0.5 : 0.0;
}

function momentumExhaustionPenalty(candidate: SwingCandidate): number {
  if (candidate.rvol <= DD_EXHAUSTION_RVOL_THRESHOLD) return 0.0;
  const moveExcess = Math.max(0, candidate.latestMovePct - DD_EXHAUSTION_DAILY_MOVE_THRESHOLD);
  const emaExcess = Math.max(0, candidate.ema20DistancePct - DD_EXHAUSTION_EMA20_DISTANCE_THRESHOLD);
  const extensionExcess = Math.max(moveExcess, emaExcess);
  if (extensionExcess <= 0) return 0.0;
  const penalty = Math.min(
    DD_MAX_EXHAUSTION_RANKING_PENALTY,
    ((candidate.rvol - DD_EXHAUSTION_RVOL_THRESHOLD) * 0.25) + (extensionExcess * 0.15),
  );
  return -r2(penalty);
}

function rankValues(values: number[]): number[] {
  if (values.length <= 1) return values.map(() => 0.5);
  const finite = values.filter((value) => Number.isFinite(value));
  const fallback = finite.length ? Math.min(...finite) : 0;
  const normalized = values.map((value) => Number.isFinite(value) ? value : fallback);
  const unique = new Set(normalized);
  if (unique.size <= 1) return values.map(() => 0.5);
  return normalized.map((value) => {
    const lower = normalized.filter((other) => other < value).length;
    const same = normalized.filter((other) => other === value).length;
    const averageRank = lower + ((same + 1) / 2);
    return (averageRank - 1) / (normalized.length - 1);
  });
}

function absoluteSectorLeaderScore(candidate: SwingCandidate): number {
  const turnoverCr = candidate.avgTurnover / 10_000_000;
  const rsScore =
    candidate.relativeStrength >= 6 ? 1.0
      : candidate.relativeStrength >= 3 ? 0.9
        : candidate.relativeStrength >= 1 ? 0.7
          : candidate.relativeStrength > 0 ? 0.5
            : 0.0;
  const liquidityScore =
    turnoverCr >= 100 ? 1.0
      : turnoverCr >= 50 ? 0.8
        : turnoverCr >= 20 ? 0.6
          : turnoverCr >= 10 ? 0.4
            : 0.0;
  const persistenceScore =
    candidate.trendPersistence >= 75 ? 1.0
      : candidate.trendPersistence >= 60 ? 0.7
        : candidate.trendPersistence >= 50 ? 0.5
          : 0.0;
  return (rsScore + liquidityScore + persistenceScore) / 3;
}

function sectorLeaderAdjustments(candidates: SwingCandidate[]): Map<string, { score: number; adjustment: number }> {
  const bySector = new Map<string, SwingCandidate[]>();
  for (const candidate of candidates) {
    const group = bySector.get(candidate.sector) ?? [];
    group.push(candidate);
    bySector.set(candidate.sector, group);
  }

  const adjustments = new Map<string, { score: number; adjustment: number }>();
  for (const sectorCandidates of bySector.values()) {
    if (sectorCandidates.length < 2) {
      const candidate = sectorCandidates[0];
      const leaderScore = absoluteSectorLeaderScore(candidate);
      let adjustment = Math.max(0, (leaderScore - 0.5) * 2 * 0.6);
      if (candidate.sectorRelativeStrength < 0) adjustment *= 0.5;
      adjustments.set(candidate.symbol, { score: r2(leaderScore), adjustment: r2(adjustment) });
      continue;
    }

    const rsRanks = rankValues(sectorCandidates.map((candidate) => candidate.relativeStrength));
    const liquidityRanks = rankValues(sectorCandidates.map((candidate) => candidate.avgTurnover));
    const persistenceRanks = rankValues(sectorCandidates.map((candidate) => candidate.trendPersistence));
    sectorCandidates.forEach((candidate, index) => {
      const leaderScore = (rsRanks[index] + liquidityRanks[index] + persistenceRanks[index]) / 3;
      let adjustment = clamp((leaderScore - 0.5) * 2 * 0.6, -0.6, 0.6);
      if (candidate.sectorRelativeStrength < 0 && adjustment > 0) adjustment *= 0.5;
      adjustments.set(candidate.symbol, { score: r2(leaderScore), adjustment: r2(adjustment) });
    });
  }
  return adjustments;
}

function generateDdRecommendation(
  candles: Candle[],
  currentPrice: number,
  previousClose: number,
  indicators: {
    rsi: number | null;
    macd: ReturnType<typeof calculateMacd>;
    bollinger: ReturnType<typeof calculateBollingerLast>;
    atr: number | null;
    adx: number | null;
    avgVolume: number | null;
    divergence: ReturnType<typeof detectDivergence>;
    ichimoku: ReturnType<typeof calculateIchimokuLast>;
    cmf: number | null;
    donchian: ReturnType<typeof calculateDonchianLast>;
    keltner: ReturnType<typeof calculateKeltnerLast>;
    trix: ReturnType<typeof calculateTrixLast>;
    ultimateOsc: number | null;
    cmo: number | null;
    vpt: number[];
    obv: number[];
    fibLevels: number[];
    psar: number | null;
    advancedPattern: ReturnType<typeof detectAdvancedPattern>;
  },
): DdRecommendation {
  let buyScore = 0;
  let sellScore = 0;
  let intraday: DdRecommendationSignal = "Hold";
  let swing: DdRecommendationSignal = "Hold";
  let shortTerm: DdRecommendationSignal = "Hold";
  let longTerm: DdRecommendationSignal = "Hold";
  let meanReversion: DdRecommendationSignal = "Hold";
  let breakout: DdRecommendationSignal = "Hold";
  let ichimokuTrend: DdRecommendationSignal = "Hold";
  const notes: string[] = [];
  const last = candles.at(-1)!;

  if (indicators.advancedPattern) {
    if (indicators.advancedPattern.action === "BUY") {
      buyScore += 5;
      breakout = "Buy";
    } else {
      buyScore += 8;
      breakout = "Strong Buy";
    }
    notes.push(`${indicators.advancedPattern.pattern}: ${indicators.advancedPattern.desc}`);
  }

  if (indicators.rsi !== null) {
    if (indicators.rsi <= 20) buyScore += 4;
    else if (indicators.rsi < 30) buyScore += 2;
    else if (indicators.rsi > 70) sellScore += 2;
  }

  if (indicators.macd.macd !== null && indicators.macd.signal !== null) {
    if (indicators.macd.macd > indicators.macd.signal) buyScore += 1;
    else if (indicators.macd.macd < indicators.macd.signal) sellScore += 1;
  }

  if (indicators.bollinger.lower !== null && indicators.bollinger.upper !== null) {
    if (currentPrice < indicators.bollinger.lower) buyScore += 1;
    else if (currentPrice > indicators.bollinger.upper) sellScore += 1;
  }

  if (indicators.avgVolume !== null && indicators.avgVolume > 0) {
    const volumeRatio = last.v / indicators.avgVolume;
    if (volumeRatio > 1.5 && currentPrice > previousClose) buyScore += 2;
    else if (volumeRatio > 1.5 && currentPrice < previousClose) sellScore += 2;
    else if (volumeRatio < 0.5) sellScore += 1;

    const volumeSpike = last.v > indicators.avgVolume * 1.5;
    if (volumeSpike) {
      if (currentPrice > previousClose) buyScore += 1;
      else sellScore += 1;
    }
  }

  if (indicators.divergence === "Bullish Divergence") buyScore += 1;
  else if (indicators.divergence === "Bearish Divergence") sellScore += 1;

  if (indicators.ichimoku.spanA !== null && indicators.ichimoku.spanB !== null) {
    if (currentPrice > Math.max(indicators.ichimoku.spanA, indicators.ichimoku.spanB)) {
      buyScore += 1;
      ichimokuTrend = "Buy";
    } else if (currentPrice < Math.min(indicators.ichimoku.spanA, indicators.ichimoku.spanB)) {
      sellScore += 1;
      ichimokuTrend = "Sell";
    }
  }

  if (indicators.cmf !== null) {
    if (indicators.cmf > 0) buyScore += 1;
    else if (indicators.cmf < 0) sellScore += 1;
  }

  if (indicators.donchian.upper !== null && indicators.donchian.lower !== null) {
    if (currentPrice > indicators.donchian.upper) {
      buyScore += 1;
      breakout = "Buy";
    } else if (currentPrice < indicators.donchian.lower) {
      sellScore += 1;
      breakout = "Sell";
    }
  }

  if (indicators.rsi !== null && indicators.bollinger.lower !== null && indicators.bollinger.upper !== null) {
    if (indicators.rsi < 30 && currentPrice >= indicators.bollinger.lower) {
      buyScore += 2;
      meanReversion = "Buy";
    } else if (indicators.rsi > 70 && currentPrice >= indicators.bollinger.upper) {
      sellScore += 2;
      meanReversion = "Sell";
    }
  }

  if (
    indicators.ichimoku.tenkan !== null &&
    indicators.ichimoku.kijun !== null &&
    indicators.ichimoku.spanA !== null &&
    indicators.ichimoku.spanB !== null
  ) {
    if (indicators.ichimoku.tenkan > indicators.ichimoku.kijun && currentPrice > indicators.ichimoku.spanA) {
      buyScore += 1;
      ichimokuTrend = "Strong Buy";
    } else if (indicators.ichimoku.tenkan < indicators.ichimoku.kijun && currentPrice < indicators.ichimoku.spanB) {
      sellScore += 1;
      ichimokuTrend = "Strong Sell";
    }
  }

  if (indicators.keltner.lower !== null && indicators.keltner.upper !== null) {
    if (currentPrice < indicators.keltner.lower) buyScore += 1;
    else if (currentPrice > indicators.keltner.upper) sellScore += 1;
  }

  if (indicators.trix.current !== null && indicators.trix.previous !== null) {
    if (indicators.trix.current > 0 && indicators.trix.current > indicators.trix.previous) buyScore += 1;
    else if (indicators.trix.current < 0 && indicators.trix.current < indicators.trix.previous) sellScore += 1;
  }

  if (indicators.ultimateOsc !== null) {
    if (indicators.ultimateOsc < 30) buyScore += 1;
    else if (indicators.ultimateOsc > 70) sellScore += 1;
  }

  if (indicators.cmo !== null) {
    if (indicators.cmo < -50) buyScore += 1;
    else if (indicators.cmo > 50) sellScore += 1;
  }

  if (indicators.vpt.length >= 2) {
    const currentVpt = indicators.vpt.at(-1)!;
    const previousVpt = indicators.vpt.at(-2)!;
    if (currentVpt > previousVpt) buyScore += 1;
    else if (currentVpt < previousVpt) sellScore += 1;
  }

  for (const level of indicators.fibLevels) {
    if (Math.abs(currentPrice - level) / currentPrice < 0.01) {
      if (currentPrice > level) buyScore += 1;
      else sellScore += 1;
    }
  }

  if (indicators.psar !== null) {
    if (currentPrice > indicators.psar) buyScore += 1;
    else if (currentPrice < indicators.psar) sellScore += 1;
  }

  if (indicators.obv.length >= 2) {
    const currentObv = indicators.obv.at(-1)!;
    const previousObv = indicators.obv.at(-2)!;
    if (currentObv > previousObv) buyScore += 1;
    else if (currentObv < previousObv) sellScore += 1;
  }

  const hasStrongSellCloud = ichimokuTrend === "Strong Sell";
  if (hasStrongSellCloud) {
    buyScore = Math.max(0, buyScore - 2);
    sellScore += 2;
  }

  const netScore = buyScore - sellScore;
  if (buyScore > sellScore && buyScore >= 4) {
    intraday = "Strong Buy";
    swing = buyScore >= 3 ? "Buy" : "Hold";
    shortTerm = buyScore >= 2 ? "Buy" : "Hold";
    longTerm = buyScore >= 1 ? "Buy" : "Hold";
  } else if (sellScore > buyScore && sellScore >= 4) {
    intraday = "Strong Sell";
    swing = sellScore >= 3 ? "Sell" : "Hold";
    shortTerm = sellScore >= 2 ? "Sell" : "Hold";
    longTerm = sellScore >= 1 ? "Sell" : "Hold";
  } else if (netScore > 0) {
    intraday = netScore >= 3 ? "Buy" : "Hold";
    swing = netScore >= 2 ? "Buy" : "Hold";
    shortTerm = netScore >= 1 ? "Buy" : "Hold";
    longTerm = "Hold";
  } else if (netScore < 0) {
    intraday = netScore <= -3 ? "Sell" : "Hold";
    swing = netScore <= -2 ? "Sell" : "Hold";
    shortTerm = netScore <= -1 ? "Sell" : "Hold";
    longTerm = "Hold";
  }

  if (meanReversion === "Sell" && swing === "Buy") {
    buyScore = Math.max(0, buyScore - 1);
  }

  const majorTrendConflict = hasStrongSellCloud;
  if (majorTrendConflict) {
    for (const key of ["intraday", "swing", "shortTerm", "longTerm", "breakout"] as const) {
      if (isBuyRecommendation({ intraday, swing, shortTerm, longTerm, breakout }[key])) {
        if (key === "intraday") intraday = "Hold";
        if (key === "swing") swing = "Hold";
        if (key === "shortTerm") shortTerm = "Hold";
        if (key === "longTerm") longTerm = "Hold";
        if (key === "breakout") breakout = "Hold";
      }
    }
    notes.push("Major trend conflict: Ichimoku Strong Sell blocked bullish recommendation.");
  }

  const buyAt = calculateDdBuyAt(
    currentPrice,
    indicators.atr,
    indicators.adx,
    indicators.bollinger.upper,
    last.v,
    indicators.avgVolume,
  );
  const stopLoss = isFinitePositive(buyAt.buyAt)
    ? calculateDdStopLoss(indicators.atr, buyAt.buyAt)
    : null;
  const target = isFinitePositive(buyAt.buyAt)
    ? calculateDdTarget(indicators.adx, buyAt.buyAt, stopLoss)
    : null;
  const finalScore = majorTrendConflict ? 0 : buyScore - sellScore;

  const signalNotes = [
    `Swing ${swing}`,
    `Breakout ${breakout}`,
    `Mean_Reversion ${meanReversion}`,
    `Ichimoku ${ichimokuTrend}`,
    `Buy score ${r2(buyScore)}`,
    `Sell score ${r2(sellScore)}`,
  ];

  return {
    buyAt: buyAt.buyAt,
    stopLoss,
    target,
    entryType: buyAt.entryType,
    score: Math.min(Math.max(finalScore, -7), 7),
    buyScore,
    sellScore,
    intraday,
    swing,
    shortTerm,
    longTerm,
    meanReversion,
    breakout,
    ichimokuTrend,
    majorTrendConflict,
    notes: [...signalNotes, ...notes],
  };
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
  const ema20 = ema20All.at(-1) ?? null;
  const atr = calculateATR(validCandles, 14);
  const rsiPeriod = atr !== null && (atr / currentPrice) > 0.03 ? 9 : 14;
  const rsi = calculateRsiLast(closes, rsiPeriod);
  const rsiSeries = calculateRsiSeries(closes, rsiPeriod);
  const macd = calculateMacd(closes);
  const bollinger = calculateBollingerLast(closes);
  const avgVolume = rollingMeanLast(volumes, 10);
  const adx = calculateAdxLast(validCandles, 14);
  const ichimoku = calculateIchimokuLast(validCandles);
  const cmf = calculateCmfLast(validCandles);
  const donchian = calculateDonchianLast(validCandles);
  const keltner = calculateKeltnerLast(closes, validCandles);
  const trix = calculateTrixLast(closes);
  const ultimateOsc = calculateUltimateOscLast(validCandles);
  const cmo = calculateCmoLast(closes);
  const vpt = calculateVptSeries(validCandles);
  const obv = calculateObvSeries(validCandles);
  const fibLevels = calculateFibLevels(validCandles);
  const psar = calculatePsarLast(validCandles);
  const divergence = detectDivergence(closes, rsiSeries);
  const advancedPattern = detectAdvancedPattern(validCandles, emaSeries(closes, 50).at(-1) ?? null);
  if (!previous || rsi === null || avgVolume === null || avgVolume <= 0 || ema20 === null) return null;

  const recommendation = generateDdRecommendation(
    validCandles,
    currentPrice,
    previous.c,
    {
      rsi,
      macd,
      bollinger,
      atr,
      adx,
      avgVolume,
      divergence,
      ichimoku,
      cmf,
      donchian,
      keltner,
      trix,
      ultimateOsc,
      cmo,
      vpt,
      obv,
      fibLevels,
      psar,
      advancedPattern,
    },
  );
  if (recommendation.majorTrendConflict || recommendation.score < DD_MIN_TOP_PICK_SCORE) return null;
  if (
    ![
      recommendation.swing,
      recommendation.shortTerm,
      recommendation.longTerm,
      recommendation.breakout,
      recommendation.ichimokuTrend,
    ].some(isBuyRecommendation)
  ) {
    return null;
  }

  const entryPrice = recommendation.buyAt;
  const sl = recommendation.stopLoss;
  const target = recommendation.target;
  if (!isFinitePositive(entryPrice) || !isFinitePositive(sl) || !isFinitePositive(target)) return null;

  const entryDistancePct = Math.abs(entryPrice - currentPrice) / currentPrice * 100;
  const risk = entryPrice - sl;
  const reward = target - entryPrice;
  const riskPct = risk > 0 ? (risk / entryPrice) * 100 : 0;
  const rewardRisk = risk > 0 ? reward / risk : 0;
  if (!(
    entryPrice > sl &&
    target > entryPrice &&
    entryDistancePct <= 8 &&
    riskPct <= SWING_MAX_RISK_PCT &&
    rewardRisk >= SWING_MIN_REWARD_RISK
  )) return null;

  const avgTurnover = avgVolume * currentPrice;
  const rvol = last.v / avgVolume;
  const recentReturn = percentChange(currentPrice, closes.at(-5));
  const relativeStrength = recentReturn - niftyReturn;
  const sectorRelativeStrength = stock.changePct ? stock.changePct - niftyReturn : 0;
  const latestMovePct = percentChange(currentPrice, previous.c);
  const ema20DistancePct = ((currentPrice - ema20) / ema20) * 100;
  const trendPersistence = calculateTrendPersistenceScore(validCandles);
  const freshAge = freshBreakoutAge(validCandles);
  const consolidationCandles = countEntryConsolidationCandles(validCandles, freshAge);
  const return20Pct = percentChangeOverLookback(closes, 20);
  const return40Pct = percentChangeOverLookback(closes, 40);
  if (isLateExtendedBreakout(freshAge, return20Pct, return40Pct, ema20DistancePct, consolidationCandles)) {
    return null;
  }
  if (isOverextendedSwingSetup(return20Pct, return40Pct, ema20DistancePct, consolidationCandles, latestMovePct)) {
    return null;
  }
  const liquidityScore = liquidityAdjustment(avgTurnover);
  const quality = breakoutQualityDetails(freshAge, consolidationCandles, rvol, trendPersistence, liquidityScore);
  const entryType: SwingCandidate["entryType"] = recommendation.entryType === "Breakout" ? "BREAKOUT" : "PULLBACK";

  return {
    symbol: stock.symbol,
    sector: stock.sectorName,
    tradeDate: getISTDateStr(last.t),
    signalTime: new Date(last.t * 1000).toISOString(),
    currentPrice,
    entryPrice,
    sl,
    target,
    score: 0,
    signalScore: r2(recommendation.score),
    grade: "C",
    setup: "Trend Continuation",
    entryType,
    reason: recommendation.notes.join("; "),
    expectedHoldDays: SWING_EXPECTED_HOLD_DAYS,
    recentReturn: r2(recentReturn),
    relativeStrength: r2(relativeStrength),
    sectorRelativeStrength: r2(sectorRelativeStrength),
    rvol: r2(rvol),
    avgTurnover: Math.round(avgTurnover),
    entryDistancePct: r2(entryDistancePct),
    riskPct: r2(riskPct),
    rewardRisk: r2(rewardRisk),
    breakoutQuality: quality.grade,
    trendPersistence: r2(trendPersistence),
    freshBreakoutAge: freshAge,
    consolidationCandles,
    setupType: "trend_continuation",
    latestMovePct: r2(latestMovePct),
    ema20DistancePct: r2(ema20DistancePct),
    liquidityScore: r2(liquidityScore),
    intradaySignal: recommendation.intraday,
    swingSignal: recommendation.swing,
    shortTermSignal: recommendation.shortTerm,
    longTermSignal: recommendation.longTerm,
    breakoutSignal: recommendation.breakout,
    ichimokuTrend: recommendation.ichimokuTrend,
    marketRegime: "Unknown",
    marketBreadthPct: null,
    industryAdvanceRatio: null,
    industryBreadthText: null,
    weakMarketSignalDowngrade: false,
    indexTrendIndex: null,
    indexTrendDirection: "Unknown",
    indexTrendText: null,
    indexTrendScoreAdjustment: 0,
    technicalStage: null,
    technicalScoreAdjustment: 0,
    technicalIndicatorText: null,
    technicalRs55: null,
    technicalVolumeRatio: null,
    technicalAboveEma200: null,
    technicalMacdTrend: "Unknown",
    technicalAdxTrend: "Unknown",
    insiderActivity: "None",
    insiderScoreAdjustment: 0,
    insiderActivityText: null,
    insiderTransactionValue: null,
    insiderTransactionDate: null,
    insiderCategory: null,
  };
}

function finalizeSwingCandidates(
  candidates: SwingCandidate[],
  niftyReturn: number,
  sectorPerformanceInput?: Map<string, number>,
  marketRegime: MarketRegimeSnapshot = {
    marketRegime: "Unknown",
    marketBreadthAbove: null,
    marketBreadthTotal: null,
    marketBreadthPct: null,
    marketBreadthSource: "unavailable",
    niftyAboveEma20: null,
    niftyAboveEma50: null,
    marketStats: null,
  },
  indexTrend: IndexTrendPayload | null = null,
  industryStrength: IndustryStrengthPayload | null = null,
  technicalIndicatorsBySymbol: Map<string, TechnicalIndicatorImpact> = new Map(),
  insiderActivityBySymbol: Map<string, InsiderActivityImpact> = new Map(),
): SwingCandidate[] {
  if (candidates.length === 0) return [];

  const sectorPerformance = new Map(sectorPerformanceInput ?? []);
  if (sectorPerformance.size === 0) {
    const bySector = new Map<string, { sum: number; count: number }>();
    for (const candidate of candidates) {
      const existing = bySector.get(candidate.sector) ?? { sum: 0, count: 0 };
      existing.sum += candidate.recentReturn;
      existing.count += 1;
      bySector.set(candidate.sector, existing);
    }

    for (const [sector, values] of bySector.entries()) {
      sectorPerformance.set(sector, values.count ? values.sum / values.count : 0);
    }
  }

  const withSector = candidates.map((candidate) => {
    const sectorPerf = sectorPerformance.get(candidate.sector) ?? 0;
    const sectorRelativeStrength = sectorPerf - niftyReturn;
    return {
      ...candidate,
      relativeStrength: r2(candidate.recentReturn - niftyReturn),
      sectorRelativeStrength: r2(sectorRelativeStrength),
    };
  });

  const leaderAdjustments = sectorLeaderAdjustments(withSector);
  return withSector
    .map((candidate) => {
      const sectorPerf = sectorPerformance.get(candidate.sector) ?? 0;
      if (candidate.entryDistancePct > DD_MAX_RANKED_ENTRY_GAP_PERCENT) return null;
      if (candidate.riskPct > SWING_MAX_RISK_PCT) return null;
      if (candidate.rewardRisk < SWING_MIN_REWARD_RISK) return null;

      const weakLiquidity = candidate.avgTurnover < SWING_MIN_AVG_TURNOVER;
      const weakSector = candidate.sectorRelativeStrength < SWING_MIN_SECTOR_RELATIVE_STRENGTH;
      if (weakLiquidity && weakSector) return null;

      const hasConsolidation = candidate.consolidationCandles >= SWING_MIN_CONSOLIDATION_CANDLES;
      if (candidate.entryDistancePct < SWING_MIN_PULLBACK_GAP_PCT && !hasConsolidation) return null;

      const relativeStrengthScore = relativeStrengthAdjustment(candidate.relativeStrength);
      const sectorMomentumScore = sectorMomentumAdjustment(candidate.sectorRelativeStrength) +
        bankWeakMarketSectorPenalty(candidate, marketRegime);
      const liquidityScore = liquidityAdjustment(candidate.avgTurnover);
      const rvolScore = rvolAdjustment(candidate.rvol);
      const entryScore = entryDistanceAdjustment(candidate.entryDistancePct);
      const riskScore = swingRiskAdjustment(candidate.riskPct);
      const breakoutBonus = freshBreakoutBonus(candidate.freshBreakoutAge);
      const trendAdjustment = trendPersistenceAdjustment(candidate.trendPersistence);
      const leaderAdjustment = leaderAdjustments.get(candidate.symbol)?.adjustment ?? 0;
      const industryAdvanceRatio = marketStatsSectorAdvanceRatio(candidate.sector, marketRegime.marketStats);
      const industryPenalty = industryBreadthPenalty(industryAdvanceRatio);
      const industryAvgChange = marketStatsSectorAvgChange(candidate.sector, marketRegime.marketStats);
      const industryStrengthContext = industryStrengthImpact(candidate.sector, industryStrength, industryAvgChange);
      const insiderActivity = insiderActivityBySymbol.get(candidate.symbol) ?? null;
      const insiderAdjustment = insiderActivity?.scoreAdjustment ?? 0;
      const indexTrendImpact = swingIndexTrendImpact(candidate.sector, indexTrend);
      const technicalImpact = technicalIndicatorsBySymbol.get(candidate.symbol) ?? null;
      if (blocksSwingMarketTrendGate(candidate.sector, indexTrend)) return null;
      if (!passesSwingTechnicalLeadershipGate(candidate, technicalImpact, technicalIndicatorsBySymbol.size > 0)) return null;
      const technicalAdjustment = technicalImpact?.scoreAdjustment ?? 0;
      const rawScore =
        (relativeStrengthScore * DD_RANKING_WEIGHTS.relativeStrength) +
        (rvolScore * DD_RANKING_WEIGHTS.rvol) +
        (sectorMomentumScore * DD_RANKING_WEIGHTS.sector) +
        (liquidityScore * DD_RANKING_WEIGHTS.liquidity) +
        (entryScore * DD_RANKING_WEIGHTS.entry) +
        riskScore +
        breakoutBonus +
        trendAdjustment +
        leaderAdjustment +
        sectorExhaustionPenalty(sectorPerf) +
        industryPenalty +
        industryStrengthContext.adjustment +
        indexTrendImpact.scoreAdjustment +
        technicalAdjustment +
        insiderAdjustment +
        momentumExhaustionPenalty(candidate);
      const score = r2(normalizeOpportunityScore(rawScore) * marketRegimeScoreMultiplier(marketRegime.marketRegime));
      const grade = confidenceGrade(score);
      const quality = breakoutQualityDetails(
        candidate.freshBreakoutAge,
        candidate.consolidationCandles,
        candidate.rvol,
        candidate.trendPersistence,
        liquidityScore,
      );
      const setupType = classifyDdSetupType(candidate, breakoutBonus, leaderAdjustment);
      const weakMarketSignalDowngrade = isStrictWeakMarketContext(marketRegime);
      const intradaySignal = weakMarketSignalDowngrade
        ? downgradeIntradaySignalForWeakMarket(candidate.intradaySignal)
        : candidate.intradaySignal;
      const swingSignal = weakMarketSignalDowngrade
        ? downgradeBuySignalForWeakMarket(candidate.swingSignal)
        : candidate.swingSignal;
      const longTermSignal = weakMarketSignalDowngrade
        ? downgradeBuySignalForWeakMarket(candidate.longTermSignal)
        : candidate.longTermSignal;
      const hasBuySignalAfterMarketFilter = [
        swingSignal,
        candidate.shortTermSignal,
        longTermSignal,
        candidate.breakoutSignal,
        candidate.ichimokuTrend,
      ].some(isBuyRecommendation);
      if (!hasBuySignalAfterMarketFilter) return null;

      const finalized: SwingCandidate = {
        ...candidate,
        score,
        grade,
        setupType,
        setup: setupTypeLabel(setupType),
        expectedHoldDays: expectedHoldDaysForSetup(setupType),
        liquidityScore: r2(liquidityScore),
        breakoutQuality: quality.grade,
        intradaySignal,
        swingSignal,
        longTermSignal,
        marketRegime: marketRegime.marketRegime,
        marketBreadthPct: marketRegime.marketBreadthPct !== null ? r2(marketRegime.marketBreadthPct) : null,
        industryAdvanceRatio: industryAdvanceRatio !== null ? r2(industryAdvanceRatio) : null,
        industryBreadthText: marketStatsSectorText(candidate.sector, marketRegime.marketStats),
        weakMarketSignalDowngrade,
        indexTrendIndex: indexTrendImpact.indexName,
        indexTrendDirection: indexTrendImpact.direction,
        indexTrendText: indexTrendImpact.text,
        indexTrendScoreAdjustment: r2(indexTrendImpact.scoreAdjustment),
        technicalStage: technicalImpact?.stage ?? null,
        technicalScoreAdjustment: r2(technicalAdjustment),
        technicalIndicatorText: technicalImpact?.text ?? null,
        technicalRs55: technicalImpact?.rs55 !== null && technicalImpact?.rs55 !== undefined ? r2(technicalImpact.rs55) : null,
        technicalVolumeRatio: technicalImpact?.volumeRatio !== null && technicalImpact?.volumeRatio !== undefined ? r2(technicalImpact.volumeRatio) : null,
        technicalAboveEma200: technicalImpact?.aboveEma200 ?? null,
        technicalMacdTrend: technicalImpact?.macdTrend ?? "Unknown",
        technicalAdxTrend: technicalImpact?.adxTrend ?? "Unknown",
        insiderActivity: insiderActivity?.activity ?? "None",
        insiderScoreAdjustment: r2(insiderAdjustment),
        insiderActivityText: insiderActivity?.text ?? null,
        insiderTransactionValue: insiderActivity?.transactionValue !== null && insiderActivity?.transactionValue !== undefined
          ? Math.round(insiderActivity.transactionValue)
          : null,
        insiderTransactionDate: insiderActivity?.transactionDate ?? null,
        insiderCategory: insiderActivity?.category ?? null,
        reason: `${candidate.reason}; Risk ${r2(candidate.riskPct)}%; RR ${r2(candidate.rewardRisk)}; Market ${marketRegime.marketRegime}; Breadth ${marketRegime.marketBreadthPct !== null ? `${r2(marketRegime.marketBreadthPct)}%` : "N/A"}; Industry breadth ${industryAdvanceRatio !== null ? r2(industryAdvanceRatio) : "N/A"}${industryStrengthContext.text ? `; ${industryStrengthContext.text}` : ""}${indexTrendImpact.text ? `; ${indexTrendImpact.text}; index trend adjustment ${r2(indexTrendImpact.scoreAdjustment)}` : ""}${technicalImpact?.text ? `; ${technicalImpact.text}; technical adjustment ${r2(technicalAdjustment)}` : ""}${insiderActivity?.text ? `; ${insiderActivity.text}; insider adjustment ${r2(insiderAdjustment)}` : ""}; Sector perf ${r2(sectorPerf)}%; RS ${r2(candidate.relativeStrength)}%; sector RS ${r2(candidate.sectorRelativeStrength)}%; ranking raw ${r2(rawScore)}`,
      };
      if (finalized.score < SWING_MIN_SCORE || !isPublicShareSwingPick(finalized)) return null;
      return finalized;
    })
    .filter((candidate): candidate is SwingCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score || a.riskPct - b.riskPct || b.rewardRisk - a.rewardRisk || b.signalScore - a.signalScore);
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

function isOpenSwingTradeStatus(status: string | null | undefined): boolean {
  return OPEN_SWING_TRADE_STATUSES.includes(status as SwingTradeStatus);
}

function isTerminalSwingTradeStatus(status: string | null | undefined): boolean {
  return ["TARGET HIT", "SL HIT", "CLOSED", "EXPIRED"].includes(String(status ?? ""));
}

async function fetchOpenSwingSymbols(symbols: string[]): Promise<Set<string>> {
  const normalizedSymbols = Array.from(new Set(symbols.map(normalizeEquitySymbol).filter(Boolean)));
  if (normalizedSymbols.length === 0) return new Set();

  await ensureSwingTradesTable();
  const result = await pool.query(
    `
      SELECT DISTINCT symbol
      FROM swing_trades
      WHERE status = ANY($1::text[])
        AND symbol = ANY($2::text[])
    `,
    [OPEN_SWING_TRADE_STATUSES, normalizedSymbols],
  );

  return new Set(result.rows.map((row) => normalizeEquitySymbol(String(row.symbol))));
}

function compareSwingTradeDisplay(a: SwingTrackerTrade, b: SwingTrackerTrade): number {
  const dateCompare = b.date.localeCompare(a.date);
  if (dateCompare !== 0) return dateCompare;
  return Date.parse(a.signalTime) - Date.parse(b.signalTime);
}

function preferredOpenSwingTrade(a: SwingTrackerTrade, b: SwingTrackerTrade): SwingTrackerTrade {
  const priority = (trade: SwingTrackerTrade) =>
    trade.status === "EXIT REVIEW" ? 3
      : trade.status === "ACTIVE" ? 2
        : 1;
  const priorityDiff = priority(a) - priority(b);
  if (priorityDiff !== 0) return priorityDiff > 0 ? a : b;

  const aTime = Date.parse(a.signalTime);
  const bTime = Date.parse(b.signalTime);
  return (Number.isFinite(aTime) ? aTime : 0) <= (Number.isFinite(bTime) ? bTime : 0) ? a : b;
}

function dedupeOpenSwingTrades(trades: SwingTrackerTrade[]): SwingTrackerTrade[] {
  const openBySymbol = new Map<string, SwingTrackerTrade>();
  const closedTrades: SwingTrackerTrade[] = [];

  for (const trade of trades) {
    if (!isOpenSwingTradeStatus(trade.status)) {
      closedTrades.push(trade);
      continue;
    }

    const symbol = normalizeEquitySymbol(trade.symbol);
    const existing = openBySymbol.get(symbol);
    openBySymbol.set(symbol, existing ? preferredOpenSwingTrade(existing, trade) : trade);
  }

  return [...closedTrades, ...openBySymbol.values()].sort(compareSwingTradeDisplay);
}

function latestSwingTradeDate(candidates: SwingCandidate[]): string {
  return candidates
    .map((candidate) => candidate.tradeDate)
    .filter(Boolean)
    .sort()
    .at(-1) ?? getTodayISTDateStr();
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
  const scanTime = new Date().toISOString();
  const [
    niftyReturn,
    marketRegime,
    indexTrend,
    industryStrength,
    technicalIndicatorsBySymbol,
    insiderActivityBySymbol,
  ] = await Promise.all([
    fetchNiftyDailyReturn(),
    fetchMarketRegimeSnapshot(),
    fetchIndexTrendPayload(),
    fetchIndustryStrengthAnalysis(),
    fetchTechnicalIndicatorMap(),
    fetchInsiderActivityMap(),
  ]);
  const stockBySymbol = new Map(universe.map((stock) => [stock.symbol, stock]));
  const sectorReturnTotals = new Map<string, { sum: number; count: number }>();
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
        const recentReturn = calculateSwingRecentReturn(candles);
        if (recentReturn !== null) {
          const existing = sectorReturnTotals.get(stock.sectorName) ?? { sum: 0, count: 0 };
          existing.sum += recentReturn;
          existing.count += 1;
          sectorReturnTotals.set(stock.sectorName, existing);
        }
        candidate = analyzeSwingCandidate(stock, candles, niftyReturn);
        if (candidate) {
          candidate.signalTime = scanTime;
        }
      }

      processedCount += 1;
      if (candidate) candidateCount += 1;
      onProgress?.(processedCount, candidateCount);
      return candidate;
    },
  );

  const candidates = finalizeSwingCandidates(
    analyzed.filter((candidate): candidate is SwingCandidate => candidate !== null),
    niftyReturn,
    new Map(
      [...sectorReturnTotals.entries()].map(([sector, value]) => [
        sector,
        value.count ? value.sum / value.count : 0,
      ]),
    ),
    marketRegime,
    indexTrend,
    industryStrength,
    technicalIndicatorsBySymbol,
    insiderActivityBySymbol,
  );
  const openSymbols = await fetchOpenSwingSymbols(candidates.map((candidate) => candidate.symbol));
  const availableCandidates = candidates.filter((candidate) =>
    !openSymbols.has(normalizeEquitySymbol(candidate.symbol))
  );
  const picks = limitSwingPicksBySector(availableCandidates, limit);
  const resultDate = latestSwingTradeDate(picks.length ? picks : candidates);
  const savedCount = await persistSwingCandidates(picks, scanTime);

  return {
    fetchedAt: scanTime,
    date: resultDate,
    selectedSectors,
    sectorCount: selectedSectors.length,
    universeCount: universe.length,
    candidateCount: availableCandidates.length,
    savedCount,
    niftyReturn: r2(niftyReturn),
    marketRegime: marketRegime.marketRegime,
    marketBreadthPct: marketRegime.marketBreadthPct !== null ? r2(marketRegime.marketBreadthPct) : null,
    diagnostics: {
      rawCandidates: analyzed.filter((candidate): candidate is SwingCandidate => candidate !== null).length,
      finalCandidates: candidates.length,
      availableCandidates: availableCandidates.length,
      excludedOpenSymbols: candidates.length - availableCandidates.length,
      technicalIndicatorSymbols: technicalIndicatorsBySymbol.size,
      technicalDataAvailable: technicalIndicatorsBySymbol.size > 0,
    },
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
    indexTrendIndex: row.index_trend_index === null || row.index_trend_index === undefined
      ? null
      : String(row.index_trend_index),
    indexTrendDirection: row.index_trend_direction === null || row.index_trend_direction === undefined
      ? null
      : String(row.index_trend_direction) as IndexTrendDirection,
    indexTrendText: row.index_trend_text === null || row.index_trend_text === undefined
      ? null
      : String(row.index_trend_text),
    indexTrendScoreAdjustment: String(row.index_trend_score_adjustment ?? "0"),
    technicalStage: row.technical_stage === null || row.technical_stage === undefined
      ? null
      : String(row.technical_stage),
    technicalScoreAdjustment: String(row.technical_score_adjustment ?? "0"),
    technicalIndicatorText: row.technical_indicator_text === null || row.technical_indicator_text === undefined
      ? null
      : String(row.technical_indicator_text),
    technicalRs55: row.technical_rs55 === null || row.technical_rs55 === undefined
      ? null
      : String(row.technical_rs55),
    technicalVolumeRatio: row.technical_volume_ratio === null || row.technical_volume_ratio === undefined
      ? null
      : String(row.technical_volume_ratio),
    technicalAboveEma200: row.technical_above_ema200 === null || row.technical_above_ema200 === undefined
      ? null
      : Boolean(row.technical_above_ema200),
    technicalMacdTrend: row.technical_macd_trend === null || row.technical_macd_trend === undefined
      ? null
      : String(row.technical_macd_trend) as TechnicalTrendDirection,
    technicalAdxTrend: row.technical_adx_trend === null || row.technical_adx_trend === undefined
      ? null
      : String(row.technical_adx_trend) as TechnicalTrendDirection,
    insiderActivity: row.insider_activity === null || row.insider_activity === undefined
      ? null
      : String(row.insider_activity) as InsiderActivityDirection,
    insiderScoreAdjustment: String(row.insider_score_adjustment ?? "0"),
    insiderActivityText: row.insider_activity_text === null || row.insider_activity_text === undefined
      ? null
      : String(row.insider_activity_text),
    insiderTransactionValue: row.insider_transaction_value === null || row.insider_transaction_value === undefined
      ? null
      : String(row.insider_transaction_value),
    insiderTransactionDate: row.insider_transaction_date === null || row.insider_transaction_date === undefined
      ? null
      : String(row.insider_transaction_date),
    insiderCategory: row.insider_category === null || row.insider_category === undefined
      ? null
      : String(row.insider_category),
  };
}

async function persistSwingCandidates(candidates: SwingCandidate[], scanTime: string): Promise<number> {
  await ensureSwingTradesTable();
  let saved = 0;

  const openSymbols = await fetchOpenSwingSymbols(candidates.map((candidate) => candidate.symbol));
  const candidateDates = Array.from(new Set(candidates.map((candidate) => candidate.tradeDate)));

  for (const date of candidateDates) {
    await pool.query(
      `
        UPDATE swing_trades
        SET signal_time = $2
        WHERE date = $1
          AND to_char(signal_time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') = '00:00'
      `,
      [date, scanTime],
    );
  }

  for (const candidate of candidates) {
    if (openSymbols.has(normalizeEquitySymbol(candidate.symbol))) continue;

    const result = await pool.query(
      `
        INSERT INTO swing_trades (
          symbol, date, signal_time, sector, direction, entry_type,
          current_price, entry_price, sl, target, score, grade, setup, reason,
          expected_hold_days, status, last_price, last_checked_at,
          index_trend_index, index_trend_direction, index_trend_text,
          index_trend_score_adjustment,
          technical_stage, technical_score_adjustment, technical_indicator_text,
          technical_rs55, technical_volume_ratio, technical_above_ema200,
          technical_macd_trend, technical_adx_trend,
          insider_activity, insider_score_adjustment, insider_activity_text,
          insider_transaction_value, insider_transaction_date, insider_category
        )
        VALUES (
          $1, $2, $3, $4, 'LONG', $5,
          $6, $7, $8, $9, $10, $11, $12, $13,
          $14, 'WATCHLIST', $15, $16,
          $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28,
          $29, $30, $31, $32, $33, $34
        )
        ON CONFLICT (symbol, date) DO UPDATE
        SET signal_time = EXCLUDED.signal_time,
            score = EXCLUDED.score,
            grade = EXCLUDED.grade,
            reason = EXCLUDED.reason,
            index_trend_index = EXCLUDED.index_trend_index,
            index_trend_direction = EXCLUDED.index_trend_direction,
            index_trend_text = EXCLUDED.index_trend_text,
            index_trend_score_adjustment = EXCLUDED.index_trend_score_adjustment,
            technical_stage = EXCLUDED.technical_stage,
            technical_score_adjustment = EXCLUDED.technical_score_adjustment,
            technical_indicator_text = EXCLUDED.technical_indicator_text,
            technical_rs55 = EXCLUDED.technical_rs55,
            technical_volume_ratio = EXCLUDED.technical_volume_ratio,
            technical_above_ema200 = EXCLUDED.technical_above_ema200,
            technical_macd_trend = EXCLUDED.technical_macd_trend,
            technical_adx_trend = EXCLUDED.technical_adx_trend,
            insider_activity = EXCLUDED.insider_activity,
            insider_score_adjustment = EXCLUDED.insider_score_adjustment,
            insider_activity_text = EXCLUDED.insider_activity_text,
            insider_transaction_value = EXCLUDED.insider_transaction_value,
            insider_transaction_date = EXCLUDED.insider_transaction_date,
            insider_category = EXCLUDED.insider_category
        WHERE to_char(swing_trades.signal_time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') = '00:00'
        RETURNING id
      `,
      [
        candidate.symbol,
        candidate.tradeDate,
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
        candidate.indexTrendIndex,
        candidate.indexTrendDirection,
        candidate.indexTrendText,
        String(candidate.indexTrendScoreAdjustment),
        candidate.technicalStage,
        String(candidate.technicalScoreAdjustment),
        candidate.technicalIndicatorText,
        candidate.technicalRs55 === null ? null : String(candidate.technicalRs55),
        candidate.technicalVolumeRatio === null ? null : String(candidate.technicalVolumeRatio),
        candidate.technicalAboveEma200,
        candidate.technicalMacdTrend,
        candidate.technicalAdxTrend,
        candidate.insiderActivity,
        String(candidate.insiderScoreAdjustment),
        candidate.insiderActivityText,
        candidate.insiderTransactionValue === null ? null : String(candidate.insiderTransactionValue),
        candidate.insiderTransactionDate,
        candidate.insiderCategory,
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

function swingActivationWindowDates(candles: Candle[], signalTime: string, fallbackSignalDate: string): string[] {
  const dates: string[] = [];
  const seen = new Set<string>();
  for (const candle of candles) {
    const date = getISTDateStr(candle.t);
    if (!swingEntryDateIsEligible(date, signalTime, fallbackSignalDate)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    dates.push(date);
    if (dates.length >= SWING_ENTRY_VALID_TRADING_DAYS) break;
  }
  return dates;
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
  let intradayCandleData: CandleData | null | undefined;

  if (
    entryHitDate &&
    !swingEntryDateIsEligible(entryHitDate, trade.signalTime, trade.date)
  ) {
    status = "WATCHLIST";
    entryHitDate = null;
    exitDate = null;
  }

  if (
    candles?.length &&
    entryHitDate &&
    !isTerminalSwingTradeStatus(status) &&
    !swingActivationWindowDates(candles, trade.signalTime, trade.date).includes(entryHitDate)
  ) {
    const expiryDates = swingActivationWindowDates(candles, trade.signalTime, trade.date);
    status = "EXPIRED";
    entryHitDate = null;
    exitDate = expiryDates.at(-1) ?? null;
  }

  if (candles?.length && !isTerminalSwingTradeStatus(status)) {
    const postSignalCandles = candles
      .filter((c) => swingEntryDateIsEligible(getISTDateStr(c.t), trade.signalTime, trade.date))
      .sort((a, b) => a.t - b.t);
    const activationWindowCandles = postSignalCandles.slice(0, SWING_ENTRY_VALID_TRADING_DAYS);

    if (status === "WATCHLIST" && !entryHitDate) {
      for (const candle of activationWindowCandles) {
        const candleDate = getISTDateStr(candle.t);
        const entryTouched = trade.entryType === "BREAKOUT"
          ? candle.h >= entry
          : candle.l <= entry;
        if (entryTouched) {
          if (intradayCandleData === undefined) {
            intradayCandleData = await fetchCandles(trade.symbol).catch(() => null);
          }
          if (!passesSwingIntradayEntryStructure(intradayCandleData, candleDate, entry, trade.entryType)) {
            continue;
          }
          status = "ACTIVE";
          entryHitDate = candleDate;
          break;
        }
      }
    }

    if ((status === "ACTIVE" || status === "EXIT REVIEW") && entryHitDate) {
      for (const candle of postSignalCandles) {
        const candleDate = getISTDateStr(candle.t);
        if (candleDate < entryHitDate) continue;

        // Daily candles do not expose whether high or low happened first, so prefer the conservative SL-first outcome.
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

    if (
      status === "WATCHLIST" &&
      !entryHitDate &&
      postSignalCandles.length >= SWING_ENTRY_VALID_TRADING_DAYS
    ) {
      status = "EXPIRED";
      exitDate = getISTDateStr(activationWindowCandles.at(-1)!.t);
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
    status === "WATCHLIST" || status === "EXPIRED" ? null
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
               expected_hold_days, status, entry_hit_date, exit_date, last_price, last_checked_at,
               index_trend_index, index_trend_direction, index_trend_text,
               index_trend_score_adjustment,
               technical_stage, technical_score_adjustment, technical_indicator_text,
               technical_rs55, technical_volume_ratio, technical_above_ema200,
               technical_macd_trend, technical_adx_trend,
               insider_activity, insider_score_adjustment, insider_activity_text,
               insider_transaction_value, insider_transaction_date, insider_category
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

    let resolved = dedupeOpenSwingTrades(
      enriched.filter((trade): trade is SwingTrackerTrade => trade !== null),
    );
    if (statusFilter !== "ALL") {
      resolved = resolved.filter((trade) => String(trade.status).toUpperCase() === statusFilter);
    }

    const summary = {
      total: resolved.length,
      watchlist: resolved.filter((trade) => trade.status === "WATCHLIST").length,
      active: resolved.filter((trade) => trade.status === "ACTIVE").length,
      targetHit: resolved.filter((trade) => trade.status === "TARGET HIT").length,
      slHit: resolved.filter((trade) => trade.status === "SL HIT").length,
      exitReview: resolved.filter((trade) => trade.status === "EXIT REVIEW").length,
      expired: resolved.filter((trade) => trade.status === "EXPIRED").length,
      open: resolved.filter((trade) => isOpenSwingTradeStatus(trade.status)).length,
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
    const scannerWarnings: ScannerWarning[] = [];

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
      marketAlignment: MarketAlignmentStatus;
      marketAlignmentText: string | null;
      marketTrendScoreAdjustment: number;
      marketTrendIndex: "NIFTY" | "BANKNIFTY" | null;
      score: number;
    }> = [];
    const indexTrend = await fetchIndexTrendPayload();

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
            (symbol) => enrichWithIndicators(symbol, sector.name, indexTrend),
          );

          for (const ind of indicators) {
            if (ind.warning) {
              scannerWarnings.push(ind.warning);
              req.log.warn({ warning: ind.warning }, "Momentum scanner symbol warning");
            }
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
                + priceActionVolumeBonus
                + ind.marketTrendScoreAdjustment;

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
                marketAlignment: ind.marketAlignment,
                marketAlignmentText: ind.marketAlignmentText,
                marketTrendScoreAdjustment: ind.marketTrendScoreAdjustment,
                marketTrendIndex: ind.marketTrendIndex,
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
              marketAlignment: ind.marketAlignment,
              marketAlignmentText: ind.marketAlignmentText,
              marketTrendScoreAdjustment: ind.marketTrendScoreAdjustment,
              marketTrendIndex: ind.marketTrendIndex,
              warning: ind.warning,
            };
          });

          return {
            sectorName: sector.name,
            sectorKeyword: sector.keyword,
            sectorChangePct: sector.changePct,
            stocks,
          };
        } catch (err) {
          const warning = scannerWarning(
            null,
            sector.name,
            "SECTOR_SCAN_FAILED",
            `Sector scan failed: ${unknownErrorMessage(err)}`,
          );
          scannerWarnings.push(warning);
          req.log.warn({ err, sector: sector.name }, "Momentum scanner sector warning");
          return {
            sectorName: sector.name,
            sectorKeyword: sector.keyword,
            sectorChangePct: sector.changePct,
            stocks: [],
            warning,
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
      warnings: scannerWarnings.map((w) => w.message),
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
            hitTime = getCandleCloseTimeIST(c);
            break;
          }

          if (hitsStop(c, entryPrice)) {
            newStatus = "T1 HIT & TRAILING SL HIT";
            hitTime = getCandleCloseTimeIST(c);
            break;
          }

          continue;
        }

        if (hitsStop(c, originalSl)) {
          newStatus = "SL HIT";
          hitTime = getCandleCloseTimeIST(c);
          break;
        }

        if (hitsTarget(c, target2)) {
          newStatus = "TARGET 2 HIT";
          hitTime = getCandleCloseTimeIST(c);
          break;
        }
        if (hitsTarget(c, target1) && maxTargetReached < 1) {
          maxTargetReached = 1;
          newStatus = "TARGET 1 HIT";
          hitTime = getCandleCloseTimeIST(c);
        }
      }
      
      if (forceSquareOff && (newStatus === "ACTIVE" || newStatus === "TARGET 1 HIT")) {
        newStatus = "SQUARED OFF";
        const lastCandle = postSignalCandles[postSignalCandles.length - 1];
        if (lastCandle) {
          hitTime = getCandleCloseTimeIST(lastCandle);
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
            hitTime = getCandleCloseTimeIST(c);
            exitPrice = t2;
            plPctOverride = plPctForScaledExit(entry, t1, t2, direction);
            break;
          }

          if (hitsStop(c, entry)) {
            status = "T1 HIT & TRAILING SL HIT";
            hitTime = getCandleCloseTimeIST(c);
            exitPrice = entry;
            plPctOverride = plPctForScaledExit(entry, t1, entry, direction);
            break;
          }

          continue;
        }

        if (hitsStop(c, sl)) {
          status = "SL HIT";
          hitTime = getCandleCloseTimeIST(c);
          exitPrice = sl;
          break;
        }

        if (hitsTarget(c, t2)) {
          status = "TARGET 2 HIT";
          hitTime = getCandleCloseTimeIST(c);
          exitPrice = t2;
          plPctOverride = plPctForScaledExit(entry, t1, t2, direction);
          break;
        }

        if (hitsTarget(c, t1)) {
          maxTargetReached = 1;
          status = "TARGET 1 HIT";
          hitTime = getCandleCloseTimeIST(c);
          exitPrice = t1;
          plPctOverride = plPctForScaledExit(entry, t1, entry, direction);
        }
      }

      const today = getTodayISTDateStr();
      const shouldSquareOff = trade.date < today || (trade.date === today && isIntradaySquareOffTimeIST());
      if (shouldSquareOff && (status === "ACTIVE" || status === "TARGET 1 HIT")) {
        const squareOffCandle = postSignalCandles.at(-1);
        status = "SQUARED OFF";
        hitTime = squareOffCandle ? getCandleCloseTimeIST(squareOffCandle) : "15:15";
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
