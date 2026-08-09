import axios from 'axios';
function getEpochDateStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().slice(0, 10);
}

const getISTMinuteOfDay = (epochSecs: number) => {
    const d = new Date(epochSecs * 1000);
    d.setUTCHours(d.getUTCHours() + 5);
    d.setUTCMinutes(d.getUTCMinutes() + 30);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};

const aggregateCandles = (candles: any[], timeframeSecs: number): any[] => {
    const timeframeMins = timeframeSecs / 60;
    const buckets = new Map<string, any>();
    const ENTRY_SIGNAL_START_MIN_IST = 9 * 60 + 15;
  
    for (const cd of [...candles].sort((a, b) => a.t - b.t)) {
      const mins = getISTMinuteOfDay(cd.t);
      const relMins = Math.max(0, mins - ENTRY_SIGNAL_START_MIN_IST);
      const bucketIndex = Math.floor(relMins / timeframeMins);
      const bucketStartMins = ENTRY_SIGNAL_START_MIN_IST + bucketIndex * timeframeMins;
      const key = `${getEpochDateStr(cd.t)}:${bucketIndex}`;
      const existing = buckets.get(key);
  
      if (!existing) {
        // Rough t approximation for the bucket
        buckets.set(key, { ...cd, t: cd.t });
      } else {
        existing.h = Math.max(existing.h, cd.h);
        existing.l = Math.min(existing.l, cd.l);
        existing.c = cd.c;
        existing.v = (existing.v || 0) + (cd.v || 0);
      }
    }
  
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
};

async function main() {
    const histRes = await axios.get(`http://localhost:3000/api/stocks/CANBK/candles`);
    const historical = [...histRes.data.historicalCandles, ...histRes.data.sessionCandles];
    const agg15m = aggregateCandles(historical, 900);
    
    // Check values at Aug 7 10:15
    const c15_1015 = agg15m.find(c => getEpochDateStr(c.t) === "2026-08-07" && getISTMinuteOfDay(c.t) === 10 * 60); // bucket for 10:00 - 10:15 starts with 5m candle at 10:00 (which is mins=10:05, relMins=50, bucketIndex=3). Wait, let's just find by time.

    const aug7Candles = agg15m.filter(c => getEpochDateStr(c.t) === "2026-08-07");
    console.log("Aug 7 candles (first 5):", aug7Candles.slice(0,5).map(c => ({
        t: new Date(c.t*1000).toISOString(),
        c: c.c
    })));

    for (let i = 1; i < 5; i++) {
        const c15 = aug7Candles[i];
        const prevC15 = aug7Candles[i-1];
        
        // VWAP
        const sessionCandles15m = agg15m.filter(c => getEpochDateStr(c.t) === getEpochDateStr(c15.t) && c.t <= c15.t);
        let cumPV = 0, cumV = 0;
        for (const sc of sessionCandles15m) { cumPV += ((sc.h+sc.l+sc.c)/3)*(sc.v||0); cumV += (sc.v||0); }
        const vwap = cumPV/cumV;

        const prevSessionCandles15m = agg15m.filter(c => getEpochDateStr(c.t) === getEpochDateStr(prevC15.t) && c.t <= prevC15.t);
        let pcumPV = 0, pcumV = 0;
        for (const sc of prevSessionCandles15m) { pcumPV += ((sc.h+sc.l+sc.c)/3)*(sc.v||0); pcumV += (sc.v||0); }
        const prevVwap = pcumPV/pcumV;

        // EMA
        const historySoFar = agg15m.filter(c => c.t <= c15.t);
        let ema7 = 0;
        const closes = historySoFar.map(x => x.c);
        let ema = closes.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
        for (let j = 7; j < closes.length; j++) ema = (closes[j] - ema) * (2/8) + ema;
        ema7 = ema;

        const prevHistorySoFar = historySoFar.slice(0, historySoFar.length - 1);
        let prevEma7 = 0;
        const pCloses = prevHistorySoFar.map(x => x.c);
        let pEma = pCloses.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
        for (let j = 7; j < pCloses.length; j++) pEma = (pCloses[j] - pEma) * (2/8) + pEma;
        prevEma7 = pEma;

        console.log(`\nTime: ${new Date(c15.t*1000).toISOString()}`);
        console.log(`Prev EMA7 = ${prevEma7.toFixed(2)}, Prev VWAP = ${prevVwap.toFixed(2)}`);
        console.log(`EMA7 = ${ema7.toFixed(2)}, VWAP = ${vwap.toFixed(2)}`);
        
        if (prevEma7 <= prevVwap && ema7 > vwap) console.log("CROSSOVER BUY");
        if (prevEma7 >= prevVwap && ema7 < vwap) console.log("CROSSOVER SELL");
    }
}
main().catch(console.error);
