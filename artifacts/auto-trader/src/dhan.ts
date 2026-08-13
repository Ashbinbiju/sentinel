import axios from "axios";
import { TOTP } from "totp-generator";
import * as path from "path";
import * as fs from "fs";

const DHAN_BASE_URL = "https://api.dhan.co/v2";
const DHAN_AUTH_URL = "https://auth.dhan.co/app/generateAccessToken";

export interface DhanPosition {
  dhanClientId: string;
  tradingSymbol: string;
  securityId: string;
  positionType: string;
  exchangeSegment: string;
  productType: string;
  buyAvg: number;
  buyQty: number;
  costPrice: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

export interface PlaceSuperOrderInput {
  securityId: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  trailingJump?: number;
  correlationId: string;
}

export interface DhanSuperOrderLeg {
  orderId: string;
  legName: "STOP_LOSS_LEG" | "TARGET_LEG" | "ENTRY_LEG";
  orderStatus: string;
  price: number;
  remainingQuantity: number;
  triggeredQuantity: number;
  trailingJump: number;
}

export interface DhanOrder {
  orderId: string;
  orderStatus: string;
  tradingSymbol: string;
  securityId: string;
  transactionType: string;
  exchangeSegment: string;
  productType: string;
  orderType: string;
  quantity: number;
  tradedQty: number;
  price: number;
  correlationId?: string;
  filledQty?: number;
  remainingQuantity?: number;
  averageTradedPrice?: number;
  legDetails?: DhanSuperOrderLeg[];
}

export interface DhanSuperOrder extends DhanOrder {
  legName?: "ENTRY_LEG" | "TARGET_LEG" | "STOP_LOSS_LEG";
  averageTradedPrice: number;
  filledQty: number;
  legDetails?: DhanSuperOrderLeg[];
}

export interface DhanMarketTick {
  securityId: string;
  exchangeSegment: number;
  ltp: number;
  lastTradedQuantity: number;
  exchangeTimestampMs: number;
  cumulativeVolume: number;
}

export class DhanBroker {
  private clientId: string;
  private accessToken: string;
  private pin: string | undefined;
  private totpSecret: string | undefined;

  constructor() {
    const clientId = process.env.DHAN_CLIENT_ID?.trim();
    let accessToken = process.env.DHAN_ACCESS_TOKEN?.trim() || "";
    
    // Attempt to load from shared token file if it exists
    const tokenFilePath = path.resolve(process.cwd(), "../../.dhan_token");
    if (fs.existsSync(tokenFilePath)) {
      try {
        accessToken = fs.readFileSync(tokenFilePath, "utf8").trim();
      } catch (e) {
        // ignore
      }
    }

    this.pin = process.env.DHAN_PIN?.trim();
    this.totpSecret = process.env.DHAN_TOTP_SECRET?.trim();
    
    if (!clientId) {
      throw new Error("Missing DHAN_CLIENT_ID in .env");
    }
    
    this.clientId = clientId;
    this.accessToken = accessToken;
  }
  
  private getHeaders() {
    return {
      "access-token": this.accessToken,
      "Content-Type": "application/json",
      "Accept": "application/json"
    };
  }

  async validateOrRenewToken(): Promise<void> {
    try {
      if (!this.accessToken) throw { response: { status: 401 } };
      await this.getAccountBalance();
      console.log("[BROKER] Dhan access token is valid.");
    } catch (err: any) {
      const authError = err?.response?.data;

      const authenticationFailed =
        err?.response?.status === 401 ||
        err?.response?.status === 403 ||
        authError?.errorCode === "DH-901" ||
        authError?.errorType === "Invalid_Authentication";

      if (authenticationFailed) {
        console.warn("[BROKER] Token invalid or missing. Attempting automated login via PIN + TOTP...");
        
        if (!this.pin || !this.totpSecret) {
          throw new Error("Dhan token expired and automated login failed because DHAN_PIN or DHAN_TOTP_SECRET is missing from .env");
        }

        try {
          const cleanSecret = this.totpSecret.replace(/\s+/g, "").toUpperCase();
          const totpInfo = await TOTP.generate(cleanSecret);
          const totpCode = typeof totpInfo === "string" ? totpInfo : totpInfo.otp;
          
          const response = await axios.post(`${DHAN_AUTH_URL}?dhanClientId=${this.clientId}&pin=${this.pin}&totp=${totpCode}`, {});
          
          const rawToken = response.data?.accessToken ?? response.data?.token ?? response.data?.data?.accessToken ?? response.data?.data?.token;
          const newToken = typeof rawToken === "string" ? rawToken.trim() : "";
          
          if (newToken.length > 0) {
             this.accessToken = newToken;
             console.log("[BROKER] Automated Dhan login successful. Token renewed.");
             // Write the renewed token to the shared file for api-server to use
             try {
               const tokenFilePath = path.resolve(process.cwd(), "../../.dhan_token");
               fs.writeFileSync(tokenFilePath, this.accessToken, "utf8");
             } catch (e) {
               console.warn("[BROKER] Failed to save .dhan_token", e);
             }
          } else {
             console.error("[BROKER] Dhan Auth Response:", response.data);
             throw new Error("No valid accessToken returned from Auth endpoint");
          }
        } catch (loginErr: any) {
          console.error("[BROKER] Automated Dhan login failed:", loginErr?.response?.data || loginErr.message);
          throw new Error("Automated Dhan login failed. Please verify your PIN and TOTP secret.");
        }
      } else {
        throw err;
      }
    }
  }

  async getAccountBalance(): Promise<number> {
    try {
      const response = await axios.get(`${DHAN_BASE_URL}/fundlimit`, {
        headers: this.getHeaders()
      });
      return Number(response.data.availabelBalance || response.data.availableBalance || 0);
    } catch (err: any) {
      console.error("[BROKER] Failed to fetch account balance:", err?.response?.data || err.message);
      throw err;
    }
  }

  async getPositions(): Promise<DhanPosition[]> {
    const response = await axios.get(`${DHAN_BASE_URL}/positions`, {
      headers: this.getHeaders(),
      timeout: 10000
    });
    if (!Array.isArray(response.data)) throw new Error("Invalid Dhan positions response");
    return response.data;
  }

  async getOrderBook(): Promise<DhanOrder[]> {
    const response = await axios.get(`${DHAN_BASE_URL}/orders`, {
      headers: this.getHeaders(),
      timeout: 10000
    });
    if (!Array.isArray(response.data)) throw new Error("Invalid Dhan order book response");
    return response.data;
  }
  
  async getSuperOrderList(): Promise<DhanOrder[]> {
    const response = await axios.get(`${DHAN_BASE_URL}/super/orders`, {
      headers: this.getHeaders(),
      timeout: 10000
    });
    if (!Array.isArray(response.data)) throw new Error("Invalid Dhan super order list response");
    return response.data;
  }

  async getExecutedBuySymbols(): Promise<Set<string>> {
    try {
      const orders = await this.getOrderBook();
      const symbols = new Set<string>();
      
      for (const order of orders) {
        const exchange = order.exchangeSegment?.toUpperCase();
        const transactionType = order.transactionType?.toUpperCase();
        const productType = order.productType?.toUpperCase();
        const securityId = order.securityId;
        const status = order.orderStatus?.toUpperCase();
        
        const isExecuted = status === "TRADED" || order.tradedQty > 0;
        const isBotProduct = productType === "INTRADAY" || productType === "BO";
        
        if (
          exchange === "NSE_EQ" &&
          (transactionType === "BUY" || transactionType === "SELL") &&
          securityId &&
          isBotProduct &&
          isExecuted
        ) {
          symbols.add(securityId);
        }
      }
      return symbols;
    } catch (err: any) {
      console.error("[BROKER] Failed to get executed buy symbols:", err.message);
      throw err;
    }
  }

  async getOrderByCorrelationId(correlationId: string): Promise<DhanOrder | null> {
    try {
      const response = await axios.get(
        `${DHAN_BASE_URL}/orders/external/${encodeURIComponent(correlationId)}`,
        {
          headers: this.getHeaders(),
          timeout: 10_000,
        }
      );
      return response.data;
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getTradesByOrderId(orderId: string): Promise<any[]> {
    try {
      const response = await axios.get(
        `${DHAN_BASE_URL}/trades/${encodeURIComponent(orderId)}`,
        {
          headers: this.getHeaders(),
          timeout: 10_000,
        }
      );
      const data = response.data;
      return Array.isArray(data) ? data : data ? [data] : [];
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return [];
      }
      throw error;
    }
  }

  async placeSuperOrder(input: PlaceSuperOrderInput): Promise<string> {
    console.log(`[BROKER] Placing SUPER ORDER ${input.side} for secId: ${input.securityId} | Qty: ${input.quantity}`);
    
    if (process.env.DRY_RUN === "true") {
      console.log(`[DRY RUN] Super Order intercepted. Would have placed ${input.side} for ${input.securityId}.`);
      return `mock-super-id-${Date.now()}`;
    }

    try {
      const payload = {
        dhanClientId: this.clientId,
        correlationId: input.correlationId,
        transactionType: input.side,
        exchangeSegment: "NSE_EQ",
        productType: "INTRADAY",
        orderType: "MARKET",
        securityId: input.securityId,
        quantity: Math.floor(input.quantity),
        price: 0,
        targetPrice: input.targetPrice,
        stopLossPrice: input.stopLossPrice,
        trailingJump: input.trailingJump ?? 0,
      };

      const response = await axios.post(`${DHAN_BASE_URL}/super/orders`, payload, {
        headers: this.getHeaders(),
        timeout: 10000
      });

      if (response.data && response.data.orderId) {
        console.log(`[BROKER] Super Order placed successfully! ID: ${response.data.orderId}`);
        return String(response.data.orderId);
      } else {
        throw new Error(JSON.stringify(response.data) || "Failed to place Super Order");
      }
    } catch (err: any) {
      console.error("[BROKER] Super Order Exception:", err?.response?.data || err.message);
      throw new Error(err?.response?.data?.errorMessage || err.message);
    }
  }

  async moveSuperOrderStopToBreakeven(
    orderId: string,
    entryPrice: number,
    trailingJump: number
  ): Promise<void> {
    if (process.env.DRY_RUN === "true") return;
    try {
      await axios.put(
        `${DHAN_BASE_URL}/super/orders/${orderId}`,
        {
          dhanClientId: this.clientId,
          orderId,
          legName: "STOP_LOSS_LEG",
          stopLossPrice: entryPrice,
          trailingJump,
        },
        {
          headers: this.getHeaders(),
          timeout: 10000
        }
      );
    } catch (err: any) {
      console.error(`[BROKER] Failed to modify Super Order SL leg for ${orderId}:`, err?.response?.data || err.message);
      throw err;
    }
  }

  async cancelSuperOrder(
    orderId: string,
    orderLeg: "ENTRY_LEG" | "TARGET_LEG" | "STOP_LOSS_LEG" = "ENTRY_LEG",
  ): Promise<void> {
    if (process.env.DRY_RUN === "true") {
      console.log(`[DRY RUN] Would cancel ${orderId}/${orderLeg}`);
      return;
    }

    try {
      await axios.delete(
        `${DHAN_BASE_URL}/super/orders/${orderId}/${orderLeg}`,
        { headers: this.getHeaders(), timeout: 10000 }
      );
      console.log(`[BROKER] Cancelled super order ${orderId} leg ${orderLeg} successfully.`);
    } catch (err: any) {
      console.error(`[BROKER] Exception cancelling super order ${orderId}:`, err?.response?.data || err.message);
      throw err;
    }
  }

  async waitForSuperOrderCancellation(orderId: string): Promise<void> {
    if (process.env.DRY_RUN === "true") return;

    for (let attempt = 1; attempt <= 10; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const orders = await this.getSuperOrderList();
      const order = orders.find(o => o.orderId === orderId);
      if (
        order &&
        ["CANCELLED", "CLOSED", "REJECTED"].includes(order.orderStatus)
      ) {
        return;
      }
    }
    throw new Error(`Super Order ${orderId} cancellation was not confirmed`);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (process.env.DRY_RUN === "true") return;
    try {
      await axios.delete(`${DHAN_BASE_URL}/orders/${orderId}`, {
        headers: this.getHeaders(), timeout: 10000
      });
    } catch (err: any) {
      console.error(`[BROKER] Exception cancelling order ${orderId}:`, err?.response?.data || err.message);
      throw err;
    }
  }

  async waitForOrderTerminal(orderId: string): Promise<void> {
    if (process.env.DRY_RUN === "true") return;
    for (let attempt = 1; attempt <= 10; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const orders = await this.getOrderBook();
      const order = orders.find(o => o.orderId === orderId);
      if (
        order &&
        ["CANCELLED", "CLOSED", "REJECTED", "TRADED", "EXPIRED"].includes(order.orderStatus)
      ) {
        return;
      }
    }
    throw new Error(`Order ${orderId} terminal state was not confirmed`);
  }

  async placeMarketOrder(
    securityId: string,
    quantity: number,
    side: "BUY" | "SELL" = "BUY",
    productType: "INTRADAY" | "CNC" | "BO" = "INTRADAY",
    correlationId?: string
  ): Promise<string> {
    console.log(`[BROKER] Placing MARKET exit ${side} for secId: ${securityId} | Qty: ${quantity}`);
    
    if (process.env.DRY_RUN === "true") return `mock-market-id-${Date.now()}`;

    try {
      const payload = {
        dhanClientId: this.clientId,
        correlationId: correlationId || `sentinel-exit-${Date.now()}`,
        transactionType: side,
        exchangeSegment: "NSE_EQ",
        productType: productType,
        orderType: "MARKET",
        validity: "DAY",
        securityId: securityId,
        quantity: Math.floor(quantity),
        price: 0,
        afterMarketOrder: false
      };
      
      const response = await axios.post(`${DHAN_BASE_URL}/orders`, payload, {
        headers: this.getHeaders(),
        timeout: 10000
      });
      
      if (response.data && response.data.orderId) {
        return response.data.orderId;
      } else {
        throw new Error("Failed to place market order");
      }
    } catch (err: any) {
      console.error("[BROKER] Market Order Exception:", err?.response?.data || err.message);
      throw new Error(err?.response?.data?.errorMessage || err.message);
    }
  }

  async getRiskMetrics(): Promise<{ realizedPnl: number; closedLosingTrades: number }> {
    try {
      const positions = await this.getPositions();
      let realizedPnl = 0;
      let closedLosingTrades = 0;
      
      for (const pos of positions) {
        const productType = pos.productType?.toUpperCase();
        const netQty = Number(pos.netQty ?? 0);
        
        if ((productType === "INTRADAY" || productType === "BO") && netQty === 0) {
          const tradePnl = Number(pos.realizedProfit ?? 0);
          realizedPnl += tradePnl;
          if (tradePnl < 0) {
            closedLosingTrades++;
          }
        }
      }
      return { realizedPnl, closedLosingTrades };
    } catch (err: any) {
      console.error("[BROKER] Failed to fetch risk metrics:", err.message);
      throw err;
    }
  }

  estimateMarginUsed(quantity: number, entryPrice: number, leverage: number): number {
    if (leverage <= 0) throw new Error("Leverage must be greater than zero");
    return (quantity * entryPrice) / leverage;
  }
}
