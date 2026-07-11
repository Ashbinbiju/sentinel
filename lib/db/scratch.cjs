require('dotenv').config({ path: '../../.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  try {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS swing_trades (
          id SERIAL PRIMARY KEY,
          symbol TEXT NOT NULL,
          date TEXT NOT NULL,
          signal_time TIMESTAMPTZ NOT NULL,
          sector TEXT,
          direction TEXT NOT NULL DEFAULT 'LONG',
          entry_type TEXT NOT NULL DEFAULT 'PULLBACK',
          current_price NUMERIC NOT NULL,
          entry_price NUMERIC NOT NULL,
          sl NUMERIC NOT NULL,
          target NUMERIC NOT NULL,
          score NUMERIC NOT NULL,
          grade TEXT NOT NULL,
          setup TEXT NOT NULL,
          reason TEXT,
          expected_hold_days NUMERIC NOT NULL DEFAULT 8,
          status TEXT NOT NULL DEFAULT 'WATCHLIST',
          entry_hit_date TEXT,
          exit_date TEXT,
          last_price NUMERIC,
          last_checked_at TIMESTAMPTZ
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS swing_symbol_date_unique
        ON swing_trades (symbol, date)
      `);
      console.log('✅ TABLE CREATE SUCCESSFUL');
  } catch(e) {
    console.error('❌ ERROR:', e.message);
  } finally {
    await pool.end();
  }
}
run();
