const fs = require('fs');
const path = require('path');

const filePath = path.join('f:', 'sentinel', 'artifacts', 'api-server', 'src', 'routes', 'stocks.ts');
let content = fs.readFileSync(filePath, 'utf-8');

const newLogic = `router.get("/momentum-picks", async (req, res) => {
  try {
    const sectorResponse = await fetch(
      "https://intradayscreener.com/api/indices/sectorData/1",
      { headers: HEADERS },
    );
    if (!sectorResponse.ok) {
      return res.status(502).json({
        error: \`Upstream sector API responded with \${sectorResponse.status}\`,
      });
    }
    const sectorData = await sectorResponse.json() as any;

    const allSectors = sectorData.labels.map((name: string, i: number) => ({
      name,
      keyword: sectorData.keywords[i],
      changePct: sectorData.datasets[i] ?? 0,
    }));

    // Top 2 momentum sectors
    const topSectors = [...allSectors]
      .filter((sector) => sector.changePct > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 2);

    const topPickCandidates: any[] = [];
    const TOUCH_BUFFER_PCT = 0.0075;

    await Promise.all(
      topSectors.map(async (sector) => {
        try {
          const url = \`https://intradayscreener.com/api/indices/index-constituents/\${sector.keyword}/1?filter=cash\`;
          const r = await fetch(url, { headers: HEADERS });
          if (!r.ok) return;

          const constituentData = await r.json() as any;
          const allStocks = [
            ...(constituentData.indexConstituents ?? []),
            ...(constituentData.nonIndexConstituents ?? []),
          ];
          
          // Get top 5 stocks by momentum in this sector
          const topStocks = allStocks
            .filter((s) => s.ltp > 100 && s.changePct > 0 && s.changePct < 15)
            .sort((a, b) => b.changePct - a.changePct)
            .slice(0, 5);

          for (const stock of topStocks) {
            const candleData = await fetchCandles(stock.symbol);
            if (!candleData || candleData.historicalCandles.length === 0 || candleData.sessionCandles.length === 0) continue;

            const prevDayCandles = candleData.historicalCandles.filter(c => getCandleCloseDateIST(c) !== getTodayISTDateStr());
            if (prevDayCandles.length === 0) continue;
            
            const prevHigh = Math.max(...prevDayCandles.map((c) => c.h));
            const prevLow = Math.min(...prevDayCandles.map((c) => c.l));
            
            const confirmedSession = getConfirmedCandles(candleData.sessionCandles);
            if (confirmedSession.length === 0) continue;

            const c = confirmedSession[confirmedSession.length - 1]; // latest confirmed 5m candle
            const mins = getISTMinuteOfDay(c.t + CANDLE_INTERVAL_SECS);

            if (mins < 10 * 60 + 15 || mins > 14 * 60 + 30) continue; // Prime Time only

            let setup = "";
            let direction: "LONG" | "SHORT" | null = null;
            let sl = 0;
            let entryPrice = c.c;

            if (c.h >= prevHigh * (1 - TOUCH_BUFFER_PCT)) {
              if (c.c > prevHigh) {
                setup = "HIGH BREAKOUT"; direction = "LONG";
                sl = Math.min(c.l, prevHigh * 0.999);
              } else if (c.c < c.o) {
                setup = "HIGH REJECTION"; direction = "SHORT";
                sl = Math.max(c.h, prevHigh * 1.001);
              }
              if (direction) entryPrice = c.c;
            } else if (c.l <= prevLow * (1 + TOUCH_BUFFER_PCT)) {
              if (c.c < prevLow) {
                setup = "LOW BREAKDOWN"; direction = "SHORT";
                sl = Math.max(c.h, prevLow * 1.001);
              } else if (c.c > c.o) {
                setup = "LOW SUPPORT"; direction = "LONG";
                sl = Math.min(c.l, prevLow * 0.999);
              }
              if (direction) entryPrice = c.c;
            }

            if (direction) {
              const risk = Math.max(Math.abs(entryPrice - sl), entryPrice * 0.001);
              const target = direction === "LONG" ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
              
              topPickCandidates.push({
                symbol: stock.symbol,
                direction,
                entry: entryPrice,
                target2: target,
                sl,
                setup
              });
            }
          }
        } catch (err) {
          req.log.warn({ err, sector: sector.name }, "Momentum scanner sector warning");
        }
      })
    );

    return res.json({
      fetchedAt: new Date().toISOString(),
      topPicks: topPickCandidates,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch Momentum picks");
    return res.status(500).json({ error: "Failed to fetch Momentum picks" });
  }
});`;

const startIndex = content.indexOf('router.get("/momentum-picks"');
const endIndex = content.indexOf('// ── GET /stocks/trades/today');

if (startIndex !== -1 && endIndex !== -1) {
  content = content.slice(0, startIndex) + newLogic + '\n\n' + content.slice(endIndex);
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log("Successfully replaced /momentum-picks!");
} else {
  console.log("Could not find indices. start: " + startIndex + ", end: " + endIndex);
}
