import axios from "axios";
import { WebSocket } from "ws";

const DHAN_BASE_URL = "https://api.dhan.co/v2";

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
}

export class DhanBroker {
  private clientId: string;
  private accessToken: string;
  private ws: WebSocket | null = null;
  private wsCallbacks: ((securityId: string, ltp: number) => void)[] = [];
  
  constructor() {
    const clientId = process.env.DHAN_CLIENT_ID?.trim();
    const accessToken = process.env.DHAN_ACCESS_TOKEN?.trim();
    
    if (!clientId || !accessToken) {
      throw new Error("Missing DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN in .env");
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
      await this.getAccountBalance();
      console.log("[BROKER] Dhan access token is valid.");
    } catch (err: any) {
      if (err.response && err.response.status === 401) {
        console.warn("[BROKER] Token seems invalid or expired. Attempting to renew...");
        try {
          await axios.post(`${DHAN_BASE_URL}/RenewToken`, {}, {
            headers: {
              ...this.getHeaders(),
              "dhanClientId": this.clientId
            }
          });
          console.log("[BROKER] Token renewed successfully.");
        } catch (renewErr: any) {
          console.error("[BROKER] Failed to renew token:", renewErr?.response?.data || renewErr.message);
          throw new Error("Dhan token expired and renewal failed. Please generate a new one from the portal.");
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
    try {
      const response = await axios.get(`${DHAN_BASE_URL}/positions`, {
        headers: this.getHeaders()
      });
      return Array.isArray(response.data) ? response.data : [];
    } catch (err: any) {
      console.error("[BROKER] Failed to fetch positions:", err?.response?.data || err.message);
      return [];
    }
  }

  async getOrderBook(): Promise<DhanOrder[]> {
    try {
      const response = await axios.get(`${DHAN_BASE_URL}/orders`, {
        headers: this.getHeaders()
      });
      return Array.isArray(response.data) ? response.data : [];
    } catch (err: any) {
      console.error("[BROKER] Failed to fetch order book:", err?.response?.data || err.message);
      return [];
    }
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
        quantity: input.quantity.toString(),
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

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await axios.delete(`${DHAN_BASE_URL}/orders/${orderId}`, {
        headers: this.getHeaders()
      });
      console.log(`[BROKER] Cancelled order ${orderId} successfully.`);
    } catch (err: any) {
      console.error(`[BROKER] Exception cancelling order ${orderId}:`, err?.response?.data || err.message);
      throw err;
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

  // --- WebSocket Implementation ---
  
  async connectWebSocket(): Promise<void> {
    if (!this.clientId || !this.accessToken) {
      throw new Error("Cannot connect WebSocket: Not authenticated.");
    }

    if (this.ws) {
      try {
        console.log("[BROKER] Closing old WebSocket connection...");
        this.ws.close();
      } catch (err: any) {
        console.warn("[BROKER] Error closing old WebSocket instance:", err.message);
      }
    }
    
    // AuthType 2 for JWT
    const wsUrl = `wss://api-feed.dhan.co?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.on("open", () => {
      console.log("[BROKER] Dhan WebSocket Connected.");
    });
    
    this.ws.on("message", (data: Buffer) => {
      this.parseBinaryTick(data);
    });
    
    this.ws.on("close", () => {
      console.warn("[BROKER] WebSocket Closed. Attempting reconnect in 5s...");
      setTimeout(() => this.connectWebSocket(), 5000);
    });
    
    this.ws.on("error", (err: any) => {
      console.error("[BROKER] WebSocket Error:", err);
    });
  }

  onTick(callback: (securityId: string, ltp: number) => void) {
    this.wsCallbacks.push(callback);
  }

  private parseBinaryTick(buf: Buffer) {
    try {
      let offset = 0;
      while (offset < buf.length) {
        if (offset + 8 > buf.length) break; // Incomplete header
        
        const responseCode = buf.readUInt8(offset);        // byte 0 is Feed Response Code
        const packetLength = buf.readUInt16LE(offset + 2); // bytes 2-3 are Message Length
        const securityId = buf.readUInt32LE(offset + 4).toString(); // bytes 4-7 are Security ID
        
        // Ensure we don't read out of bounds
        if (packetLength > 0 && offset + packetLength <= buf.length) {
          if (responseCode === 2 && offset + 13 <= buf.length) {
            const ltp = buf.readFloatLE(offset + 8);
            this.wsCallbacks.forEach(cb => cb(securityId, ltp));
          } 
          else if ((responseCode === 4 || responseCode === 8) && offset + 13 <= buf.length) {
            const ltp = buf.readFloatLE(offset + 8);
            this.wsCallbacks.forEach(cb => cb(securityId, ltp));
          }
          offset += packetLength;
        } else {
          // Fallback to avoid infinite loops
          break;
        }
      }
    } catch (err: any) {
      // silent catch for parsing errors to prevent crashing
    }
  }

  subscribeToSecurityIds(securityIds: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[BROKER] WebSocket not ready. Cannot subscribe.");
      return;
    }
    if (securityIds.length === 0) return;

    // Send max 100 instruments per request as per Dhan docs
    const chunkSize = 100;
    for (let i = 0; i < securityIds.length; i += chunkSize) {
      const chunk = securityIds.slice(i, i + chunkSize);
      
      const payload = {
        RequestCode: 17, // Subscribe to Quote (for volume data)
        InstrumentCount: chunk.length,
        InstrumentList: chunk.map(id => ({
          ExchangeSegment: "NSE_EQ",
          SecurityId: id
        }))
      };
      
      this.ws.send(JSON.stringify(payload));
    }
    
    console.log(`[BROKER] Subscribed to ${securityIds.length} securityIds for LTP streaming.`);
  }

  unsubscribeFromSecurityIds(securityIds: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (securityIds.length === 0) return;

    const chunkSize = 100;
    for (let i = 0; i < securityIds.length; i += chunkSize) {
      const chunk = securityIds.slice(i, i + chunkSize);
      
      const payload = {
        RequestCode: 16, // Unsubscribe
        InstrumentCount: chunk.length,
        InstrumentList: chunk.map(id => ({
          ExchangeSegment: "NSE_EQ",
          SecurityId: id
        }))
      };
      
      this.ws.send(JSON.stringify(payload));
    }
  }
}
