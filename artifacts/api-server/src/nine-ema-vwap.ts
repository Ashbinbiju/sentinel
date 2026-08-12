export interface Candle {
  t: number; // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface EmaVwapState {
  t: number;
  ema: number;
  vwap: number;
  atr: number;

  crossUp: boolean;
  crossDn: boolean;
  armLong: boolean;
  armShort: boolean;

  alignedLong: boolean;
  alignedShort: boolean;
  distOK: boolean;
  bodyUpOK: boolean;
  bodyDnOK: boolean;

  setupLong: boolean;
  setupShort: boolean;

  rawLongSl: number;
  rawShortSl: number;
}

function getISTDateStr(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().slice(0, 10);
}

function getISTMinuteOfDay(epochSecs: number): number {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function istDateMinuteToEpochSecs(dateStr: string, minuteOfDay: number): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return 0;
  // IST_OFFSET_MS = 5.5 * 60 * 60 * 1000 = 19800000
  return Math.floor((Date.UTC(y, m - 1, d, 0, minuteOfDay) - 19800000) / 1000);
}

export function aggregateCandles(candles: Candle[], timeframeSecs: number): Candle[] {
  if (candles.length === 0) return [];
  
  const timeframeMins = timeframeSecs / 60;
  const buckets = new Map<string, Candle>();
  const ENTRY_SIGNAL_START_MIN_IST = 9 * 60 + 15;

  for (const cd of [...candles].sort((a, b) => a.t - b.t)) {
    const mins = getISTMinuteOfDay(cd.t);
    const dateStr = getISTDateStr(cd.t);
    if (mins < ENTRY_SIGNAL_START_MIN_IST) continue;
    const relMins = Math.max(0, mins - ENTRY_SIGNAL_START_MIN_IST);
    const bucketIndex = Math.floor(relMins / timeframeMins);
    const bucketStartMins = ENTRY_SIGNAL_START_MIN_IST + bucketIndex * timeframeMins;
    const key = `${dateStr}:${bucketIndex}`;
    const existing = buckets.get(key);

    if (!existing) {
      buckets.set(key, { 
        ...cd,
        t: istDateMinuteToEpochSecs(dateStr, bucketStartMins)
      });
    } else {
      existing.h = Math.max(existing.h, cd.h);
      existing.l = Math.min(existing.l, cd.l);
      existing.c = cd.c;
      existing.v = (existing.v || 0) + (cd.v || 0);
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

export function computeEmaVwap(candles: Candle[], emaLen: number = 9, atrLen: number = 14, armBars: number = 6, warmBars: number = 6, vwapDistAtr: number = 0.15, minBodyPct: number = 40.0, closeExtPct: number = 70.0): EmaVwapState[] {
  if (candles.length === 0) return [];

  const states: EmaVwapState[] = [];

  let ema = 0;
  let atr = 0;

  let cumVp = 0;
  let cumVol = 0;
  let vwap = 0;

  let barsIntoSess = 0;
  let lastDateStr = "";

  let sinceArmL = 999999;
  let sinceArmS = 999999;
  let longUsed = false;
  let shortUsed = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevC = i > 0 ? candles[i - 1] : c;
    const dateStr = getISTDateStr(c.t);

    const newDay = dateStr !== lastDateStr;
    if (newDay) {
      cumVp = 0;
      cumVol = 0;
      barsIntoSess = 0;
      lastDateStr = dateStr;
      
      sinceArmL = 999999;
      sinceArmS = 999999;
      longUsed = false;
      shortUsed = false;
    } else {
      barsIntoSess++;
    }

    // EMA
    if (i === 0) {
      ema = c.c;
    } else {
      const k = 2 / (emaLen + 1);
      ema = (c.c - ema) * k + ema;
    }
    const prevEma = i > 0 ? states[i - 1].ema : ema;

    // VWAP
    const hlc3 = (c.h + c.l + c.c) / 3;
    cumVp += hlc3 * (c.v || 0);
    cumVol += (c.v || 0);
    vwap = cumVol > 0 ? cumVp / cumVol : c.c;
    const prevVwap = i > 0 ? states[i - 1].vwap : vwap;

    // ATR (Wilder)
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prevC.c), Math.abs(c.l - prevC.c));
    if (i === 0) {
      atr = tr;
    } else {
      atr = (atr * (atrLen - 1) + tr) / atrLen;
    }

    const warmOK = barsIntoSess >= warmBars;

    // Cross (EMA x VWAP)
    const crossUp = ema > vwap && prevEma <= prevVwap;
    const crossDn = ema < vwap && prevEma >= prevVwap;

    // Arm ONLY on a genuine cross (no pre-arm gap-and-go)
    const armLong = warmOK && crossUp;
    const armShort = warmOK && crossDn;

    if (armLong) {
      sinceArmL = 0;
      longUsed = false;
    } else if (sinceArmL < 999999) {
      sinceArmL++;
    }

    if (armShort) {
      sinceArmS = 0;
      shortUsed = false;
    } else if (sinceArmS < 999999) {
      sinceArmS++;
    }

    // Confirm logic
    const slopeUp = ema > prevEma;
    const slopeDn = ema < prevEma;

    const stackUp = ema > vwap;
    const stackDn = ema < vwap;

    const alignedLong = c.c > ema && c.c > vwap && slopeUp && stackUp;
    const alignedShort = c.c < ema && c.c < vwap && slopeDn && stackDn;

    const distAtr = atr > 0 ? Math.abs(c.c - vwap) / atr : 0.0;
    const distOK = distAtr >= vwapDistAtr;

    const rng = c.h - c.l;
    const bodyPct = rng > 0 ? Math.abs(c.c - c.o) / rng * 100.0 : 0.0;
    const clPosUp = rng > 0 ? (c.c - c.l) / rng * 100.0 : 50.0;
    const clPosDn = rng > 0 ? (c.h - c.c) / rng * 100.0 : 50.0;

    const strongUp = clPosUp >= closeExtPct;
    const strongDn = clPosDn >= closeExtPct;

    const bodyUpOK = (c.c > c.o && bodyPct >= minBodyPct) || strongUp;
    const bodyDnOK = (c.c < c.o && bodyPct >= minBodyPct) || strongDn;

    // Trigger
    const setupLong = alignedLong && sinceArmL <= armBars && !longUsed && distOK && bodyUpOK;
    const setupShort = alignedShort && sinceArmS <= armBars && !shortUsed && distOK && bodyDnOK;

    if (setupLong) longUsed = true;
    if (setupShort) shortUsed = true;

    // Stop Loss calculation (never wrong side of entry)
    const tick = 0.05;
    const slBuf = 2 * tick;
    
    let rawLongSl = c.c - atr * 1.2;
    rawLongSl = Math.min(rawLongSl, c.c - tick) - slBuf;

    let rawShortSl = c.c + atr * 1.2;
    rawShortSl = Math.max(rawShortSl, c.c + tick) + slBuf;

    states.push({
      t: c.t,
      ema,
      vwap,
      atr,
      crossUp,
      crossDn,
      armLong,
      armShort,
      alignedLong,
      alignedShort,
      distOK,
      bodyUpOK,
      bodyDnOK,
      setupLong,
      setupShort,
      rawLongSl,
      rawShortSl
    });
  }

  return states;
}
