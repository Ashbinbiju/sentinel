import { EventEmitter } from "events";
import { DhanMarketTick } from "./dhan";

export interface Candle {
  t: number; // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  isPartial?: boolean;
}

const CANDLE_CLOSE_GRACE_MS = 2000;

export class CandleEngine extends EventEmitter {
  private candles1m: Map<string, Candle[]> = new Map();
  private candles5m: Map<string, Candle[]> = new Map();
  
  private current1m: Map<string, Candle> = new Map();
  private current5m: Map<string, Candle> = new Map();
  
  private cumulativeVolume: Map<string, number> = new Map();
  private lastExchangeTimestamp: Map<string, number> = new Map();

  private lastFinalized1mSlot: Map<string, number> = new Map();
  private lastFinalized5mSlot: Map<string, number> = new Map();
  
  public isContinuityValid: boolean = false;
  private intervalTimer: NodeJS.Timeout | null = null;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private uniqueSymbols: Set<string> = new Set();
  private acceptedTicks = 0;
  private marketTimeRejectedTicks = 0;
  private sampleExchangeTimestampMs = 0;
  private abnormalTimestampSkews = 0;

  constructor() {
    super();
    (global as any).closed5m = 0;
    (global as any).partial5m = 0;
    (global as any).recoveredCandles = 0;
    (global as any).failedRecoveries = 0;
    (global as any).maxCandleQueueLagMs = 0;
    (global as any).maxTickQueueLagMs = 0;
  }

  public start() {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    
    this.intervalTimer = setInterval(() => {
      if (!this.isContinuityValid) return;
      const nowMs = Date.now();
      
      this.checkClosures(this.current1m, this.candles1m, 60, nowMs, "1m");
      this.checkClosures(this.current5m, this.candles5m, 300, nowMs, "5m");
    }, 1000);

    this.heartbeatTimer = setInterval(() => {
      if (!this.isContinuityValid) return;
      console.log(
        `[FEED] ticks=${this.tickCount} ` +
        `acceptedTicks=${this.acceptedTicks} ` +
        `marketTimeRejected=${this.marketTimeRejectedTicks} ` +
        `uniqueSymbols=${this.uniqueSymbols.size} ` +
        `current5m=${this.current5m.size} ` +
        `closed5m=${(global as any).closed5m} ` +
        `partial5m=${(global as any).partial5m} ` +
        `recovered=${(global as any).recoveredCandles} ` +
        `failed=${(global as any).failedRecoveries} ` +
        `candleQueueLagMs=${(global as any).maxCandleQueueLagMs} ` +
        `tickQueueLagMs=${(global as any).maxTickQueueLagMs} ` +
        `abnormalSkews=${this.abnormalTimestampSkews} ` +
        `exchangeTime=${this.sampleExchangeTimestampMs ? new Date(this.sampleExchangeTimestampMs).toISOString() : "NONE"} ` +
        `serverTime=${new Date().toISOString()}`
      );
      this.tickCount = 0;
      this.uniqueSymbols.clear();
      this.acceptedTicks = 0;
      this.marketTimeRejectedTicks = 0;
      this.sampleExchangeTimestampMs = 0;
      this.abnormalTimestampSkews = 0;
      (global as any).closed5m = 0;
      (global as any).partial5m = 0;
      (global as any).recoveredCandles = 0;
      (global as any).failedRecoveries = 0;
      (global as any).maxCandleQueueLagMs = 0;
      (global as any).maxTickQueueLagMs = 0;
    }, 60000);
  }

  public stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public prepareForReconnect(): void {
    this.isContinuityValid = false;

    this.current1m.clear();
    this.current5m.clear();
    this.cumulativeVolume.clear();
    this.lastExchangeTimestamp.clear();
    this.lastFinalized1mSlot.clear();
    this.lastFinalized5mSlot.clear();
  }

  public removeSymbols(securityIds: string[]): void {
    for (const securityId of securityIds) {
      this.current1m.delete(securityId);
      this.current5m.delete(securityId);
      this.candles1m.delete(securityId);
      this.candles5m.delete(securityId);
      this.cumulativeVolume.delete(securityId);
      this.lastExchangeTimestamp.delete(securityId);
      this.lastFinalized1mSlot.delete(securityId);
      this.lastFinalized5mSlot.delete(securityId);
    }
  }

  private checkClosures(
    currentMap: Map<string, Candle>,
    closedMap: Map<string, Candle[]>,
    intervalSecs: number,
    nowMs: number,
    label: "1m" | "5m"
  ) {
    for (const [secId, candle] of currentMap.entries()) {
      const candleCloseTimeMs = (candle.t + intervalSecs) * 1000;
      if (nowMs >= candleCloseTimeMs + CANDLE_CLOSE_GRACE_MS) {
        this.finalizeCandle(secId, candle, currentMap, closedMap, label);
      }
    }
  }

  private finalizeCandle(
    securityId: string,
    candle: Candle,
    currentMap: Map<string, Candle>,
    closedMap: Map<string, Candle[]>,
    label: "1m" | "5m"
  ) {
    const finalizedSlots =
      label === "5m"
        ? this.lastFinalized5mSlot
        : this.lastFinalized1mSlot;

    const previousFinalizedSlot = finalizedSlots.get(securityId);

    if (
      previousFinalizedSlot !== undefined &&
      candle.t <= previousFinalizedSlot
    ) {
      currentMap.delete(securityId);
      return;
    }

    finalizedSlots.set(securityId, candle.t);

    currentMap.delete(securityId);
    
    let history = closedMap.get(securityId);
    if (!history) {
      history = [];
      closedMap.set(securityId, history);
    }
    
    const existingIndex = history.findIndex(
      item => Number(item.t) === Number(candle.t)
    );

    if (existingIndex >= 0) {
      history[existingIndex] = { ...candle };
    } else {
      history.push({ ...candle });
    }
    
    if (label === "5m") {
      (global as any).closed5m++;

      console.log(
        `[CANDLE_ENGINE] FINALIZED ` +
        `secId=${securityId} ` +
        `slot=${new Date(candle.t * 1000).toISOString()} ` +
        `partial=${Boolean(candle.isPartial)}`
      );

      this.emit("onCandleClosed", securityId, candle, history);
    }
  }

  public backfill(securityId: string, history: Candle[]) {
    if (!history || history.length === 0) return;
    this.candles5m.set(securityId, [...history]);

    const latest = history[history.length - 1];

    if (latest) {
      this.lastFinalized5mSlot.set(
        securityId,
        Number(latest.t)
      );
    }
  }

  public processTick(tick: DhanMarketTick) {
    if (!this.isContinuityValid) return;

    // Out-of-order protection
    const previousTimestamp = this.lastExchangeTimestamp.get(tick.securityId);
    if (previousTimestamp !== undefined && tick.exchangeTimestampMs < previousTimestamp) {
      return;
    }
    this.lastExchangeTimestamp.set(tick.securityId, tick.exchangeTimestampMs);

    // Dhan sends local IST time epoch instead of true UTC epoch. 
    // If the timestamp is ~5.5 hours in the future, correct it.
    let realExchangeTimeMs = tick.exchangeTimestampMs;
    const apparentSkew = realExchangeTimeMs - Date.now();
    if (apparentSkew > 19000000 && apparentSkew < 20000000) {
      realExchangeTimeMs -= 19800000; // subtract 5 hours 30 minutes
    }

    this.tickCount++;
    this.uniqueSymbols.add(tick.securityId);
    this.sampleExchangeTimestampMs = realExchangeTimeMs;

    const exchangeDate = new Date(realExchangeTimeMs);
    const istMinutes =
      exchangeDate.getUTCHours() * 60 +
      exchangeDate.getUTCMinutes() +
      330;

    const timestampSkewMs = Math.abs(
      Date.now() - realExchangeTimeMs
    );

    if (timestampSkewMs > 5 * 60 * 1000) {
      this.abnormalTimestampSkews++;
    }

    if (istMinutes < 555 || istMinutes >= 930) {
      this.marketTimeRejectedTicks++;
      return; 
    }

    this.acceptedTicks++;

    const epochSecs = Math.floor(realExchangeTimeMs / 1000);
    const slot1m = Math.floor(epochSecs / 60) * 60;
    const slot5m = Math.floor(epochSecs / 300) * 300;

    const previousVolume = this.cumulativeVolume.get(tick.securityId);
    let tickVol = 0;

    if (previousVolume === undefined) {
      // First packet establishes the baseline.
      this.cumulativeVolume.set(tick.securityId, tick.cumulativeVolume);
    } else {
      tickVol = tick.cumulativeVolume >= previousVolume ? tick.cumulativeVolume - previousVolume : 0;
      this.cumulativeVolume.set(tick.securityId, tick.cumulativeVolume);
    }

    this.updateCandle(this.current1m, this.candles1m, tick.securityId, slot1m, epochSecs, tick.ltp, tickVol, 60);
    this.updateCandle(this.current5m, this.candles5m, tick.securityId, slot5m, epochSecs, tick.ltp, tickVol, 300);
  }

  private updateCandle(
    currentMap: Map<string, Candle>,
    closedMap: Map<string, Candle[]>,
    securityId: string,
    slot: number,
    epochSecs: number,
    ltp: number,
    vol: number,
    intervalSecs: number
  ) {
    const finalizedSlots =
      intervalSecs === 300
        ? this.lastFinalized5mSlot
        : this.lastFinalized1mSlot;

    const lastFinalizedSlot = finalizedSlots.get(securityId);

    if (
      lastFinalizedSlot !== undefined &&
      slot <= lastFinalizedSlot
    ) {
      return;
    }

    let current = currentMap.get(securityId);

    if (!current) {
      const secondsIntoBucket = epochSecs - slot;
      const isPartial = secondsIntoBucket > 10;
      
      current = { t: slot, o: ltp, h: ltp, l: ltp, c: ltp, v: vol, isPartial };
      currentMap.set(securityId, current);
    } else if (current.t !== slot) {
      if (slot < current.t) {
        return;
      }
      
      this.finalizeCandle(securityId, current, currentMap, closedMap, intervalSecs === 300 ? "5m" : "1m");
      
      const secondsIntoBucket = epochSecs - slot;
      const isPartial = secondsIntoBucket > 10;
      
      current = { t: slot, o: ltp, h: ltp, l: ltp, c: ltp, v: vol, isPartial };
      currentMap.set(securityId, current);
    } else {
      current.h = Math.max(current.h, ltp);
      current.l = Math.min(current.l, ltp);
      current.c = ltp;
      current.v += vol;
    }
  }
}
