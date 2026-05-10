import { TOTP } from "totp-generator";
const { SmartAPI } = require("smartapi-javascript");

export class AngelOneBroker {
  private smartApi: any;
  private jwtToken: string | null = null;
  private refreshToken: string | null = null;
  private feedToken: string | null = null;
  
  constructor() {
    this.smartApi = new SmartAPI({
      api_key: process.env.ANGEL_API_KEY,
    });
  }

  async login() {
    const clientCode = process.env.ANGEL_CLIENT_CODE;
    const password = process.env.ANGEL_PASSWORD;
    const totpSecret = process.env.ANGEL_TOTP_SECRET;

    if (!clientCode || !password || !totpSecret || !process.env.ANGEL_API_KEY) {
      throw new Error("Missing Angel One credentials in .env");
    }

    // Generate TOTP
    const totpInfo = await TOTP.generate(totpSecret);
    const totp = typeof totpInfo === 'string' ? totpInfo : totpInfo.otp;

    console.log(`[BROKER] Attempting login for client ${clientCode}...`);
    
    try {
      const data = await this.smartApi.generateSession(clientCode, password, totp);
      
      if (data.status) {
        this.jwtToken = data.data.jwtToken;
        this.refreshToken = data.data.refreshToken;
        this.feedToken = data.data.feedToken;
        console.log("[BROKER] Login successful!");
      } else {
        throw new Error(data.message || "Login failed");
      }
    } catch (err: any) {
      console.error("[BROKER] Exception during login:", err);
      throw err;
    }
  }

  async getAccountBalance(): Promise<number> {
    try {
      const profile = await this.smartApi.getRMS();
      if (profile && profile.status && profile.data) {
        // net from RMS gives available margin
        const availableCash = parseFloat(profile.data.availablecash);
        return availableCash;
      }
      throw new Error("Failed to parse RMS data");
    } catch (err) {
      console.error("[BROKER] Failed to fetch account balance:", err);
      throw err;
    }
  }

  async placeMarketBuy(symbol: string, token: string, quantity: number): Promise<string> {
    console.log(`[BROKER] Placing MARKET BUY for ${symbol} | Qty: ${quantity}`);
    
    if (process.env.DRY_RUN === "true") {
      console.log(`[DRY RUN] Order intercepted. Would have bought ${quantity} of ${symbol}.`);
      return "mock-order-id";
    }

    try {
      const orderData = {
        variety: "NORMAL",
        tradingsymbol: `${symbol}-EQ`,
        symboltoken: token,
        transactiontype: "BUY",
        exchange: "NSE",
        ordertype: "MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        quantity: quantity.toString(),
      };
      
      const response = await this.smartApi.placeOrder(orderData);
      if (response && response.status) {
        console.log(`[BROKER] Order placed successfully! ID: ${response.data.orderid}`);
        return response.data.orderid;
      } else {
        throw new Error(response.message || "Failed to place order");
      }
    } catch (err) {
      console.error("[BROKER] Order Exception:", err);
      throw err;
    }
  }

  // Future expansion: we can add placeStopLoss and placeTarget methods here once the basic Market Buy is validated.
}
