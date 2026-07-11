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

const CANDLE_CLOSE_GRACE_MS = 2000; // 2 seconds grace period before finalizing

export class CandleEngine extends EventEmitter {
  private candles1m: Map<string, Candle[]> = new Map();
  private candles5m: Map<string, Candle[]> = new Map();
  
  private current1m: Map<string, Candle> = new Map();
  private current5m: Map<string, Candle> = new Map();
  
  private cumulativeVolume: Map<string, number> = new Map();
  
  public isContinuityValid: boolean = false;
  private intervalTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  public start() {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    
    // Check for candle closures every second
    this.intervalTimer = setInterval(() => {
      if (!this.isContinuityValid) return;
      const nowMs = Date.now();
      
      this.checkClosures(this.current1m, this.candles1m, 60, nowMs, "1m");
      this.checkClosures(this.current5m, this.candles5m, 300, nowMs, "5m");
    }, 1000);
  }

  public stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
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
    // Remove from forming
    currentMap.delete(securityId);
    
    // Add to closed
    let history = closedMap.get(securityId);
    if (!history) {
      history = [];
      closedMap.set(securityId, history);
    }
    history.push({ ...candle });
    
    if (label === "5m" && !candle.isPartial) {
      this.emit("onCandleClosed", securityId, candle, history);
    }
  }

  public backfill(securityId: string, history: Candle[]) {
    if (!history || history.length === 0) return;
    
    this.candles5m.set(securityId, [...history]);
    
    // We intentionally DO NOT populate current5m from backfill
    // The current bucket will be marked as partial if it hasn't started natively.
  }

  public processTick(tick: DhanMarketTick) {
    if (!this.isContinuityValid) return;

    // Market Session Boundary: 09:15 to 15:30 IST
    const d = new Date(tick.exchangeTimestampMs);
    const utcHours = d.getUTCHours();
    const utcMinutes = d.getUTCMinutes();
    const istMinutes = utcHours * 60 + utcMinutes + 330; 
    
    if (istMinutes < 555 || istMinutes >= 930) {
      return; 
    }

    const epochSecs = Math.floor(tick.exchangeTimestampMs / 1000);
    const slot1m = Math.floor(epochSecs / 60) * 60;
    const slot5m = Math.floor(epochSecs / 300) * 300;

    let tickVol = 0;
    if (tick.cumulativeVolume > 0) {
        const prevVol = this.cumulativeVolume.get(tick.securityId) || 0;
        if (istMinutes === 555 && prevVol > tick.cumulativeVolume) {
            tickVol = tick.cumulativeVolume;
        } else {
            tickVol = Math.max(0, tick.cumulativeVolume - prevVol);
        }
        this.cumulativeVolume.set(tick.securityId, tick.cumulativeVolume);
    }

    this.updateCandle(this.current1m, this.candles1m, tick.securityId, slot1m, tick.ltp, tickVol, 60);
    this.updateCandle(this.current5m, this.candles5m, tick.securityId, slot5m, tick.ltp, tickVol, 300);
  }

  private updateCandle(
    currentMap: Map<string, Candle>,
    closedMap: Map<string, Candle[]>,
    securityId: string,
    slot: number,
    ltp: number,
    vol: number,
    intervalSecs: number
  ) {
    let current = currentMap.get(securityId);

    if (!current) {
      // Determine if we are starting mid-candle
      const nowSecs = Math.floor(Date.now() / 1000);
      const secondsIntoBucket = nowSecs - slot;
      
      // If we started listening late into the bucket (e.g., > 10 seconds), mark as partial
      const isPartial = secondsIntoBucket > 10;
      
      current = { t: slot, o: ltp, h: ltp, l: ltp, c: ltp, v: vol, isPartial };
      currentMap.set(securityId, current);
    } else if (current.t !== slot) {
      // We received a tick for a new bucket, but the old one hasn't been finalized by the timer yet?
      // Or it's a late out-of-order tick?
      if (slot < current.t) {
        // Late tick for a past candle. Ignore it for real-time safety.
        return;
      }
      
      // If slot > current.t, the old candle should have been finalized. 
      // Force finalize it now.
      this.finalizeCandle(securityId, current, currentMap, closedMap, intervalSecs === 300 ? "5m" : "1m");
      
      current = { t: slot, o: ltp, h: ltp, l: ltp, c: ltp, v: vol, isPartial: false };
      currentMap.set(securityId, current);
    } else {
      current.h = Math.max(current.h, ltp);
      current.l = Math.min(current.l, ltp);
      current.c = ltp;
      current.v += vol;
    }
  }
}
