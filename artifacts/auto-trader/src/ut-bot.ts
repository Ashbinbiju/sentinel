// UT Bot + Safe Exit + TP Logic [Filtered]

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  isPartial?: boolean;
}

export interface UTBotState {
  xATRTrailingStop: number;
  pos: number;
  atr: number;
  buy_raw: boolean;
  sell_raw: boolean;
  buy: boolean;
  sell: boolean;
}

export function calculateATR(candles: Candle[], period: number): number[] {
  const atr = new Array(candles.length).fill(0);
  if (candles.length === 0) return atr;

  let sumTR = 0;
  for (let i = 1; i < candles.length; i++) {
    const prevC = candles[i - 1].c;
    const h = candles[i].h;
    const l = candles[i].l;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));

    if (i <= period) {
      sumTR += tr;
      if (i === period) atr[i] = sumTR / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

export function calculateEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  if (values.length === 0) return ema;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) {
    sum += values[i];
    ema[i] = sum / (i + 1);
  }
  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

export function computeUTBot(
  candles: Candle[], 
  a = 1, 
  c = 10, 
  minDistMult = 0.25, 
  flipLookback = 6, 
  flipMaxCount = 1
): UTBotState[] {
  const states: UTBotState[] = new Array(candles.length);
  const atrs = calculateATR(candles, c);

  let xATRTrailingStopPrev = 0;
  let posPrev = 0;

  for (let i = 0; i < candles.length; i++) {
    const src = candles[i].c;
    const srcPrev = i > 0 ? candles[i - 1].c : src;
    const atr = atrs[i];
    const nLoss = a * atr;

    let xATRTrailingStop = xATRTrailingStopPrev;

    if (src > xATRTrailingStopPrev && srcPrev > xATRTrailingStopPrev) {
      xATRTrailingStop = Math.max(xATRTrailingStopPrev, src - nLoss);
    } else if (src < xATRTrailingStopPrev && srcPrev < xATRTrailingStopPrev) {
      xATRTrailingStop = Math.min(xATRTrailingStopPrev, src + nLoss);
    } else if (src > xATRTrailingStopPrev) {
      xATRTrailingStop = src - nLoss;
    } else {
      xATRTrailingStop = src + nLoss;
    }

    let pos = posPrev;
    if (srcPrev < xATRTrailingStopPrev && src > xATRTrailingStopPrev) {
      pos = 1;
    } else if (srcPrev > xATRTrailingStopPrev && src < xATRTrailingStopPrev) {
      pos = -1;
    }

    const ema1 = src; // ema(src, 1) is just src
    const ema1Prev = srcPrev;

    const above = ema1 > xATRTrailingStop && ema1Prev <= xATRTrailingStopPrev;
    const below = xATRTrailingStop > ema1 && xATRTrailingStopPrev <= ema1Prev;

    const buy_raw = src > xATRTrailingStop && above;
    const sell_raw = src < xATRTrailingStop && below;

    states[i] = {
      xATRTrailingStop,
      pos,
      atr,
      buy_raw,
      sell_raw,
      buy: false,
      sell: false
    };

    xATRTrailingStopPrev = xATRTrailingStop;
    posPrev = pos;
  }

  // Apply filters
  for (let i = 0; i < candles.length; i++) {
    const state = states[i];
    const src = candles[i].c;
    
    // Filter 2 - Min Distance
    const distFromStop = Math.abs(src - state.xATRTrailingStop);
    const filterDist_buy = src > state.xATRTrailingStop && distFromStop > minDistMult * state.atr;
    const filterDist_sell = src < state.xATRTrailingStop && distFromStop > minDistMult * state.atr;

    // Filter 3 - Clustered Flip
    let oppCount_buy = 0;
    let oppCount_sell = 0;
    
    for (let j = Math.max(0, i - flipLookback); j < i; j++) {
      if (states[j].sell_raw) oppCount_buy++;
      if (states[j].buy_raw) oppCount_sell++;
    }

    const filterFlip_buy = oppCount_buy < flipMaxCount;
    const filterFlip_sell = oppCount_sell < flipMaxCount;

    state.buy = state.buy_raw && filterDist_buy && filterFlip_buy;
    state.sell = state.sell_raw && filterDist_sell && filterFlip_sell;
  }

  return states;
}
