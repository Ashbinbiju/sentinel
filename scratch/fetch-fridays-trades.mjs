import fs from 'fs';
import path from 'path';
import pg from 'pg';

// Parse .env file manually
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const val = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      if (key && val) {
        process.env[key.trim()] = val;
      }
    }
  }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log("Connecting to DB...");
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema='public'
    `);
    console.log("Tables in DB:", tables.rows.map(r => r.table_name));

    // Query trades table
    const res = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 100`);
    console.log(`Fetched ${res.rows.length} recent trades.`);
    
    // Output trades summary
    console.table(res.rows.map(t => ({
      id: t.id,
      symbol: t.symbol,
      direction: t.direction,
      status: t.status,
      entryPrice: t.entry_price,
      exitPrice: t.exit_price,
      stopLoss: t.stop_loss,
      target: t.target,
      pnl: t.pnl,
      reason: t.reason,
      createdAt: t.created_at,
      brokerOrderId: t.broker_order_id
    })));

    // Print raw JSON of Friday trades (July 24, 2026) or most recent 10 trades
    console.log("\n--- Full details of trades ---");
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error("Error querying DB:", err);
  } finally {
    await pool.end();
  }
}

run();
