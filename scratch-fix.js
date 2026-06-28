const fs = require('fs');
let c = fs.readFileSync('artifacts/auto-trader/src/angelone.ts', 'utf8');

c = c.replace(
  `      if (!response || !response.status || !Array.isArray(response.data)) {
        throw new Error(response?.message || "Failed to fetch order book");
      }

      const symbols = new Set<string>();

      for (const order of response.data as AngelOrderBookOrder[]) {`,
  `      if (!response || !response.status) {
        throw new Error(response?.message || "Failed to fetch order book");
      }

      const symbols = new Set<string>();
      const orders = Array.isArray(response.data) ? response.data : [];

      for (const order of orders as AngelOrderBookOrder[]) {`
);

fs.writeFileSync('artifacts/auto-trader/src/angelone.ts', c);
console.log('Fixed');
