import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { SmartAPI } from 'smartapi-javascript';
import { TOTP } from 'totp-generator';

async function testUpstox15m() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN;
  if (!token) throw new Error("No token");

  const url = `https://api.upstox.com/v3/historical-candle/intraday/NSE_EQ%7CINE117A01022/minutes/15`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
  });
  
  const text = await res.text();
  console.log(`=== UPSTOX 15-MIN API ===`);
  console.log(`Status: ${res.status}`);
  console.log(`Response:`, text.substring(0, 500));
}

async function testAngelOne15m() {
  console.log(`\n=== ANGEL ONE 15-MIN API ===`);
  const smart_api = new SmartAPI({
    api_key: process.env.ANGEL_API_KEY,
  });

  const { otp } = TOTP.generate(process.env.ANGEL_TOTP_SECRET!);

  try {
    const session = await smart_api.generateSession(
      process.env.ANGEL_CLIENT_CODE,
      process.env.ANGEL_PASSWORD,
      otp
    );
    console.log("Angel One Session generated!");

    const payload = {
      exchange: "NSE",
      symboltoken: "3045", // SBI for example
      interval: "FIFTEEN_MINUTE", // 15-minute interval
      fromdate: "2026-08-01 09:15",
      todate: "2026-08-07 15:30",
    };

    const res = await smart_api.getCandleData(payload);
    console.log("Angel One Response Status:", res.status);
    console.log("Angel One First 5 Candles:", res.data ? res.data.slice(0, 5) : res);

  } catch (err) {
    console.error("Angel One Error:", err);
  }
}

async function run() {
  await testUpstox15m();
  await testAngelOne15m();
}

run().catch(console.error);
