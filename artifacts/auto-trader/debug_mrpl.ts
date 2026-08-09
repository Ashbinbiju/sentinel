import * as fs from 'fs';

import { getEpochDateStr } from './src/utils';
import axios from 'axios';

// Wait getISTMinuteOfDay is in engine.ts?
const getISTMinuteOfDay = (epochSecs: number) => {
    const d = new Date(epochSecs * 1000);
    d.setUTCHours(d.getUTCHours() + 5);
    d.setUTCMinutes(d.getUTCMinutes() + 30);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};

function getEpochDateStr(epochSecs: number) {
  const d = new Date(epochSecs * 1000);
  d.setUTCHours(d.getUTCHours() + 5);
  d.setUTCMinutes(d.getUTCMinutes() + 30);
  return d.toISOString().slice(0, 10);
}

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
    const histRes = await axios.get(`http://localhost:3000/api/stocks/MRPL/candles`);
    const historical = [...histRes.data.historicalCandles, ...histRes.data.sessionCandles];
    console.log(`Fetched ${historical.length} historical 5m candles for MRPL.`);

    const agg15m = aggregateCandles(historical, 900);
    console.log(`Aggregated to ${agg15m.length} 15m candles.`);
    
    // Find August 7th (we know Aug 7th 09:30 is 1722998400 approx)
    const aug7Candles = agg15m.filter(c => getEpochDateStr(c.t) === "2026-08-07");
    const prevDayCandles = agg15m.filter(c => getEpochDateStr(c.t) === "2026-08-06");

    console.log("Last 2 candles of Aug 6:");
    console.log(prevDayCandles.slice(-2));

    console.log("First 2 candles of Aug 7:");
    console.log(aug7Candles.slice(0, 2));

    // Calculate EMA7 and VWAP at Aug 7 09:30
    const t = aug7Candles[0].t;
    const historySoFar = agg15m.filter(c => c.t <= t);

    // EMA7
    const period = 7;
    let ema7 = 0;
    const closes = historySoFar.map(x => x.c);
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * k + ema;
    }
    ema7 = ema;

    console.log(`EMA7 at ${aug7Candles[0].t} = ${ema7}`);

    // Prev EMA7
    const prevHistorySoFar = historySoFar.slice(0, historySoFar.length - 1);
    let prevEma7 = 0;
    const pCloses = prevHistorySoFar.map(x => x.c);
    let pEma = pCloses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < pCloses.length; i++) {
        pEma = (pCloses[i] - pEma) * k + pEma;
    }
    prevEma7 = pEma;

    console.log(`Prev EMA7 = ${prevEma7}`);

    // Prev VWAP
    const prevC15 = aug7Candles[0];
    const actualPrevC15 = prevDayCandles[prevDayCandles.length - 1]; // Aug 6 15:15
    const prevSessionCandles = agg15m.filter(c => getEpochDateStr(c.t) === getEpochDateStr(actualPrevC15.t) && c.t <= actualPrevC15.t);
    let pCumPV = 0;
    let pCumV = 0;
    for (const sc of prevSessionCandles) {
        const hlc3 = (sc.h + sc.l + sc.c) / 3;
        pCumPV += hlc3 * (sc.v || 0);
        pCumV += (sc.v || 0);
    }
    const prevVwap = pCumV > 0 ? pCumPV / pCumV : 0;
    console.log(`Prev VWAP (Aug 6 15:15) = ${prevVwap}`);

    // VWAP at 09:30 Aug 7
    const sessionCandles15m = agg15m.filter(c => getEpochDateStr(c.t) === getEpochDateStr(aug7Candles[0].t) && c.t <= aug7Candles[0].t);
    let cumPV = 0;
    let cumV = 0;
    for (const sc of sessionCandles15m) {
        const hlc3 = (sc.h + sc.l + sc.c) / 3;
        cumPV += hlc3 * (sc.v || 0);
        cumV += (sc.v || 0);
    }
    const vwap = cumV > 0 ? cumPV / cumV : 0;
    console.log(`VWAP (Aug 7 09:30) = ${vwap}`);

    // Let's also calculate the daily VWAP for Aug 6th manually
    const aug6Candles = historical.filter(c => getEpochDateStr(c.t) === '2026-08-06');
    let dailyPV = 0;
    let dailyV = 0;
    for (const c of aug6Candles) {
        const hlc3 = (c.h + c.l + c.c) / 3;
        dailyPV += hlc3 * (c.v || 0);
        dailyV += (c.v || 0);
    }
    console.log(`Daily VWAP for Aug 6 (5m precision) = ${dailyPV / dailyV}`);
}

main().catch(console.error);
