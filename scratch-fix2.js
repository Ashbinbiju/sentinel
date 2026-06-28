const fs = require('fs');
let c = fs.readFileSync('artifacts/auto-trader/src/angelone.ts', 'utf8');

const target = `      if (!response || !response.status || !Array.isArray(response.data)) {
        throw new Error(response?.message || "Failed to fetch order book");
      }`;

const replacement = `      if (!response || !response.status || !Array.isArray(response.data)) {
        if (response?.message === "SUCCESS" || response?.message === "No Data Found") {
          return new Set<string>(); // Empty order book
        }
        throw new Error(response?.message || "Failed to fetch order book");
      }`;

// Normalize line endings for replacement
c = c.replace(target.replace(/\n/g, '\r\n'), replacement.replace(/\n/g, '\r\n'));
c = c.replace(target, replacement);

fs.writeFileSync('artifacts/auto-trader/src/angelone.ts', c);
console.log('Fixed');
