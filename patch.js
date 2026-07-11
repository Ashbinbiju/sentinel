const fs = require('fs');

const path = 'artifacts/api-server/src/routes/stocks.ts';
let code = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const oldLogicStart = `    const sectorResponse = await fetch(
      "https://intradayscreener.com/api/indices/sectorData/1",
      { headers: HEADERS },
    );`;

const oldLogicEnd = `          // Get top 5 stocks by momentum in this sector (relative strength)
          const topStocks = allStocks
            .filter((s) => s.ltp > 100 && s.changePct < 15)
            .sort((a, b) => b.changePct - a.changePct)
            .slice(0, 5);

          for (const stock of topStocks) {`;

const newLogic = `    /* --- OLD INTRADAYSCREENER LOGIC (COMMENTED OUT) ---
${oldLogicStart.trim()}
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

    // Top 2 momentum sectors (relative strength, regardless of green/red)
    const topSectors = [...allSectors]
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 2);

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

${oldLogicEnd}
    */

    let volumeShockers = [];
    try {
      const seUrl = "https://api.stockedge.com/Api/trendingstocksapi/GetVolumeShockers?page=1&pageSize=10&relevantListings=10&lang=en";
      const seRes = await fetch(seUrl, { headers: HEADERS });
      if (seRes.ok) {
        const shockers = await seRes.json();
        volumeShockers = shockers.map((s) => ({
          symbol: s.Symbol,
          ltp: s.C,
          changePct: s.CZG
        })).filter(s => s.ltp > 100 && s.changePct < 15);
      } else {
        req.log.warn(\`StockEdge API responded with \${seRes.status}\`);
      }
    } catch (err) {
      req.log.error({ err }, "Failed to fetch StockEdge Volume Shockers");
    }

    await Promise.all(
      volumeShockers.map(async (stock) => {
        try {`;

const oldEndStart = `          }
        } catch (err) {
          req.log.warn({ err, sector: sector.name }, "Momentum scanner sector warning");
        }
      })
    );`;

const newEnd = `    /* --- OLD INTRADAYSCREENER LOGIC END (COMMENTED OUT) ---
${oldEndStart}
    */
        } catch (err) {
          req.log.warn({ err, symbol: stock.symbol }, "Momentum scanner stock warning");
        }
      })
    );`;

// Do replacement 1
const startIndex1 = code.indexOf(oldLogicStart);
const endIndex1 = code.indexOf(oldLogicEnd) + oldLogicEnd.length;
if (startIndex1 === -1 || code.indexOf(oldLogicEnd) === -1) {
  console.log("Failed to find replacement 1");
  process.exit(1);
}
code = code.substring(0, startIndex1) + newLogic + code.substring(endIndex1);

// Do replacement 2 (continues to returns)
// We need to only replace continues inside the volumeShockers.map block!
const mapStart = code.indexOf('volumeShockers.map(async (stock) => {');
const mapEnd = code.indexOf('    return res.json({');
if (mapStart === -1 || mapEnd === -1) {
  console.log("Failed to find map block");
  process.exit(1);
}
const preMap = code.substring(0, mapStart);
const inMap = code.substring(mapStart, mapEnd).replace(/continue;/g, 'return;');
const postMap = code.substring(mapEnd);
code = preMap + inMap + postMap;

// Do replacement 3
const startIndex3 = code.indexOf(oldEndStart);
if (startIndex3 === -1) {
  console.log("Failed to find replacement 3");
  process.exit(1);
}
code = code.substring(0, startIndex3) + newEnd + code.substring(startIndex3 + oldEndStart.length);

fs.writeFileSync(path, code);
console.log("Patched successfully!");
