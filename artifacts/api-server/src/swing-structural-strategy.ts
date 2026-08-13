/**
 * Structural swing-trading strategy — exactly this pattern, nothing else:
 *
 *   Established Uptrend -> High -> Break of that High -> New High
 *   -> Corrective Pullback -> Internal Swing Highs (belonging to THIS
 *   correction only) -> Descending Trendline (3+ touches) -> Bullish Candle
 *   Closes Above Trendline -> BUY -> SL below the corrective low
 *   -> 1:1 Risk/Reward Target
 *
 * The setup is proven CHRONOLOGICALLY, not assembled from conditions that
 * happen to be true independently somewhere in the chart:
 *
 *   1. Search candidate (Low, next-High) pivot pairs from the most recent
 *      backward. The first candidate whose High is actually broken by a
 *      later close (a real Break of Structure) is the impulse in play —
 *      older, unrelated Low/High pairs are never mixed in.
 *   2. Everything downstream — the New High, the correction, its internal
 *      swing highs, the trendline, the breakout, the corrective-low stop —
 *      is scoped to candles strictly AFTER that proven BOS, so a trendline
 *      can only be built from touches that belong to THIS correction.
 *
 * Deliberately contains no indicators (RSI/MACD/EMA/VWAP/Bollinger), no
 * volume filter, no candle-body or close-location threshold, no breakout
 * buffer, no max-SL-distance cutoff, and no signal/trendline scoring system.
 * Only the structural conditions above gate a BUY signal. Daily candles only.
 *
 * Non-repainting: swing points use a strict N-bar fractal rule (a high/low
 * is only "confirmed" once N candles exist on both sides), and every pivot
 * used here comes from re-running detection on the candle window ending at
 * "today" — so nothing ever uses information that wasn't yet available at
 * the time. The same engine is used for both the live scanner and the
 * backtester (swing-backtest.ts calls this exact function).
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
  /** Minimum number of distinct resistance-reaction touch zones required to accept a descending trendline. */
  minTrendlineTouches: number;
  /** Two internal-high pivots within this % of each other are the SAME resistance
   *  reaction (one touch zone), not two — a pivot only starts a new, distinct
   *  touch if it's meaningfully lower than the last accepted reaction. */
  touchZoneTolerancePct: number;
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
  touchZoneTolerancePct: 1,
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

/** A pivot with both its own bar date and the date it became fractal-confirmed. */
export interface PivotRef {
  price: number;
  date: string;
  confirmedDate: string;
}

/**
 * A single distinct resistance reaction on the descending trendline. Usually
 * one pivot; when two or more confirmed pivot highs test essentially the
 * same level (within touchZoneTolerancePct) they collapse into one zone here
 * rather than counting as separate touches — see buildTouchZones().
 */
export interface TouchZone {
  price: number; // the lowest (most conservative) pivot price in this zone
  date: string;
  confirmedDate: string;
  pivots: PivotRef[]; // every raw pivot merged into this reaction — length 1 if no merge occurred
}

/**
 * The exact chronological chain that produced (or almost produced) a signal —
 * every structural point named explicitly, with dates, so a BUY can always be
 * traced back to "what Low -> High -> BOS -> New High -> Correction -> 3-touch
 * descending trendline -> Breakout sequence caused this."
 */
export interface StructuralSetupTrace {
  mainLow: PivotRef | null;
  mainHigh: PivotRef | null;
  bosDate: string | null;
  newHigh: { price: number; date: string } | null;
  correctionStartDate: string | null;
  touchZones: TouchZone[];
  trendlineStartDate: string | null;
  trendlineEndDate: string | null;
  correctiveLow: { price: number; date: string } | null;
  breakoutDate: string | null;
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

  /** The full chronological chain behind this result — see StructuralSetupTrace. */
  trace: StructuralSetupTrace;

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

const EMPTY_TRACE: StructuralSetupTrace = {
  mainLow: null,
  mainHigh: null,
  bosDate: null,
  newHigh: null,
  correctionStartDate: null,
  touchZones: [],
  trendlineStartDate: null,
  trendlineEndDate: null,
  correctiveLow: null,
  breakoutDate: null,
};

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

function pivotConfirmedDate(sorted: Candle[], p: SwingPoint, n: number): string {
  const confirmedIdx = Math.min(p.index + n, sorted.length - 1);
  return isoDateOf(sorted[confirmedIdx].t);
}

function pivotRef(sorted: Candle[], p: SwingPoint, n: number): PivotRef {
  return { price: r2(p.price), date: isoDateOf(p.t), confirmedDate: pivotConfirmedDate(sorted, p, n) };
}

/**
 * Groups the correction's confirmed swing highs into distinct resistance
 * REACTIONS, not raw pivot points. A pivot only starts a new touch zone if
 * it is meaningfully lower (by more than tolerancePct) than the last
 * accepted zone; pivots within that band of the last zone are the same
 * interaction and get folded in (keeping the lower, more conservative
 * price as the zone's level). A pivot that comes in meaningfully HIGHER
 * than the last zone breaks the descending structure and isn't a valid
 * touch at all, so it's skipped rather than starting a new zone.
 *
 * Two highs with no genuine pullback between them never even reach this
 * function as separate pivots: `correctionPivots` is already the reduced
 * alternating H/L sequence (buildPivotSequence keeps only the more extreme
 * of back-to-back same-type points), so a "touch" here always has at least
 * some retracement before it. This pass additionally removes touches that
 * DID retrace but are still testing essentially the same price ceiling —
 * e.g. 510 then 508 a few candles later is one reaction, not two.
 */
function buildTouchZones(correctionPivots: SwingPoint[], tolerancePct: number): SwingPoint[][] {
  const highPivots = correctionPivots.filter((p) => p.type === "HIGH");
  const zones: SwingPoint[][] = [];

  for (const p of highPivots) {
    const lastZone = zones.at(-1);
    if (!lastZone) {
      zones.push([p]);
      continue;
    }
    const zoneLevel = Math.min(...lastZone.map((z) => z.price));
    const pctBelowZone = ((zoneLevel - p.price) / zoneLevel) * 100;

    if (pctBelowZone >= tolerancePct) {
      zones.push([p]); // meaningfully lower — a new, distinct reaction
    } else if (pctBelowZone > -tolerancePct) {
      lastZone.push(p); // within the same resistance band — same reaction
    }
    // else: meaningfully higher than the last zone — breaks the descending
    // structure, not counted as a touch.
  }

  return zones;
}

function zoneRepresentative(zone: SwingPoint[]): SwingPoint {
  return zone.reduce((min, p) => (p.price < min.price ? p : min));
}

function touchZoneRef(sorted: Candle[], zone: SwingPoint[], n: number): TouchZone {
  const rep = zoneRepresentative(zone);
  return {
    price: r2(rep.price),
    date: isoDateOf(rep.t),
    confirmedDate: pivotConfirmedDate(sorted, rep, n),
    pivots: [...zone].sort((a, b) => a.index - b.index).map((p) => pivotRef(sorted, p, n)),
  };
}

interface ImpulseCandidate {
  low: SwingPoint;
  high: SwingPoint;
  bosIndex: number;
}

/**
 * The core chronological-proof step. Walks candidate (Low, next-High) pairs
 * from the confirmed pivot sequence, most recent first, and returns the
 * first one where a later close actually breaks above the High — a real,
 * provable Break of Structure. This never mixes a High from one part of the
 * chart with a Low from an unrelated, older part: "the High" is always
 * literally the next confirmed pivot after "the Low" in the alternating
 * sequence, and BOS is only ever checked against candles after that High.
 */
function findMostRecentConfirmedImpulse(
  sorted: Candle[],
  pivots: SwingPoint[],
  lastIndex: number,
): ImpulseCandidate | null {
  for (let i = pivots.length - 2; i >= 0; i--) {
    if (pivots[i].type !== "LOW") continue;
    const low = pivots[i];
    const high = pivots[i + 1];
    if (!high || high.type !== "HIGH") continue;

    let bosIndex = -1;
    for (let j = high.index + 1; j <= lastIndex; j++) {
      if (sorted[j].c > high.price) {
        bosIndex = j;
        break;
      }
    }
    if (bosIndex === -1) continue; // this High was never broken — try an older Low

    return { low, high, bosIndex };
  }
  return null;
}

/** The most recent Low immediately followed by a High, regardless of BOS — used only to report "uptrend formed, no break yet" instead of a bare NO_SETUP. */
function mostRecentLowHighPair(pivots: SwingPoint[]): { low: SwingPoint; high: SwingPoint } | null {
  for (let i = pivots.length - 2; i >= 0; i--) {
    if (pivots[i].type === "LOW" && pivots[i + 1]?.type === "HIGH") {
      return { low: pivots[i], high: pivots[i + 1] };
    }
  }
  return null;
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
    trace: EMPTY_TRACE,
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

  // --- Step 1/2: prove the chronological Low -> High -> Break of Structure ---
  // chain. Never assembled from independently-true conditions — the High is
  // always the pivot immediately following the Low, and BOS is only checked
  // against candles strictly after it.
  const impulse = findMostRecentConfirmedImpulse(sorted, pivots, lastIndex);

  if (!impulse) {
    const fallback = mostRecentLowHighPair(pivots);
    if (!fallback) {
      check("Structure: Low -> High established", false, "no Low followed by a confirmed High found yet");
      return {
        ...empty,
        reason: "No established Low -> High uptrend structure found",
        checks,
        rejectionReasons: ["No established Low -> High uptrend structure found"],
      };
    }
    check(
      "Structure: Low -> High established",
      true,
      `low ${r2(fallback.low.price)} on ${isoDateOf(sorted[fallback.low.index].t)}, high ${r2(fallback.high.price)} on ${isoDateOf(sorted[fallback.high.index].t)}`,
    );
    check(
      "Structure: Break of Structure (close > High)",
      false,
      `no close above ${r2(fallback.high.price)} yet; latest close ${r2(today.c)}`,
    );
    return {
      ...empty,
      category: "SETUP_FORMING",
      reason: "Uptrend established but no Break of Structure above the prior high yet",
      majorSwingLow: r2(fallback.low.price),
      majorSwingHigh: r2(fallback.high.price),
      trace: {
        ...EMPTY_TRACE,
        mainLow: pivotRef(sorted, fallback.low, cfg.swingLookback),
        mainHigh: pivotRef(sorted, fallback.high, cfg.swingLookback),
      },
      checks,
      rejectionReasons: ["No Break of Structure above the prior high yet"],
    };
  }

  const { low: majorLow, high: majorHigh, bosIndex } = impulse;
  check(
    "Structure: Low -> High established",
    true,
    `low ${r2(majorLow.price)} on ${isoDateOf(sorted[majorLow.index].t)}, high ${r2(majorHigh.price)} on ${isoDateOf(sorted[majorHigh.index].t)}`,
  );
  check(
    "Structure: Break of Structure (close > High)",
    true,
    `closed at ${r2(sorted[bosIndex].c)} above ${r2(majorHigh.price)} on ${isoDateOf(sorted[bosIndex].t)}`,
  );

  const traceBase: StructuralSetupTrace = {
    ...EMPTY_TRACE,
    mainLow: pivotRef(sorted, majorLow, cfg.swingLookback),
    mainHigh: pivotRef(sorted, majorHigh, cfg.swingLookback),
    bosDate: isoDateOf(sorted[bosIndex].t),
  };

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
    check("Correction: pullback started", false, `still making new highs as of latest candle (high ${r2(newHighPrice)})`);
    return {
      ...empty,
      category: "CORRECTION",
      reason: "Break of Structure confirmed; still extending, no corrective pullback yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      trace: { ...traceBase, newHigh: { price: r2(newHighPrice), date: isoDateOf(sorted[newHighIdx].t) } },
      checks,
      rejectionReasons: ["Still extending — no corrective pullback yet"],
    };
  }
  check("Correction: pullback started", true, `new high ${r2(newHighPrice)} on ${isoDateOf(sorted[newHighIdx].t)}, correcting since`);

  const traceWithNewHigh: StructuralSetupTrace = {
    ...traceBase,
    newHigh: { price: r2(newHighPrice), date: isoDateOf(sorted[newHighIdx].t) },
    correctionStartDate: isoDateOf(sorted[newHighIdx].t),
  };

  // --- Step 4: correction must not break the swing low that started the uptrend ---
  // Only candles strictly after the New High belong to this correction — old
  // swing points from before it are never used from this point on.
  const correctionCandles = sorted.slice(newHighIdx);
  const correctionLow = Math.min(...correctionCandles.map((c) => c.l));
  if (correctionLow <= majorLow.price) {
    check("Correction: stays above major swing low", false, `correction low ${r2(correctionLow)} broke below major low ${r2(majorLow.price)}`);
    return {
      ...empty,
      category: "INVALIDATED",
      reason: "Correction broke below the swing low that established the uptrend",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      trace: traceWithNewHigh,
      checks,
      rejectionReasons: ["Correction broke below the swing low that established the uptrend"],
    };
  }
  check("Correction: stays above major swing low", true, `correction low ${r2(correctionLow)} above major low ${r2(majorLow.price)}`);

  // --- Step 5/6: internal swing highs belonging to THIS correction, grouped ---
  // into distinct resistance-reaction touch zones (clustered pivots testing
  // the same level are one touch, not several — see buildTouchZones).
  // detectSwingPoints + buildPivotSequence run fresh on the correctionCandles
  // slice only, so a touch can never come from before the New High.
  const correctionPivots = buildPivotSequence(
    detectSwingPoints(correctionCandles, cfg.swingLookback).map((p) => ({ ...p, index: p.index + newHighIdx })),
  );
  const touchZonePivots = buildTouchZones(correctionPivots, cfg.touchZoneTolerancePct);
  const touchZones = touchZonePivots.map((zone) => touchZoneRef(sorted, zone, cfg.swingLookback));

  for (let t = 0; t < cfg.minTrendlineTouches; t++) {
    const zone = touchZones[t];
    const mergeNote = zone && zone.pivots.length > 1
      ? ` (reaction zone: ${zone.pivots.map((p) => `${p.price}@${p.date}`).join(", ")})`
      : "";
    check(
      `Touch ${t + 1}`,
      Boolean(zone),
      zone ? `${zone.price} confirmed ${zone.confirmedDate}${mergeNote}` : "not formed yet",
    );
  }

  if (touchZones.length < cfg.minTrendlineTouches) {
    return {
      ...empty,
      category: touchZones.length >= 2 ? "SETUP_FORMING" : "CORRECTION",
      reason: `Correcting after Break of Structure; only ${touchZones.length}/${cfg.minTrendlineTouches} distinct resistance reactions so far`,
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      trace: { ...traceWithNewHigh, touchZones },
      checks,
      rejectionReasons: [`Only ${touchZones.length}/${cfg.minTrendlineTouches} distinct resistance reactions found during the correction (nearby pivots testing the same level count once)`],
    };
  }

  const traceWithTouches: StructuralSetupTrace = {
    ...traceWithNewHigh,
    touchZones,
    trendlineStartDate: touchZones[0].date,
    trendlineEndDate: touchZones.at(-1)!.date,
  };

  const trendlineTouchPivots = touchZonePivots.map(zoneRepresentative);
  const trendline = fitTrendline(trendlineTouchPivots);
  if (!trendline || trendline.slope >= 0) {
    check("Trendline: descending (negative slope)", false, trendline ? `slope ${r2(trendline.slope)}/bar (not descending)` : "could not fit a line");
    return {
      ...empty,
      category: "SETUP_FORMING",
      reason: "Resistance reactions found, but they don't form a descending trendline yet",
      majorSwingLow: r2(majorLow.price),
      majorSwingHigh: r2(majorHigh.price),
      bosLevel: r2(majorHigh.price),
      newHigh: r2(newHighPrice),
      trace: traceWithTouches,
      checks,
      rejectionReasons: ["Resistance reactions don't form a descending trendline"],
    };
  }
  check("Trendline: descending (negative slope)", true, `${touchZones.length} distinct reactions, slope ${r2(trendline.slope)}/bar`);

  // Structural swing low = lowest confirmed low since the new high (the
  // corrective low), scoped to this same correction only.
  const correctionLowPoints = correctionPivots.filter((p) => p.type === "LOW");
  let correctiveLowPoint: { price: number; t: number };
  if (correctionLowPoints.length > 0) {
    correctiveLowPoint = correctionLowPoints.reduce((min, p) => (p.price < min.price ? p : min));
  } else {
    const lowCandle = correctionCandles.reduce((min, c) => (c.l < min.l ? c : min));
    correctiveLowPoint = { price: lowCandle.l, t: lowCandle.t };
  }
  const structuralSwingLow = correctiveLowPoint.price;

  const traceWithTrendline: StructuralSetupTrace = {
    ...traceWithTouches,
    correctiveLow: { price: r2(structuralSwingLow), date: isoDateOf(correctiveLowPoint.t) },
  };

  // --- Step 7/8: breakout confirmation on today's candle -------------------
  // "The desired breakout is when the stock breaks the corrective trendline
  // and a strong green/bullish candle comes above the trendline and closes
  // above it." Just these two conditions — no buffer, no body/close-location
  // threshold, no volume filter. Because this is only reached once 3+
  // touches are already confirmed, the breakout can never be dated before
  // the 3rd touch.
  const trendlinePriceToday = trendline.priceAt(lastIndex);
  const isBullishCandle = today.c > today.o;
  const closedAboveTrendline = today.c > trendlinePriceToday;
  const priceReachedTrendline = today.h >= trendlinePriceToday;

  check("Breakout: price reached trendline today", priceReachedTrendline, `today's high ${r2(today.h)} vs trendline ${r2(trendlinePriceToday)}`);
  check("Breakout: bullish candle (close > open)", isBullishCandle, `open ${r2(today.o)}, close ${r2(today.c)}`);
  check("Breakout: close above trendline", closedAboveTrendline, `close ${r2(today.c)} vs trendline ${r2(trendlinePriceToday)}`);

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
      trace: traceWithTrendline,
      checks,
      rejectionReasons: breakoutRejectionReasons({ isBullishCandle, closedAboveTrendline }),
    };
  }

  const traceWithBreakout: StructuralSetupTrace = { ...traceWithTrendline, breakoutDate: isoDateOf(today.t) };

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
      trace: traceWithBreakout,
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
    reason: `Confirmed bullish breakout above a ${touchZones.length}-touch descending trendline (close ${r2(entryPrice)} vs trendline ${r2(trendlinePriceToday)})`,
    trace: traceWithBreakout,
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
