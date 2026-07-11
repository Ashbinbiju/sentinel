import fs from 'fs';
import { SmartAPI } from 'smartapi-javascript';
import path from 'path';

const symbol = "APOLLOTYRE";

async function main() {
  const sessionFilePath = path.join(process.cwd(), '.angel_session.json');
  const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));

  const smartApi = new SmartAPI({ api_key: process.env.ANGEL_API_KEY });
  smartApi.access_token = sessionData.jwtToken;
  smartApi.refresh_token = sessionData.refreshToken;

  const to = Math.floor(Date.now() / 1000);
  const from = to - 5 * 24 * 3600;

  console.log("Fetching from Moneycontrol...");
  const mcUrl = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${symbol}&resolution=5&from=${from}&to=${to}&countback=600&currencyCode=INR`;
  const mcRes = await fetch(mcUrl);
  const mcData = await mcRes.json();
  
  if (mcData.s === "ok") {
    // Find previous day candles
    const dates = mcData.t.map(t => new Date(t * 1000).toDateString());
    const uniqueDates = [...new Set(dates)];
    const today = uniqueDates[uniqueDates.length - 1];
    const prevDay = uniqueDates[uniqueDates.length - 2];
    
    let pdh = 0;
    mcData.t.forEach((t, i) => {
      if (new Date(t * 1000).toDateString() === prevDay) {
        pdh = Math.max(pdh, mcData.h[i]);
      }
    });
    console.log(`Moneycontrol PDH for ${prevDay}:`, pdh);
  }

  console.log("Fetching from Angel One...");
  // Need the token
  // Let's just fetch all NSE tokens
  const scripRes = await fetch("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json");
  const scripRows = await scripRes.json();
  const tokenObj = scripRows.find(r => r.exch_seg === "NSE" && r.symbol === symbol + "-EQ");
  
  if (tokenObj) {
    const token = tokenObj.token;
    
    // Angel One dates
    const dTo = new Date();
    const dFrom = new Date(dTo.getTime() - 5 * 24 * 3600 * 1000);
    const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 09:15`;
    
    const angelRes = await smartApi.getCandleData({
      exchange: "NSE",
      symboltoken: token,
      interval: "FIVE_MINUTE",
      fromdate: formatDate(dFrom),
      todate: formatDate(dTo)
    });
    
    if (angelRes.status) {
      const dates = angelRes.data.map(r => r[0].split('T')[0]);
      const uniqueDates = [...new Set(dates)];
      const prevDay = uniqueDates[uniqueDates.length - 2];
      
      let pdh = 0;
      angelRes.data.forEach(r => {
        if (r[0].startsWith(prevDay)) {
          pdh = Math.max(pdh, r[2]);
        }
      });
      console.log(`Angel One PDH for ${prevDay}:`, pdh);
    } else {
       console.log("Angel API Error:", angelRes);
    }
  }

}

main().catch(console.error);
