import fs from 'fs';
import pg from 'pg';
import path from 'path';

// Parse .env manually
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      process.env[key] = value;
    }
  }
}

console.log('Database URL set:', !!process.env.DATABASE_URL);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
  try {
    const client = await pool.connect();
    
    // Check available dates in watchlist_snapshots
    const datesRes = await client.query('SELECT DISTINCT date FROM watchlist_snapshots ORDER BY date DESC LIMIT 10;');
    console.log('Available dates in watchlist_snapshots:', datesRes.rows.map(r => r.date));
    
    const today = datesRes.rows[0]?.date || '2026-07-31';
    console.log(`Fetching watchlist snapshots for date: ${today}`);

    const snapshotsRes = await client.query(
      'SELECT * FROM watchlist_snapshots WHERE date = $1 ORDER BY recorded_at ASC;',
      [today]
    );

    const tradesRes = await client.query(
      'SELECT * FROM trades WHERE date = $1 ORDER BY signal_time ASC;',
      [today]
    );

    const swingTradesRes = await client.query(
      'SELECT * FROM swing_trades WHERE date = $1 ORDER BY signal_time ASC;',
      [today]
    );

    // Group unique stocks from watchlist_snapshots
    const stockMap = new Map();
    for (const row of snapshotsRes.rows) {
      if (!stockMap.has(row.symbol)) {
        stockMap.set(row.symbol, {
          symbol: row.symbol,
          category: row.category,
          latestLtp: row.ltp,
          priceChangePct: row.price_change_pct,
          prevHigh: row.prev_high,
          prevLow: row.prev_low,
          firstSeenTime: row.time,
          snapshotCount: 1
        });
      } else {
        const item = stockMap.get(row.symbol);
        item.latestLtp = row.ltp;
        item.priceChangePct = row.price_change_pct;
        item.snapshotCount += 1;
      }
    }

    const uniqueWatchlistStocks = Array.from(stockMap.values());

    const result = {
      queryDate: today,
      generatedAt: new Date().toISOString(),
      summary: {
        totalWatchlistSnapshots: snapshotsRes.rows.length,
        uniqueWatchlistStocks: uniqueWatchlistStocks.length,
        totalTrades: tradesRes.rows.length,
        totalSwingTrades: swingTradesRes.rows.length
      },
      uniqueWatchlistStocks,
      todaysTrades: tradesRes.rows,
      todaysSwingTrades: swingTradesRes.rows,
      allSnapshotsRaw: snapshotsRes.rows
    };

    const outputPathJson = path.resolve(`artifacts/today_stocks_${today}.json`);
    const outputPathMd = path.resolve(`artifacts/today_stocks_${today}.md`);

    fs.writeFileSync(outputPathJson, JSON.stringify(result, null, 2));

    // Also write a human readable markdown file
    let md = `# Saved Stocks & Trades Report (${today})\n\n`;
    md += `**Generated At**: ${result.generatedAt}\n`;
    md += `**Unique Watchlist Stocks**: ${uniqueWatchlistStocks.length}\n`;
    md += `**Intraday Trades Triggers**: ${tradesRes.rows.length}\n`;
    md += `**Swing Trades**: ${swingTradesRes.rows.length}\n\n`;

    md += `---\n\n## 📈 Watchlist Stocks (${today})\n\n| # | Symbol | Category | Latest LTP | Change % | Prev High | Prev Low | First Seen Time |\n|---|--------|----------|------------|----------|-----------|----------|-----------------|\n`;
    uniqueWatchlistStocks.forEach((s, idx) => {
      md += `| ${idx + 1} | **${s.symbol}** | \`${s.category}\` | ${s.latestLtp ?? 'N/A'} | ${s.priceChangePct ? s.priceChangePct + '%' : 'N/A'} | ${s.prevHigh ?? 'N/A'} | ${s.prevLow ?? 'N/A'} | ${s.firstSeenTime} |\n`;
    });

    if (tradesRes.rows.length > 0) {
      md += `\n---\n\n## ⚡ Intraday Trades Executed/Triggered (${today})\n\n`;
      md += `| Symbol | Date | Entry Price | SL | Target | Status | P/L % |\n`;
      md += `|--------|------|-------------|----|--------|--------|-------|\n`;
      tradesRes.rows.forEach(t => {
        md += `| **${t.symbol}** | ${t.date} | ${t.entry_price} | ${t.sl} | ${t.target} | \`${t.status}\` | ${t.pl_pct ? t.pl_pct + '%' : 'N/A'} |\n`;
      });
    }

    if (swingTradesRes.rows.length > 0) {
      md += `\n---\n\n## 🎯 Swing Trades Recorded (${today})\n\n`;
      md += `| Symbol | Direction | Entry Type | Current Price | Entry Price | SL | Target | Score | Grade | Status |\n`;
      md += `|--------|-----------|------------|---------------|-------------|----|--------|-------|-------|--------|\n`;
      swingTradesRes.rows.forEach(st => {
        md += `| **${st.symbol}** | ${st.direction} | ${st.entry_type} | ${st.current_price} | ${st.entry_price} | ${st.sl} | ${st.target} | ${st.score} | ${st.grade} | \`${st.status}\` |\n`;
      });
    }

    fs.writeFileSync(outputPathMd, md);
    console.log(`Saved JSON output to: ${outputPathJson}`);
    console.log(`Saved Markdown report to: ${outputPathMd}`);

    client.release();
    await pool.end();
  } catch (err) {
    console.error('Error querying DB:', err);
    await pool.end();
  }
}

run();
