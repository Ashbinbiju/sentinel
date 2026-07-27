const { Client } = require('pg');

const connectionString = 'postgresql://postgres.dbtnxoqscvjajgdcadbn:EntharoEntho@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const res = await client.query(`SELECT * FROM watchlist_snapshots WHERE date = '2026-07-27' ORDER BY time DESC`);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error executing query', err.stack);
  } finally {
    await client.end();
  }
}

main();
