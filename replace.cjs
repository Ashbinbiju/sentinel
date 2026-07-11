const fs = require('fs');
let c = fs.readFileSync('artifacts/api-server/src/routes/stocks.ts', 'utf8');

c = c.replace(/(\s+)\}\)\(\);\s+\}\s+return swingTradesTableReady;/m, '$1})().catch((err: any) => {$1  swingTradesTableReady = null;$1  throw err;$1});\n  }\n\n  return swingTradesTableReady as Promise<void>;');

// if the previous ugly replace is there:
c = c.replace(/\}\)\.catch\(\(err\) => \{\s+swingTradesTableReady = null;\s+throw err;\}\);/m, '})().catch((err: any) => {\n      swingTradesTableReady = null;\n      throw err;\n    });');

c = c.replace(/return swingTradesTableReady;\n\}/m, 'return swingTradesTableReady as Promise<void>;\n}');

fs.writeFileSync('artifacts/api-server/src/routes/stocks.ts', c);
console.log("Done");
