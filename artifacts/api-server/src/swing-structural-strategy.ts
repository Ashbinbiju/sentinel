/**
 * Structural swing-trading strategy — exactly this pattern, nothing else:
 *
 *   Existing Uptrend -> High -> Break of High -> Further Upside -> New High
 *   -> Corrective Pullback -> Internal Swing Highs -> Descending Trendline
 *   (3+ touches) -> Bullish Candle Closes Above Trendline -> BUY
 *   -> SL below the corrective low -> 1:1 Risk/Reward Target
 *
 * Deliberately contains no indicators (RSI/MACD/EMA/VWAP/Bollinger), no
 * volume filter, no candle-body or close-location threshold, no breakout
 * buffer, no max-SL-distance cutoff, and no signal/trendline scoring system.
 * Only the structural conditions above gate a BUY signal. Daily candles only.
 *
 * All swing-point confirmation uses a strict N-bar fractal rule (a high/low
 * is only "confirmed" once N candles exist on both sides), so nothing here
 * ever uses information that wasn't yet available at the time — the same
 * rule applies whether this is called for a live scan or a backtest.
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
  /** Minimum internal swing-high touch points required to accept a descending trendline. */
  minTrendlineTouches: number;
  /** SL is placed this % below the corrective swing low, so it sits strictly below the low rather than exactly on it. */
  slBufferPct: number;
  /** Risk:reward ratio for the target (1.0 = 1:1). */
  riskRewardRatio: number;
  /** BREAKOUT_CLOSE = enter at the breakout candle's close (live-scan default).
   *  NEXT_OPEN = enter at the following candle's open (backtest-realistic). */
  entryMode: "BREAKOUT_CLOSE" | "NEXT_OPEN";
}

export const DEFAULT_STRUCTURAL_CONFIG: StructuralStrategyConfig = {
  swingLookback: 3,
  minTrendlineTouches: 3,
  slBufferPct: 0.25,
  riskRewardRatio: 1.0,
  entryMode: "BREAKOUT_CLOSE",
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
}

export type WatchlistCategory =
  | "READY_TO_BUY"
  | "BREAKOUT_WATCH"
  | "CORRECTION"
  | "SETUP_FORMING"
  | "INVALIDATED"
  | "NO_SETUP";

/** One row of the "Why not BUY?" diagnostic checklist. */
export interface DiagnosticCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface StructuralSwingSignal {
  category: WatchlistCategory;
  isBuySignal: boolean;

  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  riskPerShare: number | null;
  slDistancePct: number | null;
  rewardRisk: number | null;
  reason: string;

  majorSwingLow: number | null; // swing low that established the existing uptrend
  majorSwingHigh: number | null; // swing high that established the existing uptrend
  bosLevel: number | null; // the swing high that got broken
  newHigh: number | null; // high reached after BOS, start of the correction
  structuralSwingLow: number | null; // the corrective low the SL is based on
  trendline: TrendlineResult | null;

  /** Every gate evaluated so far, in pipeline order, with the actual
   * computed value behind each pass/fail — stops accumulating once a stage
   * blocks (later gates can't be meaningfully evaluated without it). */
  checks: DiagnosticCheck[];
  /** Exactly which check(s) are why this isn't READY_TO_BUY. Empty when isBuySignal is true. */
  rejectionReasons: string[];
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDateOf(epochSecs: number): string {
  return new Date(epochSecs * 1000).toISOString().slice(0, 10);
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
 * vs price). A negative slope means the line is descending.
 */
export function fitTrendline(touches: SwingPoint[]): TrendlineResult | null {
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

  return { touches, slope, intercept, priceAt };
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
  const checks: DiagnosticCheck[] = [];
  const check = (label: string, passed: boolean, detail: string) => {
    checks.push({ label, passed, detail });
  };

  const empty: StructuralSwingSignal = {
    category: "NO_SETUP",
    isBuySignal: false,
    entryPrice: null,
    stopLoss: null,
    target: null,
    riskPerShare: null,
    slDistancePct: null,
    rewardRisk: null,
    reason: "Insufficient data",
    majorSwingLow: null,
    majorSwingHigh: null,
    bosLevel: null,
    newHigh: null,
    structuralSwingLow: null,
    trendline: null,
    checks: [],
    rejectionReasons: ["Insufficient candle history"],
  };

  if (candles.length < cfg.swingLookback * 2 + 20) {
    check("Sufficient candle history", false, `${candles.length} candles, need at least ${cfg.swingLookback * 2 + 20}`);
    return { ...empty, checks };
  }

  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const lastIndex = sorted.length - 1;
  const today = sorted[lastIndex];

  const rawPoints = detectSwingPoints(sorted, cfg.swingLookback);
  const pivots = buildPivotSequence(rawPoints);
  if (pivots.length < 3) {
    check("Confirmed swing points (need 3+)", false, `${pivots.length} confirmed`);
    return { ...empty, reason: "No confirmed swing structure yet", checks, rejectionReasons: ["No confirmed swing structure yet"] };
  }
  check(
    "Confirmed swing points (need 3+)",
    true,
    `${pivots.length} confirmed (${pivots.filter((p) => p.type === "HIGH").length} highs, ${pivots.filter((p) => p.type === "LOW").length} lows)`,
  );

  // --- Step 1: existing uptrend (Low -> High -> Break of High) -----------
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
    check("Existing uptrend (Low -> High)", false, "no qualifying Low-then-High pair found among confirmed pivots");
    return {
      ...empty,
      reason: "No established Low -> High uptrend structure found",
      checks,
      rejectionReasons: ["No established Low -> High uptrend structure found"],
    };
  }
  check("Existing uptrend (Low -> High)", true, `low ${r2(majorLow.price)}, high ${r2(majorHigh.price)}`);

  // --- Step 2: Break of Structure past majorHigh --------------------------
  // A BOS is simply a close, after majorHigh, that breaks above it — "the
  // price breaks the previous High and moves upward again." No buffer.
  let bosIndex = -1;
  for (let i = majorHigh.index + 1; i <= lastIndex; i++) {
    if (sorted[i].c > majorHigh.price) {
      bosIndex = i;
      break;
    }
  }
  if (bosIndex === -1) {
    check(
      "Break of Structure (close > previous High)",
      false,
      `no close above ${r2(majorHigh.price)} yet; latest close ${r2(today.c)}`,
    );
    return {
      ...empty,
      category: "SETUP_FORMING",
      reason: "Uptrend established but no Break of Structure above the prior high yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      checks,
      rejectionReasons: ["No Break of Structure above the prior high yet"],
    };
  }
  check(
    "Break of Structure (close > previous High)",
    true,
    `closed at ${r2(sorted[bosIndex].c)} above ${r2(majorHigh.price)} on ${isoDateOf(sorted[bosIndex].t)}`,
  );

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
    check("Corrective pullback started", false, `still making new highs as of latest candle (high ${r2(newHighPrice)})`);
    return {
      ...empty,
      category: "CORRECTION",
      reason: "Break of Structure confirmed; still extending, no corrective pullback yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      checks,
      rejectionReasons: ["Still extending — no corrective pullback yet"],
    };
  }
  check("Corrective pullback started", true, `new high ${r2(newHighPrice)} on ${isoDateOf(sorted[newHighIdx].t)}, correcting since`);

  // --- Step 4: correction must not break the swing low that started the uptrend ---
  const correctionCandles = sorted.slice(newHighIdx);
  const correctionLow = Math.min(...correctionCandles.map((c) => c.l));
  if (correctionLow <= majorLow.price) {
    check("Correction stays above major swing low", false, `correction low ${r2(correctionLow)} broke below major low ${r2(majorLow.price)}`);
    return {
      ...empty,
      category: "INVALIDATED",
      reason: "Correction broke below the swing low that established the uptrend",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      checks,
      rejectionReasons: ["Correction broke below the swing low that established the uptrend"],
    };
  }
  check("Correction stays above major swing low", true, `correction low ${r2(correctionLow)} above major low ${r2(majorLow.price)}`);

  // --- Step 5/6: internal swing highs during the correction, and the ------
  // descending trendline fitted through them.
  const internalHighs = detectSwingPoints(correctionCandles, cfg.swingLookback)
    .map((p) => ({ ...p, index: p.index + newHighIdx })) // re-offset to full series
    .filter((p) => p.type === "HIGH");

  if (internalHighs.length < cfg.minTrendlineTouches) {
    check(`Internal swing highs during correction (need ${cfg.minTrendlineTouches}+)`, false, `${internalHighs.length} found`);
    return {
      ...empty,
      category: internalHighs.length >= 2 ? "SETUP_FORMING" : "CORRECTION",
      reason: `Correcting after Break of Structure; only ${internalHighs.length}/${cfg.minTrendlineTouches} internal swing highs so far`,
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      checks,
      rejectionReasons: [`Only ${internalHighs.length}/${cfg.minTrendlineTouches} internal swing highs found during the correction`],
    };
  }
  check(
    `Internal swing highs during correction (need ${cfg.minTrendlineTouches}+)`,
    true,
    `${internalHighs.length} found: ${internalHighs.map((p) => r2(p.price)).join(", ")}`,
  );

  const trendline = fitTrendline(internalHighs);
  if (!trendline || trendline.slope >= 0) {
    check("Descending trendline (negative slope)", false, trendline ? `slope ${r2(trendline.slope)}/bar (not descending)` : "could not fit a line");
    return {
      ...empty,
      category: "SETUP_FORMING",
      reason: "Internal swing highs found, but they don't form a descending trendline yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      checks,
      rejectionReasons: ["Internal swing highs don't form a descending trendline"],
    };
  }
  check("Descending trendline (negative slope)", true, `${internalHighs.length} touches, slope ${r2(trendline.slope)}/bar`);

  // Structural swing low = lowest confirmed low since the new high (the
  // corrective low), not just the nearest candle's low.
  const correctionLowPoints = detectSwingPoints(correctionCandles, cfg.swingLookback)
    .map((p) => ({ ...p, index: p.index + newHighIdx }))
    .filter((p) => p.type === "LOW");
  const structuralSwingLow =
    correctionLowPoints.length > 0
      ? Math.min(...correctionLowPoints.map((p) => p.price))
      : correctionLow;

  // --- Step 7/8: breakout confirmation on today's candle -------------------
  // "The desired breakout is when the stock breaks the corrective trendline
  // and a strong green/bullish candle comes above the trendline and closes
  // above it." Just these two conditions — no buffer, no body/close-location
  // threshold, no volume filter.
  const trendlinePriceToday = trendline.priceAt(lastIndex);
  const isBullishCandle = today.c > today.o;
  const closedAboveTrendline = today.c > trendlinePriceToday;
  const priceReachedTrendline = today.h >= trendlinePriceToday;

  check("Price reached trendline today", priceReachedTrendline, `today's high ${r2(today.h)} vs trendline ${r2(trendlinePriceToday)}`);
  check("Bullish candle (close > open)", isBullishCandle, `open ${r2(today.o)}, close ${r2(today.c)}`);
  check("Close above trendline", closedAboveTrendline, `close ${r2(today.c)} vs trendline ${r2(trendlinePriceToday)}`);

  const structuralSl = r2(structuralSwingLow * (1 - cfg.slBufferPct / 100));

  const baseFields = {
    majorSwingLow: r2(majorLow.price),
    majorSwingHigh: r2(majorHigh.price),
    bosLevel: r2(majorHigh.price),
    newHigh: r2(newHighPrice),
    structuralSwingLow: structuralSl,
    trendline,
  };

  if (!isBullishCandle || !closedAboveTrendline) {
    return {
      ...empty,
      ...baseFields,
      category: priceReachedTrendline ? "BREAKOUT_WATCH" : "CORRECTION",
      reason: describeUnmetBreakoutConditions({ closedAboveTrendline, isBullishCandle }),
      checks,
      rejectionReasons: breakoutRejectionReasons({ isBullishCandle, closedAboveTrendline }),
    };
  }

  // --- BUY: entry, SL below the corrective low, 1:1 target -----------------
  const entryPrice = today.c; // NEXT_OPEN resolved by caller using the following day's data
  const riskPerShare = r2(entryPrice - structuralSl);
  if (riskPerShare <= 0) {
    check("Risk per share positive (entry > SL)", false, `entry ${r2(entryPrice)}, SL ${structuralSl}`);
    return {
      ...empty,
      ...baseFields,
      category: "INVALIDATED",
      reason: "Structural stop-loss is not below the entry price",
      checks,
      rejectionReasons: ["Structural stop-loss is not below the entry price"],
    };
  }
  check("Risk per share positive (entry > SL)", true, `entry ${r2(entryPrice)}, SL ${structuralSl}, risk ${riskPerShare}/share`);

  const slDistancePct = r2((riskPerShare / entryPrice) * 100);
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
    reason: `Confirmed bullish breakout above a ${internalHighs.length}-touch descending trendline (close ${r2(entryPrice)} vs trendline ${r2(trendlinePriceToday)})`,
    checks,
    rejectionReasons: [],
  };
}

function describeUnmetBreakoutConditions(flags: {
  closedAboveTrendline: boolean;
  isBullishCandle: boolean;
}): string {
  const missing: string[] = [];
  if (!flags.isBullishCandle) missing.push("candle not bullish");
  if (!flags.closedAboveTrendline) missing.push("close not above trendline");
  return `Trendline formed, breakout not yet confirmed: ${missing.join(", ")}`;
}

/** Same gate flags as describeUnmetBreakoutConditions, as a list of individual reasons for the "Why not BUY?" diagnostic. */
function breakoutRejectionReasons(flags: {
  isBullishCandle: boolean;
  closedAboveTrendline: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!flags.isBullishCandle) reasons.push("Candle is not bullish (close <= open)");
  if (!flags.closedAboveTrendline) reasons.push("Close did not close above the descending trendline");
  return reasons;
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
