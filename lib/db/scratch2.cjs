require('dotenv').config({ path: '../../.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  try {
    const tradeRows = await pool.query(`
        SELECT id, symbol, date, signal_time, sector, direction, entry_type,
               current_price, entry_price, sl, target, score, grade, setup, reason,
               expected_hold_days, status, entry_hit_date, exit_date, last_price, last_checked_at,
               index_trend_index, index_trend_direction, index_trend_text,
               index_trend_score_adjustment,
               technical_stage, technical_score_adjustment, technical_indicator_text,
               technical_rs55, technical_volume_ratio, technical_above_ema200,
               technical_macd_trend, technical_adx_trend,
               insider_activity, insider_score_adjustment, insider_activity_text,
               insider_transaction_value, insider_transaction_date, insider_category
        FROM swing_trades
        WHERE date >= $1
        ORDER BY date DESC, signal_time ASC
      `,
      ['2025-01-01']
    );
    console.log('✅ SELECT QUERY SUCCESSFUL');
  } catch(e) {
    console.error('❌ SELECT QUERY FAILED:', e.message);
  } finally {
    await pool.end();
  }
}
run();
