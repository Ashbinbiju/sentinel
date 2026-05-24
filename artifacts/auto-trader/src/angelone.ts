import { TOTP } from "totp-generator";
const { SmartAPI } = require("smartapi-javascript");

const NSE_TICK_MULTIPLIER = 20; // 1 / 0.05 tick size

function roundToNseTick(value: number): number {
  return Math.round(value * NSE_TICK_MULTIPLIER) / NSE_TICK_MULTIPLIER;
}

interface AngelOrderBookOrder {
  exchange?: string;
  tradingsymbol?: string;
  transactiontype?: string;
  producttype?: string;
  status?: string;
  orderstatus?: string;
  filledshares?: string | number;
}

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

  estimateMarginUsed(quantity: number, entryPrice: number, leverage: number): number {
    if (leverage <= 0) {
      throw new Error("Leverage must be greater than zero");
    }

    return (quantity * entryPrice) / leverage;
  }

  async getExecutedBuySymbolsFromOrderBook(): Promise<Set<string>> {
    try {
      const response = await this.smartApi.getOrderBook();
      if (!response || !response.status || !Array.isArray(response.data)) {
        throw new Error(response?.message || "Failed to fetch order book");
      }

      const symbols = new Set<string>();

      for (const order of response.data as AngelOrderBookOrder[]) {
        const exchange = order.exchange?.toUpperCase();
        const transactionType = order.transactiontype?.toUpperCase();
        const productType = order.producttype?.toUpperCase();
        const tradeSymbol = order.tradingsymbol?.toUpperCase().trim();
        const status = (order.orderstatus || order.status || "").toUpperCase();
        const filledShares = Number(order.filledshares ?? 0);
        const isExecuted = status === "COMPLETE" || status === "COMPLETED" || filledShares > 0;
        const isBotProduct = productType === "BO" || productType === "INTRADAY";

        if (exchange === "NSE" && transactionType === "BUY" && tradeSymbol && isBotProduct && isExecuted) {
          symbols.add(tradeSymbol.replace(/-EQ$/i, ""));
        }
      }

      return symbols;
    } catch (err) {
      console.error("[BROKER] Failed to fetch order book:", err);
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

  async placeRoboOrder(symbol: string, token: string, quantity: number, entryPrice: number, targetPrice: number, slPrice: number): Promise<string> {
    console.log(`[BROKER] Placing ROBO (Bracket) BUY for ${symbol} | Qty: ${quantity} | Limit: ${entryPrice} | Tgt: ${targetPrice} | SL: ${slPrice}`);
    
    if (process.env.DRY_RUN === "true") {
      console.log(`[DRY RUN] Order intercepted. Would have placed ROBO order for ${symbol}.`);
      return "mock-robo-id";
    }

    try {
      // Use a limit price 0.3% higher than the entry signal to ensure immediate execution like a MARKET order
      // (Tick size is 0.05 for NSE Equity)
      const limitPriceNum = roundToNseTick(entryPrice * 1.003);
      const limitPrice = limitPriceNum.toFixed(2);

      // Angel One expects absolute points from the actual order price.
      const squareoffPoints = roundToNseTick(Math.abs(targetPrice - limitPriceNum)).toFixed(2);
      const stoplossPoints = roundToNseTick(Math.abs(limitPriceNum - slPrice)).toFixed(2);

      const orderData = {
        variety: "ROBO",
        tradingsymbol: `${symbol}-EQ`,
        symboltoken: token,
        transactiontype: "BUY",
        exchange: "NSE",
        ordertype: "LIMIT",
        producttype: "BO",
        duration: "DAY",
        price: limitPrice,
        squareoff: squareoffPoints,
        stoploss: stoplossPoints,
        quantity: quantity.toString(),
      };
      
      const response = await this.smartApi.placeOrder(orderData);
      if (response && response.status) {
        console.log(`[BROKER] ROBO Order placed successfully! ID: ${response.data.orderid}`);
        return response.data.orderid;
      } else {
        throw new Error(response.message || "Failed to place ROBO order");
      }
    } catch (err) {
      console.error("[BROKER] ROBO Order Exception:", err);
      throw err;
    }
  }
}
