import { EventEmitter } from "events";

export interface Candle {
  t: number; // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export class CandleEngine extends EventEmitter {
  private candles1m: Map<string, Candle[]> = new Map();
  private candles5m: Map<string, Candle[]> = new Map();
  private current1m: Map<string, Candle> = new Map();
  private current5m: Map<string, Candle> = new Map();
  
  private lastTickTime: Map<string, number> = new Map();
  private cumulativeVolume: Map<string, number> = new Map();
  
  public isContinuityValid: boolean = false;

  constructor() {
    super();
  }

  // Called on REST backfill
  public backfill(securityId: string, history: Candle[]) {
    if (!history || history.length === 0) return;
    
    // Assume history is 5m candles
    this.candles5m.set(securityId, history);
    
    // Initialize current5m based on the last history candle if it matches the current slot
    const last = history[history.length - 1];
    const currentSlot = Math.floor(Date.now() / 1000 / 300) * 300;
    if (last.t === currentSlot) {
      this.current5m.set(securityId, { ...last });
      history.pop(); // Remove it from closed candles
    }
  }

  public processTick(securityId: string, ltp: number, volume: number = 0, timestampMs: number = Date.now()) {
    if (!this.isContinuityValid) return;

    // Market Session Boundary: 09:15 to 15:30 IST
    // IST is UTC + 5:30
    const d = new Date(timestampMs);
    const utcHours = d.getUTCHours();
    const utcMinutes = d.getUTCMinutes();
    const istMinutes = utcHours * 60 + utcMinutes + 330; // 330 mins = 5h30m
    
    // 09:15 is 555 mins. 15:30 is 930 mins.
    if (istMinutes < 555 || istMinutes >= 930) {
      return; 
    }

    // Duplicate or out of order checks
    const lastT = this.lastTickTime.get(securityId) || 0;
    if (timestampMs <= lastT) {
      return; // Discard older or exact duplicate packet
    }
    this.lastTickTime.set(securityId, timestampMs);

    const epochSecs = Math.floor(timestampMs / 1000);
    const slot1m = Math.floor(epochSecs / 60) * 60;
    const slot5m = Math.floor(epochSecs / 300) * 300;

    // Process Volume Reset
    let tickVol = 0;
    if (volume > 0) {
        // If volume is cumulative
        const prevVol = this.cumulativeVolume.get(securityId) || 0;
        if (istMinutes === 555 && prevVol > volume) {
            // Daily reset detected
            tickVol = volume;
        } else {
            tickVol = Math.max(0, volume - prevVol);
        }
        this.cumulativeVolume.set(securityId, volume);
    }

    this.updateCandle(this.current1m, this.candles1m, securityId, slot1m, ltp, tickVol, "1m");
    this.updateCandle(this.current5m, this.candles5m, securityId, slot5m, ltp, tickVol, "5m");
  }

  private updateCandle(
    currentMap: Map<string, Candle>,
    closedMap: Map<string, Candle[]>,
    securityId: string,
    slot: number,
    ltp: number,
    vol: number,
    intervalLabel: string
  ) {
    let current = currentMap.get(securityId);

    if (!current) {
      current = { t: slot, o: ltp, h: ltp, l: ltp, c: ltp, v: vol };
      currentMap.set(securityId, current);
    } else if (current.t !== slot) {
      // Candle closed
      if (current.t < slot) {
        let history = closedMap.get(securityId);
        if (!history) {
          history = [];
          closedMap.set(securityId, history);
        }
        history.push({ ...current });
        
        // Emit event for trading logic
        if (intervalLabel === "5m") {
            this.emit("onCandleClosed", securityId, current, history);
        }
      }

      // Start new candle
      current = { t: slot, o: ltp, h: ltp, l: ltp, c: ltp, v: vol };
      currentMap.set(securityId, current);
    } else {
      // Update existing candle
      current.h = Math.max(current.h, ltp);
      current.l = Math.min(current.l, ltp);
      current.c = ltp;
      current.v += vol;
    }
  }
}
