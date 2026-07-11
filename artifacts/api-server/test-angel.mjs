import fs from 'fs';
import { SmartAPI } from 'smartapi-javascript';
import path from 'path';

async function main() {
  const sessionData = JSON.parse(fs.readFileSync(path.join(process.cwd(), '../../.angel_session.json'), 'utf8'));
  const smartApi = new SmartAPI({ api_key: process.env.ANGEL_API_KEY });
  smartApi.access_token = sessionData.jwtToken;
  smartApi.refresh_token = sessionData.refreshToken;

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 7 * 24 * 3600 * 1000);
  const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 09:15`;

  // Token for APOLLOTYRE-EQ is "163"
  const angelRes = await smartApi.getCandleData({
    exchange: "NSE",
    symboltoken: "163",
    interval: "FIVE_MINUTE",
    fromdate: formatDate(fromDate),
    todate: formatDate(toDate)
  });

  if (angelRes.status) {
    let pdh = 0;
    angelRes.data.forEach(r => {
      if (r[0].startsWith('2026-07-03')) {
        pdh = Math.max(pdh, r[2]);
      }
    });
    console.log('Angel One PDH on July 3:', pdh);
  } else {
    console.log('Error:', angelRes);
  }
}
main();
