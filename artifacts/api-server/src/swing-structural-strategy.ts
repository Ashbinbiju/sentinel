/**
 * Structural swing-trading strategy: Existing Uptrend -> Break of Structure ->
 * Corrective Pullback -> Internal Lower Highs -> Descending Trendline ->
 * Confirmed Bullish Breakout -> BUY, with SL at the corrective swing low and a
 * 1:1 risk/reward target. Operates on daily candles only.
 *
 * All swing-point confirmation uses a strict N-bar fractal rule (a high/low is
 * only "confirmed" once N candles exist on both sides), so nothing here ever
 * uses information that wasn't yet available at the time — the same rule
 * applies whether this is called for a live scan or a backtest.
 */

export interface Candle {
  t: number; // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface StructuralStrategyConfig {
  /** N for swing high/low fractal detection. */
  swingLookback: number;
  /** BOS confirmed if close > previous swing high * (1 + this). */
  bosBufferPct: number;
  /** A swing high counts as a trendline "touch" if within this % of the fitted line. */
  trendlineTouchTolerancePct: number;
  /** Minimum touch points required to accept a trendline. */
  minTrendlineTouches: number;
  /** Breakout candle must close above the trendline by at least this %. */
  breakoutBufferPct: number;
  /** Minimum candle body as a fraction of its total range. */
  minCandleBodyPct: number;
  /** Minimum (close-low)/(high-low) for the breakout candle. */
  minCloseLocationPct: number;
  /** Close-location threshold that earns the "strong" scoring bonus. */
  strongCloseLocationPct: number;
  /** Body% threshold that earns the "strong" scoring bonus. */
  strongCandleBodyPct: number;
  /** Whether volume confirmation is required for a BUY signal. */
  requireVolumeConfirmation: boolean;
  /** Minimum breakout-volume / N-day-average-volume ratio. */
  minVolumeRatio: number;
  /** Volume ratio threshold that earns the "strong" scoring bonus. */
  strongVolumeRatio: number;
  /** Lookback period (days) for the average-volume baseline. */
  volumeAvgPeriod: number;
  /** SL is placed this % below the structural corrective swing low. */
  slBufferPct: number;
  /** Setups with SL distance beyond this % are rejected outright. */
  maxSlPct: number;
  /** Risk:reward ratio for the target (1.0 = 1:1). */
  riskRewardRatio: number;
  /** BREAKOUT_CLOSE = enter at the breakout candle's close (live-scan default).
   *  NEXT_OPEN = enter at the following candle's open (backtest-realistic). */
  entryMode: "BREAKOUT_CLOSE" | "NEXT_OPEN";
  /** Tolerance for internal-lower-high strictly-descending comparisons. */
  lowerHighTolerancePct: number;
}

export const DEFAULT_STRUCTURAL_CONFIG: StructuralStrategyConfig = {
  swingLookback: 3,
  bosBufferPct: 0.25,
  trendlineTouchTolerancePct: 0.5,
  minTrendlineTouches: 3,
  breakoutBufferPct: 0.5,
  minCandleBodyPct: 50,
  minCloseLocationPct: 0.70,
  strongCloseLocationPct: 0.80,
  strongCandleBodyPct: 65,
  requireVolumeConfirmation: true,
  minVolumeRatio: 1.2,
  strongVolumeRatio: 1.5,
  volumeAvgPeriod: 20,
  slBufferPct: 0.25,
  maxSlPct: 15,
  riskRewardRatio: 1.0,
  entryMode: "BREAKOUT_CLOSE",
  lowerHighTolerancePct: 0.1,
};

export interface SwingPoint {
  index: number;
  t: number;
  price: number;
  type: "HIGH" | "LOW";
}

export interface TrendlineResult {
  touches: SwingPoint[];
  slope: number; // price change per candle-index step
  intercept: number; // price at index 0
  priceAt: (index: number) => number;
  qualityScore: number; // 0-100
}

export type WatchlistCategory =
  | "READY_TO_BUY"
  | "BREAKOUT_WATCH"
  | "CORRECTION"
  | "SETUP_FORMING"
  | "INVALIDATED"
  | "NO_SETUP";

export interface StructuralSwingSignal {
  category: WatchlistCategory;
  isBuySignal: boolean;

  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  riskPerShare: number | null;
  slDistancePct: number | null;
  rewardRisk: number | null;

  score: number; // 0-100
  grade: "A+" | "A" | "B" | "Weak" | "Ignore";
  reason: string;

  majorSwingLow: number | null; // swing low that established the existing uptrend
  majorSwingHigh: number | null; // swing high that established the existing uptrend
  bosLevel: number | null; // the swing high that got broken
  newHigh: number | null; // high reached after BOS, start of the correction
  structuralSwingLow: number | null; // the corrective low the SL is based on
  trendline: TrendlineResult | null;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Confirmed swing highs/lows via strict N-bar fractal rule. A point at index i
 * is confirmed only once candles exist at i-N..i+N, so nothing here can use
 * data that wasn't available N bars after the point in question.
 */
export function detectSwingPoints(candles: Candle[], n: number): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= n; k++) {
      if (candles[i - k].h >= c.h || candles[i + k].h >= c.h) isHigh = false;
      if (candles[i - k].l <= c.l || candles[i + k].l <= c.l) isLow = false;
    }
    if (isHigh) points.push({ index: i, t: c.t, price: c.h, type: "HIGH" });
    if (isLow) points.push({ index: i, t: c.t, price: c.l, type: "LOW" });
  }
  return points;
}

/**
 * Collapses raw fractal points into a strictly alternating H/L/H/L pivot
 * sequence (a standard zigzag reduction): when two same-type points occur
 * back to back, keep only the more extreme one.
 */
export function buildPivotSequence(points: SwingPoint[]): SwingPoint[] {
  const sorted = [...points].sort((a, b) => a.index - b.index);
  const pivots: SwingPoint[] = [];

  for (const p of sorted) {
    const last = pivots.at(-1);
    if (!last) {
      pivots.push(p);
      continue;
    }
    if (last.type === p.type) {
      const keepNew =
        p.type === "HIGH" ? p.price > last.price : p.price < last.price;
      if (keepNew) pivots[pivots.length - 1] = p;
    } else {
      pivots.push(p);
    }
  }
  return pivots;
}

/**
 * Fits a line through the given touch points (least-squares on candle index
 * vs price) and scores its quality. Higher score = cleaner, more reliable
 * resistance line.
 */
export function fitTrendline(
  touches: SwingPoint[],
  volumeDecreasing: boolean,
): TrendlineResult | null {
  if (touches.length < 2) return null;

  const n = touches.length;
  const sumX = touches.reduce((s, p) => s + p.index, 0);
  const sumY = touches.reduce((s, p) => s + p.price, 0);
  const sumXY = touches.reduce((s, p) => s + p.index * p.price, 0);
  const sumXX = touches.reduce((s, p) => s + p.index * p.index, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const priceAt = (index: number) => slope * index + intercept;

  // Quality scoring
  let quality = 0;
  if (n >= 5) quality += 40;
  else if (n === 4) quality += 30;
  else quality += 20; // n === 3

  const spans = touches.slice(1).map((p, i) => p.index - touches[i].index);
  const minSpan = Math.min(...spans);
  if (minSpan >= 5) quality += 20;
  else if (minSpan >= 2) quality += 10;

  const avgPrice = sumY / n;
  const slopePctPerBar = Math.abs(slope) / avgPrice * 100;
  if (slopePctPerBar > 0.05 && slopePctPerBar < 5) quality += 15; // clean, not near-horizontal, not vertical

  const fitErrors = touches.map((p) => Math.abs(p.price - priceAt(p.index)) / priceAt(p.index));
  const avgError = fitErrors.reduce((s, e) => s + e, 0) / fitErrors.length;
  if (avgError <= 0.005) quality += 15;
  else if (avgError <= 0.01) quality += 8;

  if (volumeDecreasing) quality += 10;

  return { touches, slope, intercept, priceAt, qualityScore: Math.min(100, quality) };
}

function averageVolume(candles: Candle[], endIndexExclusive: number, period: number): number | null {
  const start = endIndexExclusive - period;
  if (start < 0) return null;
  const slice = candles.slice(start, endIndexExclusive);
  const sum = slice.reduce((s, c) => s + c.v, 0);
  return sum / slice.length;
}

/**
 * Runs the full structural setup detection against a daily candle series,
 * evaluating "as of" the most recent candle (candles.at(-1)). Pass a trimmed
 * array to evaluate an earlier point in history for backtesting.
 */
export function analyzeStructuralSwingSetup(
  candles: Candle[],
  configOverrides: Partial<StructuralStrategyConfig> = {},
): StructuralSwingSignal {
  const cfg = { ...DEFAULT_STRUCTURAL_CONFIG, ...configOverrides };
  const empty: StructuralSwingSignal = {
    category: "NO_SETUP",
    isBuySignal: false,
    entryPrice: null,
    stopLoss: null,
    target: null,
    riskPerShare: null,
    slDistancePct: null,
    rewardRisk: null,
    score: 0,
    grade: "Ignore",
    reason: "Insufficient data",
    majorSwingLow: null,
    majorSwingHigh: null,
    bosLevel: null,
    newHigh: null,
    structuralSwingLow: null,
    trendline: null,
  };

  if (candles.length < cfg.swingLookback * 2 + 20) return empty;

  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const lastIndex = sorted.length - 1;
  const today = sorted[lastIndex];

  const rawPoints = detectSwingPoints(sorted, cfg.swingLookback);
  const pivots = buildPivotSequence(rawPoints);
  if (pivots.length < 3) return { ...empty, reason: "No confirmed swing structure yet" };

  // --- Step 1: existing uptrend (HH + HL) ---------------------------------
  // First find the most recent "peak" — the latest confirmed high that is
  // higher than every confirmed high after it (i.e. nothing since has
  // exceeded it; a run of lower highs trails it, or nothing trails it yet).
  // That peak is the candidate "new high" a BOS would produce. majorHigh is
  // whatever confirmed high immediately precedes that peak — the level a
  // Break of Structure must clear to justify calling the peak a fresh high
  // rather than just noise.
  const allHighs = pivots.filter((p) => p.type === "HIGH");
  const allLows = pivots.filter((p) => p.type === "LOW");

  let majorLow: SwingPoint | null = null;
  let majorHigh: SwingPoint | null = null;

  if (allHighs.length >= 2) {
    let peakIdx = allHighs.length - 1;
    for (let hi = allHighs.length - 2; hi >= 0; hi--) {
      if (allHighs[hi].price > allHighs[peakIdx].price) {
        peakIdx = hi;
      } else {
        break;
      }
    }

    if (peakIdx > 0) {
      const highCandidate = allHighs[peakIdx - 1];
      const priorHigh = peakIdx - 2 >= 0 ? allHighs[peakIdx - 2] : null;
      const isHigherHigh = !priorHigh || highCandidate.price > priorHigh.price;

      const highPivotIdx = pivots.indexOf(highCandidate);
      let lowCandidate: SwingPoint | null = null;
      for (let j = highPivotIdx - 1; j >= 0; j--) {
        if (pivots[j].type === "LOW") { lowCandidate = pivots[j]; break; }
      }

      if (isHigherHigh && lowCandidate) {
        const lowIdx = allLows.indexOf(lowCandidate);
        const priorLow = lowIdx > 0 ? allLows[lowIdx - 1] : null;
        const isHigherLow = !priorLow || lowCandidate.price > priorLow.price;
        if (isHigherLow) {
          majorHigh = highCandidate;
          majorLow = lowCandidate;
        }
      }
    }
  }

  if (!majorLow || !majorHigh) {
    return { ...empty, reason: "No established Higher-High / Higher-Low structure found" };
  }

  // --- Step 2: Break of Structure past majorHigh --------------------------
  // A BOS is a close, after majorHigh, that exceeds majorHigh by the buffer.
  // It can be confirmed by either a later pivot high or (for the live/most
  // recent case) simply a close on any candle after majorHigh.
  const bosThreshold = majorHigh.price * (1 + cfg.bosBufferPct / 100);
  let bosIndex = -1;
  for (let i = majorHigh.index + 1; i <= lastIndex; i++) {
    if (sorted[i].c > bosThreshold) {
      bosIndex = i;
      break;
    }
  }
  if (bosIndex === -1) {
    return {
      ...empty,
      category: "SETUP_FORMING",
      reason: "Uptrend established but no Break of Structure above the prior high yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
    };
  }

  // --- Step 3: New High — running max since BOS until a real pullback ----
  let newHighIdx = bosIndex;
  let newHighPrice = sorted[bosIndex].h;
  for (let i = bosIndex + 1; i <= lastIndex; i++) {
    if (sorted[i].h > newHighPrice) {
      newHighPrice = sorted[i].h;
      newHighIdx = i;
    }
  }

  if (newHighIdx === lastIndex) {
    // Still making new highs today — no correction has started yet.
    return {
      ...empty,
      category: "CORRECTION",
      reason: "Break of Structure confirmed; still extending, no corrective pullback yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
    };
  }

  // --- Step 4/5: corrective internal lower highs since the new high ------
  const correctionCandles = sorted.slice(newHighIdx);
  const correctionLow = Math.min(...correctionCandles.map((c) => c.l));
  if (correctionLow <= majorLow.price) {
    return {
      ...empty,
      category: "INVALIDATED",
      reason: "Correction broke below the swing low that established the uptrend",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
    };
  }

  const correctionPoints = detectSwingPoints(correctionCandles, cfg.swingLookback)
    .map((p) => ({ ...p, index: p.index + newHighIdx })) // re-offset to full series
    .filter((p) => p.type === "HIGH");

  const tol = cfg.lowerHighTolerancePct / 100;
  const lowerHighs: SwingPoint[] = [];
  for (const p of correctionPoints) {
    const prev = lowerHighs.at(-1);
    if (!prev || p.price <= prev.price * (1 + tol)) {
      lowerHighs.push(p);
    }
  }

  if (lowerHighs.length < 2) {
    return {
      ...empty,
      category: "CORRECTION",
      reason: "Correcting after Break of Structure; internal lower-high structure not formed yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
    };
  }

  // --- Step 6/7: trendline from internal lower highs ----------------------
  const recentVolumes = correctionCandles.map((c) => c.v);
  const volumeDecreasing =
    recentVolumes.length >= 4 &&
    recentVolumes.slice(-2).reduce((a, b) => a + b, 0) <
      recentVolumes.slice(0, 2).reduce((a, b) => a + b, 0);

  const trendline = fitTrendline(lowerHighs, volumeDecreasing);
  if (!trendline || lowerHighs.length < cfg.minTrendlineTouches) {
    return {
      ...empty,
      category: "SETUP_FORMING",
      reason: `Internal lower highs forming (${lowerHighs.length}/${cfg.minTrendlineTouches} needed for a trendline)`,
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
    };
  }

  // Structural swing low = lowest confirmed low since the new high (the
  // corrective low), not just the nearest candle's low.
  const correctionLowPoints = detectSwingPoints(correctionCandles, cfg.swingLookback)
    .map((p) => ({ ...p, index: p.index + newHighIdx }))
    .filter((p) => p.type === "LOW");
  const structuralSwingLow =
    correctionLowPoints.length > 0
      ? Math.min(...correctionLowPoints.map((p) => p.price))
      : correctionLow;

  // --- Step 8: breakout confirmation on today's candle --------------------
  const trendlinePriceToday = trendline.priceAt(lastIndex);
  const breakoutThreshold = trendlinePriceToday * (1 + cfg.breakoutBufferPct / 100);
  const isBullishCandle = today.c > today.o;
  const range = today.h - today.l;
  const bodyPct = range > 0 ? (Math.abs(today.c - today.o) / range) * 100 : 0;
  const closeLocation = range > 0 ? (today.c - today.l) / range : 0;
  const avgVol = averageVolume(sorted, lastIndex, cfg.volumeAvgPeriod);
  const volumeRatio = avgVol && avgVol > 0 ? today.v / avgVol : null;

  const closedAboveTrendline = today.c > breakoutThreshold;
  const closedAboveResistance = today.c > newHighPrice * (1 - cfg.trendlineTouchTolerancePct / 100) || closedAboveTrendline;
  const passesBody = bodyPct >= cfg.minCandleBodyPct;
  const passesCloseLocation = closeLocation >= cfg.minCloseLocationPct;
  const passesVolume = !cfg.requireVolumeConfirmation || (volumeRatio !== null && volumeRatio >= cfg.minVolumeRatio);

  const structuralSl = r2(structuralSwingLow * (1 - cfg.slBufferPct / 100));

  const scoreParts = {
    trend: 15, // reaching this point already requires a valid HH/HL structure
    bos: 10,
    trendlineTouches:
      lowerHighs.length >= 5 ? 20 : lowerHighs.length === 4 ? 15 : 10,
    candleBody: bodyPct >= cfg.strongCandleBodyPct ? 10 : passesBody ? 5 : 0,
    closeLocation: closeLocation >= cfg.strongCloseLocationPct ? 10 : passesCloseLocation ? 5 : 0,
    volume:
      volumeRatio !== null && volumeRatio >= cfg.strongVolumeRatio
        ? 15
        : volumeRatio !== null && volumeRatio >= cfg.minVolumeRatio
        ? 10
        : 0,
    resistance: closedAboveResistance ? 10 : 0,
  };
  const rawScore = Object.values(scoreParts).reduce((a, b) => a + b, 0);
  const score = Math.min(100, rawScore);
  const grade: StructuralSwingSignal["grade"] =
    score >= 80 ? "A+" : score >= 70 ? "A" : score >= 60 ? "B" : score >= 50 ? "Weak" : "Ignore";

  const baseFields = {
    majorSwingLow: r2(majorLow.price),
    majorSwingHigh: r2(majorHigh.price),
    bosLevel: r2(majorHigh.price),
    newHigh: r2(newHighPrice),
    structuralSwingLow: structuralSl,
    trendline,
    score,
    grade,
  };

  if (!isBullishCandle || !closedAboveTrendline || !passesBody || !passesCloseLocation || !passesVolume) {
    // Close but not confirmed — approaching the trendline
    const nearTrendline =
      Math.abs(today.c - trendlinePriceToday) / trendlinePriceToday <= cfg.trendlineTouchTolerancePct / 100 * 3;
    return {
      ...empty,
      ...baseFields,
      category: nearTrendline || today.h > trendlinePriceToday ? "BREAKOUT_WATCH" : "CORRECTION",
      reason: describeUnmetBreakoutConditions({
        closedAboveTrendline,
        passesBody,
        passesCloseLocation,
        passesVolume,
        isBullishCandle,
      }),
    };
  }

  // --- All conditions met: BUY signal -------------------------------------
  const entryPrice = cfg.entryMode === "BREAKOUT_CLOSE" ? today.c : today.c; // NEXT_OPEN resolved by caller using the following day's data
  const riskPerShare = r2(entryPrice - structuralSl);
  if (riskPerShare <= 0) {
    return { ...empty, ...baseFields, category: "INVALIDATED", reason: "Structural stop-loss is not below the entry price" };
  }
  const slDistancePct = r2((riskPerShare / entryPrice) * 100);
  if (slDistancePct > cfg.maxSlPct) {
    return {
      ...empty,
      ...baseFields,
      category: "BREAKOUT_WATCH",
      entryPrice: r2(entryPrice),
      stopLoss: structuralSl,
      riskPerShare,
      slDistancePct,
      reason: `Breakout confirmed but SL distance ${slDistancePct}% exceeds the configured max ${cfg.maxSlPct}%`,
    };
  }
  const target = r2(entryPrice + riskPerShare * cfg.riskRewardRatio);

  return {
    ...baseFields,
    category: "READY_TO_BUY",
    isBuySignal: true,
    entryPrice: r2(entryPrice),
    stopLoss: structuralSl,
    target,
    riskPerShare,
    slDistancePct,
    rewardRisk: cfg.riskRewardRatio,
    reason: `Confirmed breakout above ${lowerHighs.length}-touch descending trendline; body ${r2(bodyPct)}%, close-location ${r2(closeLocation * 100)}%${volumeRatio !== null ? `, volume ${r2(volumeRatio)}x avg` : ""}`,
  };
}

function describeUnmetBreakoutConditions(flags: {
  closedAboveTrendline: boolean;
  passesBody: boolean;
  passesCloseLocation: boolean;
  passesVolume: boolean;
  isBullishCandle: boolean;
}): string {
  const missing: string[] = [];
  if (!flags.isBullishCandle) missing.push("candle not bullish");
  if (!flags.closedAboveTrendline) missing.push("close below trendline + buffer");
  if (!flags.passesBody) missing.push("candle body too small");
  if (!flags.passesCloseLocation) missing.push("close not near candle high");
  if (!flags.passesVolume) missing.push("volume confirmation not met");
  return `Trendline formed, breakout not yet confirmed: ${missing.join(", ")}`;
}

/** Risk-based position sizing: floor(capital * riskPct / riskPerShare). */
export function calculateStructuralPositionSize(
  capital: number,
  riskPerTradePct: number,
  riskPerShare: number,
): number {
  if (riskPerShare <= 0 || capital <= 0) return 0;
  const maxRisk = capital * (riskPerTradePct / 100);
  return Math.floor(maxRisk / riskPerShare);
}
