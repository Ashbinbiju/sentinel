/**
 * Backtest engine for the structural swing strategy (swing-structural-strategy.ts).
 *
 * Walks each stock's real daily candle history day by day, calling the exact
 * same analyzeStructuralSwingSetup() used in production against a growing
 * window of history, so signal detection has the same no-look-ahead-bias
 * guarantee live scanning has. Each detected signal is then simulated forward
 * under three independent risk:reward targets (1:1, 1.5:1, 2:1) sharing the
 * same entry price and stop-loss, since the strategy's default is 1:1 but
 * the question of whether a wider target would have performed better is a
 * "what if" on the exact same entries, not a different set of signals.
 */
import { analyzeStructuralSwingSetup } from "./swing-structural-strategy.js";
import type { Candle, StructuralStrategyConfig } from "./swing-structural-strategy.js";
import { SWING_SECTORS } from "./swing-universe.js";

// ---- Data fetching (self-contained Upstox v3 daily candles, mirrors the
// pattern in routes/stocks.ts but with a caller-supplied date range) -------

const UPSTOX_INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
let instrumentMapPromise: Promise<Map<string, string>> | null = null;

async function getInstrumentMap(): Promise<Map<string, string>> {
  if (!instrumentMapPromise) {
    instrumentMapPromise = (async () => {
      const zlib = await import("zlib");
      const response = await fetch(UPSTOX_INSTRUMENTS_URL);
      if (!response.ok) throw new Error(`Upstox instruments responded with ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      const json = zlib.gunzipSync(buf).toString("utf8");
      const rows = JSON.parse(json) as Array<{
        segment?: string;
        instrument_type?: string;
        trading_symbol?: string;
        instrument_key?: string;
      }>;
      const map = new Map<string, string>();
      for (const row of rows) {
        if (row.segment === "NSE_EQ" && row.instrument_type === "EQ" && row.trading_symbol && row.instrument_key) {
          map.set(row.trading_symbol.toUpperCase().trim(), row.instrument_key);
        }
      }
      return map;
    })().catch((err) => {
      instrumentMapPromise = null;
      throw err;
    });
  }
  return instrumentMapPromise;
}

async function fetchDailyCandlesRange(symbol: string, fromDate: string, toDate: string): Promise<Candle[] | null> {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN;
  if (!token) throw new Error("UPSTOX_ANALYTICS_TOKEN not set");

  const map = await getInstrumentMap();
  const key = map.get(symbol.replace(/-EQ$/i, "").toUpperCase().trim());
  if (!key) return null;

  const encodedKey = encodeURIComponent(key);
  const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/days/1/${toDate}/${fromDate}`;
  const resp = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;

  const data = (await resp.json()) as any;
  if (data.status !== "success" || !Array.isArray(data.data?.candles)) return null;

  const candles: Candle[] = data.data.candles.map((row: any[]) => ({
    t: Math.floor(Date.parse(row[0]) / 1000),
    o: row[1],
    h: row[2],
    l: row[3],
    c: row[4],
    v: row[5],
  }));
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

// ---- Trade simulation ------------------------------------------------------

export type RRLabel = "1:1" | "1.5:1" | "2:1";

const RR_VARIANTS: { label: RRLabel; multiplier: number }[] = [
  { label: "1:1", multiplier: 1 },
  { label: "1.5:1", multiplier: 1.5 },
  { label: "2:1", multiplier: 2 },
];

// How long a trade is allowed to stay open (trading days) before it's
// marked UNRESOLVED rather than counted as a win or loss.
const MAX_HOLDING_DAYS = 90;

// Matches analyzeStructuralSwingSetup's own minimum data requirement.
const WARMUP_CANDLES = 90;

export interface BacktestTrade {
  symbol: string;
  rr: RRLabel;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  sl: number;
  target: number;
  exitDate: string | null;
  exitPrice: number | null;
  outcome: "TARGET" | "SL" | "UNRESOLVED";
  holdingDays: number | null;
  pnlPct: number | null;
  rMultiple: number | null;
  score: number;
  grade: string;
}

function isoDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toISOString().slice(0, 10);
}

function simulateOutcome(
  candles: Candle[],
  entryIndex: number,
  sl: number,
  target: number,
): { outcome: "TARGET" | "SL" | "UNRESOLVED"; exitIndex: number | null; exitPrice: number | null } {
  const maxIndex = Math.min(candles.length - 1, entryIndex + MAX_HOLDING_DAYS);
  for (let i = entryIndex + 1; i <= maxIndex; i++) {
    const c = candles[i];
    // Conservative: daily candles don't reveal whether the high or low came
    // first intraday, so a candle that could satisfy either is treated as
    // the stop-loss having been hit (matches resolveSwingTrade's own rule).
    if (c.l <= sl) return { outcome: "SL", exitIndex: i, exitPrice: sl };
    if (c.h >= target) return { outcome: "TARGET", exitIndex: i, exitPrice: target };
  }
  return { outcome: "UNRESOLVED", exitIndex: null, exitPrice: null };
}

/**
 * Walks one stock's full daily history, detecting signals with no
 * look-ahead bias and simulating each one under all three RR variants.
 * Signal detection follows one trade at a time, using the live-default 1:1
 * variant's resolution to decide when the stock is free for a new signal —
 * the 1.5:1/2:1 variants are what-if outcomes on the exact same entries,
 * not independently-detected signals, so all three variants are always
 * directly comparable trade-for-trade.
 */
export function backtestSymbol(
  symbol: string,
  candles: Candle[],
  config: Partial<StructuralStrategyConfig> = {},
): BacktestTrade[] {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const trades: BacktestTrade[] = [];

  let i = WARMUP_CANDLES;
  while (i < sorted.length) {
    const window = sorted.slice(0, i + 1);
    const signal = analyzeStructuralSwingSetup(window, config);

    if (signal.isBuySignal && signal.entryPrice !== null && signal.stopLoss !== null && signal.riskPerShare !== null) {
      const entryIndex = i;
      const entryPrice = signal.entryPrice;
      const sl = signal.stopLoss;
      const risk = signal.riskPerShare;

      let gateExitIndex = sorted.length - 1;

      for (const variant of RR_VARIANTS) {
        const target = entryPrice + risk * variant.multiplier;
        const result = simulateOutcome(sorted, entryIndex, sl, target);
        const pnlPct = result.exitPrice !== null ? ((result.exitPrice - entryPrice) / entryPrice) * 100 : null;
        const rMultiple = result.outcome === "TARGET" ? variant.multiplier : result.outcome === "SL" ? -1 : null;

        trades.push({
          symbol,
          rr: variant.label,
          signalDate: isoDate(sorted[entryIndex].t),
          entryDate: isoDate(sorted[entryIndex].t),
          entryPrice,
          sl,
          target,
          exitDate: result.exitIndex !== null ? isoDate(sorted[result.exitIndex].t) : null,
          exitPrice: result.exitPrice,
          outcome: result.outcome,
          holdingDays: result.exitIndex !== null ? result.exitIndex - entryIndex : null,
          pnlPct: pnlPct !== null ? Math.round(pnlPct * 100) / 100 : null,
          rMultiple,
          score: signal.score,
          grade: signal.grade,
        });

        if (variant.label === "1:1" && result.exitIndex !== null) {
          gateExitIndex = result.exitIndex;
        }
      }

      i = gateExitIndex + 1;
    } else {
      i += 1;
    }
  }

  return trades;
}

// ---- Metrics ----------------------------------------------------------------

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  unresolvedTrades: number;
  winRatePct: number | null;
  averageGainPct: number | null;
  averageLossPct: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  averageHoldingDays: number | null;
  largestWinPct: number | null;
  largestLossPct: number | null;
}

function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function computeMetrics(trades: BacktestTrade[]): BacktestMetrics {
  const resolved = trades.filter((t) => t.outcome !== "UNRESOLVED");
  const winners = resolved.filter((t) => t.outcome === "TARGET");
  const losers = resolved.filter((t) => t.outcome === "SL");

  const gains = winners.map((t) => t.pnlPct!);
  const losses = losers.map((t) => t.pnlPct!);
  const sumGains = gains.reduce((a, b) => a + b, 0);
  const sumLossesAbs = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Max drawdown expressed in cumulative R-multiples (not a dollar amount,
  // since this backtest doesn't model position sizing/capital) walked in
  // exit-chronological order.
  const chronological = [...resolved].sort((a, b) => (a.exitDate ?? "").localeCompare(b.exitDate ?? ""));
  let cumR = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of chronological) {
    cumR += t.rMultiple ?? 0;
    peak = Math.max(peak, cumR);
    maxDrawdown = Math.max(maxDrawdown, peak - cumR);
  }

  const holdingDays = resolved.map((t) => t.holdingDays).filter((h): h is number => h !== null);

  return {
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    unresolvedTrades: trades.length - resolved.length,
    winRatePct: resolved.length ? round2((winners.length / resolved.length) * 100) : null,
    averageGainPct: round2(average(gains)),
    averageLossPct: round2(average(losses)),
    profitFactor: sumLossesAbs > 0 ? round2(sumGains / sumLossesAbs) : null,
    maxDrawdownR: round2(maxDrawdown),
    averageHoldingDays: round2(average(holdingDays)),
    largestWinPct: gains.length ? round2(Math.max(...gains)) : null,
    largestLossPct: losses.length ? round2(Math.min(...losses)) : null,
  };
}

// ---- Windowing + orchestration ---------------------------------------------

export interface BacktestWindowReport {
  windowLabel: "1y" | "3y" | "5y";
  cutoffDate: string;
  byRR: Record<RRLabel, BacktestMetrics>;
}

export function buildWindowedReport(allTrades: BacktestTrade[], now: Date): BacktestWindowReport[] {
  const windows: { label: "1y" | "3y" | "5y"; years: number }[] = [
    { label: "1y", years: 1 },
    { label: "3y", years: 3 },
    { label: "5y", years: 5 },
  ];

  return windows.map(({ label, years }) => {
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const inWindow = allTrades.filter((t) => t.signalDate >= cutoffDate);

    const byRR = {} as Record<RRLabel, BacktestMetrics>;
    for (const variant of RR_VARIANTS) {
      byRR[variant.label] = computeMetrics(inWindow.filter((t) => t.rr === variant.label));
    }

    return { windowLabel: label, cutoffDate, byRR };
  });
}

export interface RunBacktestOptions {
  /** Defaults to the full SWING_SECTORS universe (~1160 symbols). */
  symbols?: string[];
  /** Defaults to 5.5 (a bit past the 5y reporting window, for warmup context). */
  yearsOfHistory?: number;
  config?: Partial<StructuralStrategyConfig>;
  concurrency?: number;
  onProgress?: (done: number, total: number, symbol: string) => void;
}

export interface RunBacktestResult {
  trades: BacktestTrade[];
  windows: BacktestWindowReport[];
  symbolsRequested: number;
  symbolsWithData: number;
}

export function fullSwingUniverseSymbols(): string[] {
  return Array.from(new Set(Object.values(SWING_SECTORS).flat().map((s) => s.replace(/-EQ$/i, "").toUpperCase())));
}

export async function runBacktest(options: RunBacktestOptions = {}): Promise<RunBacktestResult> {
  const symbols = options.symbols ?? fullSwingUniverseSymbols();
  const yearsOfHistory = options.yearsOfHistory ?? 5.5;
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setFullYear(fromDate.getFullYear() - Math.floor(yearsOfHistory));
  fromDate.setMonth(fromDate.getMonth() - Math.round((yearsOfHistory % 1) * 12));
  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = now.toISOString().slice(0, 10);

  const allTrades: BacktestTrade[] = [];
  let symbolsWithData = 0;
  let done = 0;

  const concurrency = options.concurrency ?? 3;
  const queue = [...symbols];

  async function worker() {
    while (queue.length) {
      const symbol = queue.shift();
      if (!symbol) break;
      try {
        const candles = await fetchDailyCandlesRange(symbol, fromStr, toStr);
        if (candles && candles.length >= WARMUP_CANDLES) {
          symbolsWithData += 1;
          allTrades.push(...backtestSymbol(symbol, candles, options.config));
        }
      } catch (err: any) {
        console.warn(`[BACKTEST] ${symbol}: ${err.message}`);
      }
      done += 1;
      options.onProgress?.(done, symbols.length, symbol);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    trades: allTrades,
    windows: buildWindowedReport(allTrades, now),
    symbolsRequested: symbols.length,
    symbolsWithData,
  };
}
