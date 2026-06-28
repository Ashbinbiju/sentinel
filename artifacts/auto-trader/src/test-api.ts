import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../../.env") });
import axios from "axios";
import { TOTP } from "totp-generator";

async function testApi() {
  const apiKey = process.env.ANGEL_API_KEY?.trim();
  const clientCode = process.env.ANGEL_CLIENT_CODE?.trim();
  const password = process.env.ANGEL_PASSWORD?.trim();
  const totpSecret = process.env.ANGEL_TOTP_SECRET?.trim();

  console.log("Using API Key:", apiKey);
  console.log("Using Client Code:", clientCode);

  const totpInfo = await TOTP.generate(totpSecret!);
  const totp = typeof totpInfo === 'string' ? totpInfo : totpInfo.otp;

  // 1. Login
  const loginRes = await axios.post("https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword", {
    clientcode: clientCode,
    password: password,
    totp: totp
  }, {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "192.168.1.1",
      "X-ClientPublicIP": "106.193.147.98",
      "X-MACAddress": "00-11-22-33-44-55",
      "X-PrivateKey": apiKey
    }
  });

  console.log("Login Response:", loginRes.data.status, loginRes.data.message);

  if (!loginRes.data.status) {
    console.error(loginRes.data);
    return;
  }

  const jwt = loginRes.data.data.jwtToken;

  // 2. Order Book
  try {
    const orderRes = await axios.get("https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getOrderBook", {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "192.168.1.1",
        "X-ClientPublicIP": "106.193.147.98",
        "X-MACAddress": "00-11-22-33-44-55",
        "X-PrivateKey": apiKey,
        "Authorization": `Bearer ${jwt}`
      }
    });

    console.log("Order Book Response:", orderRes.data.status, orderRes.data.message);
    if (!orderRes.data.status) {
      console.log("Data:", orderRes.data);
    }
  } catch (err: any) {
    console.error("Order Book Error:", err.response?.data || err.message);
  }
}

testApi();
