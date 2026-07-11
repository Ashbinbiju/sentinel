const pg = require('pg');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const { rows } = await pool.query(`SELECT id, symbol, entry_price, sl, target, exit_price, status, created_at FROM trades ORDER BY created_at DESC LIMIT 10`);
  console.table(rows.map(r => {
    let pnl = "N/A";
    if (r.exit_price) {
      const isShort = r.sl > r.entry_price;
      const profitPoints = isShort ? r.entry_price - r.exit_price : r.exit_price - r.entry_price;
      const profitPct = (profitPoints / r.entry_price) * 100;
      pnl = `${profitPct.toFixed(2)}% (${profitPoints.toFixed(2)} pts)`;
    }
    return {
      Symbol: r.symbol,
      Date: r.created_at.toISOString().split('T')[0],
      Entry: r.entry_price,
      Exit: r.exit_price || "-",
      Status: r.status,
      PnL: pnl
    };
  }));
  process.exit(0);
}
main();
