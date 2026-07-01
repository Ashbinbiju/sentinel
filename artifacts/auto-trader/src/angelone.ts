import { TOTP } from "totp-generator";
import * as fs from "fs";
import * as path from "path";
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");

const NSE_TICK_MULTIPLIER = 20; // 1 / 0.05 tick size

function roundToNseTick(value: number): number {
  return Math.round(value * NSE_TICK_MULTIPLIER) / NSE_TICK_MULTIPLIER;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SmartApiRateLimiter {
  private nextAvailableAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const waitMs = Math.max(0, this.nextAvailableAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.nextAvailableAt = Date.now() + this.minIntervalMs;
      return task();
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

const smartApiLimiters = {
  loginByPassword: new SmartApiRateLimiter(1100), // Angel limit: 1 request/sec
  getRms: new SmartApiRateLimiter(550), // Angel limit: 2 requests/sec
  getOrderBook: new SmartApiRateLimiter(1100), // Angel limit: 1 request/sec
  getPositionApi: new SmartApiRateLimiter(1100), // Angel limit: 1 request/sec
  orderApi: new SmartApiRateLimiter(150), // place/modify/cancel are cumulative: 9 requests/sec
};

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
  public smartApi: any;
  private ws: any = null;
  private jwtToken: string | null = null;
  private refreshToken: string | null = null;
  private feedToken: string | null = null;
  private wsCallbacks: ((data: any) => void)[] = [];
  
  constructor() {
    this.smartApi = new SmartAPI({
      api_key: process.env.ANGEL_API_KEY?.trim(),
    });
  }

  private getSessionFilePath(): string {
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
        return path.join(dir, ".angel_session.json");
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.resolve(process.cwd(), "../../.angel_session.json");
  }

  async login() {
    const clientCode = process.env.ANGEL_CLIENT_CODE?.trim();
    const password = process.env.ANGEL_PASSWORD?.trim();
    const totpSecret = process.env.ANGEL_TOTP_SECRET?.trim();

    if (!clientCode || !password || !totpSecret || !process.env.ANGEL_API_KEY) {
      throw new Error("Missing Angel One credentials in .env");
    }

    const sessionFilePath = this.getSessionFilePath();
    try {
      if (fs.existsSync(sessionFilePath)) {
        const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
        if (sessionData.jwtToken && sessionData.expiresAt > Date.now() + 5 * 60 * 1000) {
          this.jwtToken = sessionData.jwtToken;
          this.refreshToken = sessionData.refreshToken;
          this.feedToken = sessionData.feedToken;
          this.smartApi.access_token = sessionData.jwtToken;
          this.smartApi.refresh_token = sessionData.refreshToken;
          console.log("[BROKER] Loaded valid shared session from file.");
          return;
        }
      }
    } catch (err: any) {
      console.warn("[BROKER] Failed to read shared session file:", err.message);
    }

    // Generate TOTP
    const totpInfo = await TOTP.generate(totpSecret);
    const totp = typeof totpInfo === 'string' ? totpInfo : totpInfo.otp;

    console.log(`[BROKER] Attempting login for client ${clientCode}...`);
    
    try {
      const data: any = await smartApiLimiters.loginByPassword.schedule(() =>
        this.smartApi.generateSession(clientCode, password, totp)
      );
      
      if (data.status) {
        this.jwtToken = data.data.jwtToken;
        this.refreshToken = data.data.refreshToken;
        this.feedToken = data.data.feedToken;

        // Save session data to file
        const sessionData = {
          jwtToken: this.jwtToken,
          refreshToken: this.refreshToken,
          feedToken: this.feedToken,
          expiresAt: Date.now() + 7 * 60 * 60 * 1000 // 7 hours expiry
        };
        try {
          fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf8");
          console.log("[BROKER] Saved new shared session to file.");
        } catch (err: any) {
          console.warn("[BROKER] Failed to write shared session file:", err.message);
        }

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
      const profile: any = await smartApiLimiters.getRms.schedule(() =>
        this.smartApi.getRMS()
      );
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

  async connectWebSocket(): Promise<void> {
    try {
      // Refresh / load the shared session from file
      await this.login();
    } catch (err: any) {
      console.error("[BROKER] Failed to refresh login session during WebSocket connect:", err.message);
    }

    if (!this.jwtToken || !this.feedToken) {
      throw new Error("Cannot connect WebSocket: Not authenticated.");
    }

    // Clean up existing WebSocket if any to clear its internal intervals and close connection
    if (this.ws) {
      try {
        console.log("[BROKER] Closing old WebSocket connection and clearing intervals...");
        this.ws.close();
      } catch (err: any) {
        console.warn("[BROKER] Error closing old WebSocket instance:", err.message);
      }
    }
    
    this.ws = new WebSocketV2({
      jwttoken: this.jwtToken,
      clientcode: process.env.ANGEL_CLIENT_CODE?.trim()!,
      apikey: process.env.ANGEL_API_KEY?.trim()!,
      feedtype: this.feedToken,
    });

    this.ws.connect()
      .then(() => {
        console.log("[BROKER] WebSocket Connected.");
      })
      .catch((err: any) => {
        console.error("[BROKER] WebSocket Connection Error:", err);
      });

    this.ws.on("tick", (data: any) => {
      this.wsCallbacks.forEach(cb => cb(data));
    });

    this.ws.on("close", () => {
      console.warn("[BROKER] WebSocket Closed. Attempting reconnect in 5s...");
      setTimeout(() => this.connectWebSocket(), 5000);
    });
    
    this.ws.on("error", (err: any) => {
      console.error("[BROKER] WebSocket Error:", err);
    });
  }

  onTick(callback: (data: any) => void) {
    this.wsCallbacks.push(callback);
  }

  subscribeToTokens(tokens: string[]) {
    if (!this.ws) {
      console.warn("[BROKER] WebSocket not initialized yet.");
      return;
    }
    
    if (tokens.length === 0) return;

    const req = {
      correlationID: "sub-" + Date.now(),
      action: 1, // 1 for subscribe
      mode: 1, // 1 for LTP mode
      exchangeType: 1, // NSE
      tokens: tokens
    };
    
    this.ws.fetchData(req);
    console.log(`[BROKER] Subscribed to ${tokens.length} tokens for LTP streaming.`);
  }

  unsubscribeFromTokens(tokens: string[]) {
    if (!this.ws || tokens.length === 0) return;

    const req = {
      correlationID: "unsub-" + Date.now(),
      action: 0, // 0 for unsubscribe
      mode: 1, // 1 for LTP mode
      exchangeType: 1, // NSE
      tokens: tokens
    };
    
    this.ws.fetchData(req);
  }

  estimateMarginUsed(quantity: number, entryPrice: number, leverage: number): number {
    if (leverage <= 0) {
      throw new Error("Leverage must be greater than zero");
    }

    return (quantity * entryPrice) / leverage;
  }

  async getExecutedBuySymbolsFromOrderBook(): Promise<Set<string>> {
    try {
      const response: any = await smartApiLimiters.getOrderBook.schedule(() =>
        this.smartApi.getOrderBook()
      );
      if (!response || !response.status || !Array.isArray(response.data)) {
        if (response?.message === "SUCCESS" || response?.message === "No Data Found") {
          return new Set<string>(); // Empty order book
        }
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

        if (
          exchange === "NSE" &&
          (transactionType === "BUY" || transactionType === "SELL") &&
          tradeSymbol &&
          isBotProduct &&
          isExecuted
        ) {
          symbols.add(tradeSymbol.replace(/-EQ$/i, ""));
        }
      }

      return symbols;
    } catch (err) {
      console.error("[BROKER] Failed to fetch order book:", err);
      throw err;
    }
  }

  async placeMarketBuy(
    symbol: string,
    token: string,
    quantity: number,
    side: "BUY" | "SELL" = "BUY",
  ): Promise<string> {
    console.log(`[BROKER] Placing MARKET ${side} for ${symbol} | Qty: ${quantity}`);
    
    if (process.env.DRY_RUN === "true") {
      console.log(`[DRY RUN] Order intercepted. Would have ${side === "BUY" ? "bought" : "sold"} ${quantity} of ${symbol}.`);
      return "mock-order-id";
    }

    try {
      const orderData = {
        variety: "NORMAL",
        tradingsymbol: `${symbol}-EQ`,
        symboltoken: token,
        transactiontype: side,
        exchange: "NSE",
        ordertype: "MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        quantity: quantity.toString(),
      };
      
      const response: any = await smartApiLimiters.orderApi.schedule(() =>
        this.smartApi.placeOrder(orderData)
      );
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

  async placeRoboOrder(
    symbol: string,
    token: string,
    quantity: number,
    entryPrice: number,
    targetPrice: number,
    slPrice: number,
    side: "BUY" | "SELL" = "BUY",
  ): Promise<string> {
    console.log(`[BROKER] Placing ROBO (Bracket) ${side} for ${symbol} | Qty: ${quantity} | Limit: ${entryPrice} | Tgt: ${targetPrice} | SL: ${slPrice}`);
    
    if (process.env.DRY_RUN === "true") {
      console.log(`[DRY RUN] Order intercepted. Would have placed ${side} ROBO order for ${symbol}.`);
      return "mock-robo-id";
    }

    try {
      // Use a marketable limit around the entry signal to encourage immediate execution.
      // (Tick size is 0.05 for NSE Equity)
      const limitPriceNum = roundToNseTick(side === "BUY" ? entryPrice * 1.003 : entryPrice * 0.997);
      const limitPrice = limitPriceNum.toFixed(2);

      // Angel One expects absolute points from the actual order price.
      const squareoffPoints = roundToNseTick(Math.abs(targetPrice - limitPriceNum)).toFixed(2);
      const stoplossPoints = roundToNseTick(Math.abs(limitPriceNum - slPrice)).toFixed(2);

      const orderData = {
        variety: "ROBO",
        tradingsymbol: `${symbol}-EQ`,
        symboltoken: token,
        transactiontype: side,
        exchange: "NSE",
        ordertype: "LIMIT",
        producttype: "BO",
        duration: "DAY",
        price: limitPrice,
        squareoff: squareoffPoints,
        stoploss: stoplossPoints,
        quantity: quantity.toString(),
      };
      
      const response: any = await smartApiLimiters.orderApi.schedule(() =>
        this.smartApi.placeOrder(orderData)
      );
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

  async getRiskMetrics(): Promise<{ realizedPnl: number; closedLosingTrades: number }> {
    try {
      const response: any = await smartApiLimiters.getPositionApi.schedule(() =>
        this.smartApi.getPosition()
      );
      
      let realizedPnl = 0;
      let closedLosingTrades = 0;

      if (!response || !response.status || !response.data) {
        if (response?.message === "No Data Found" || response?.message === "SUCCESS") {
          return { realizedPnl: 0, closedLosingTrades: 0 };
        }
        throw new Error(response?.message || "Failed to fetch positions");
      }

      const positions = Array.isArray(response.data) ? response.data : [];

      for (const pos of positions) {
        const productType = pos.producttype?.toUpperCase();
        
        // We only care about closed intraday/BO positions for the kill switch
        // Angel One returns netqty as string
        const netQty = Number(pos.netqty ?? 0);
        
        if ((productType === "BO" || productType === "INTRADAY") && netQty === 0) {
          const buyAmount = Number(pos.buyamount ?? 0);
          const sellAmount = Number(pos.sellamount ?? 0);
          
          if (buyAmount > 0 && sellAmount > 0) {
            const tradePnl = sellAmount - buyAmount;
            realizedPnl += tradePnl;
            
            if (tradePnl < 0) {
              closedLosingTrades++;
            }
          }
        }
      }

      return { realizedPnl, closedLosingTrades };
    } catch (err: any) {
      console.error("[BROKER] Failed to fetch risk metrics:", err.message);
      throw err;
    }
  }

  async cancelRoboOrder(orderId: string): Promise<void> {
    try {
      const response: any = await smartApiLimiters.orderApi.schedule(() =>
        this.smartApi.cancelOrder({ variety: "ROBO", orderid: orderId })
      );
      if (response && response.status) {
        console.log(`[BROKER] Cancelled ROBO order ${orderId} successfully.`);
      } else {
        throw new Error(response?.message || "Failed to cancel order");
      }
    } catch (err: any) {
      console.error(`[BROKER] Exception cancelling order ${orderId}:`, err.message);
      throw err;
    }
  }

  async monitorOrderFill(
    orderId: string,
    symbol: string,
    timeoutMs: number,
    telegramCallback: (msg: string) => Promise<void>
  ): Promise<void> {
    await delay(timeoutMs);

    try {
      const response: any = await smartApiLimiters.getOrderBook.schedule(() =>
        this.smartApi.getOrderBook()
      );
      
      if (!response || !response.status || !Array.isArray(response.data)) return;

      const order = response.data.find((o: any) => o.orderid === orderId);
      if (!order) return;

      const status = (order.orderstatus || order.status || "").toUpperCase();
      const filledShares = Number(order.filledshares ?? 0);

      if ((status === "OPEN" || status === "PENDING") && filledShares === 0) {
        console.log(`[BOT] Order ${orderId} for ${symbol} unfilled after ${timeoutMs}ms. Cancelling...`);
        await this.cancelRoboOrder(orderId);
        
        await telegramCallback(
          `⚠️ SNIPER TIMEOUT\nSymbol: ${symbol}\nOrder ${orderId} was not filled within ${timeoutMs / 1000} seconds.\nOrder has been forcefully cancelled.`
        );
      }
    } catch (err: any) {
      console.error(`[BOT] Failed to monitor order ${orderId} for ${symbol}:`, err.message);
    }
  }
}
