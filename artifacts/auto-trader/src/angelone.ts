import axios from "axios";
import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { TOTP } from "totp-generator";
import * as path from "path";
import * as fs from "fs";
import { DhanMarketTick } from "./dhan";
import { getAngelToken } from "./angel-scrip-master";
import { getSymbolForSecurityId } from "./scrip-master";

const ANGEL_LOGIN_URL = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";
const ANGEL_WS_URL = "wss://smartapisocket.angelone.in/smart-stream";

// Full Quote-mode packet is 123 bytes per SmartAPI WebSocket Streaming 2.0 docs.
// We only read the first 75 bytes of it (through cumulative volume), but requiring
// the full size is a cheap sanity check that this is a genuine Quote packet.
const QUOTE_PACKET_MIN_SIZE = 123;

interface AngelSession {
  jwtToken: string;
  feedToken: string;
  expiresAt: number;
}

/**
 * Live market-data feed sourced from Angel One's SmartAPI WebSocket (data only —
 * order placement stays on Dhan, see dhan.ts). Emits ticks in the same
 * DhanMarketTick shape, keyed by Dhan securityId, so CandleEngine/ExecutionEngine
 * don't need to know which broker the tick actually came from.
 */
export class AngelOneFeed extends EventEmitter {
  private apiKey: string;
  private clientCode: string;
  private password: string;
  private totpSecret: string;

  private session: AngelSession | null = null;
  private ws: WebSocket | null = null;
  private wsCallbacks: ((tick: DhanMarketTick) => void)[] = [];
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private stableTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  // Tracked by Dhan securityId — the ID space the rest of the app speaks.
  private subscribedSecurityIds: Set<string> = new Set();
  private pendingSubscriptions: Set<string> = new Set();

  // Resolved lazily from the two scrip masters and cached both ways.
  private secIdToAngelToken = new Map<string, string>();
  private angelTokenToSecId = new Map<string, string>();

  constructor() {
    super();
    const apiKey = process.env.ANGEL_API_KEY?.trim();
    const clientCode = process.env.ANGEL_CLIENT_CODE?.trim();
    const password = process.env.ANGEL_PASSWORD?.trim();
    const totpSecret = process.env.ANGEL_TOTP_SECRET?.trim();

    if (!apiKey || !clientCode || !password || !totpSecret) {
      throw new Error(
        "Missing ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD or ANGEL_TOTP_SECRET in .env"
      );
    }

    this.apiKey = apiKey;
    this.clientCode = clientCode;
    this.password = password;
    this.totpSecret = totpSecret;
  }

  private getSessionFilePath(): string {
    // Shared with api-server's own Angel session file when colocated on the same
    // host, so both processes reuse one login instead of racing Angel's login API.
    return path.resolve(process.cwd(), "../../.angel_session.json");
  }

  private async login(): Promise<AngelSession> {
    const sessionFilePath = this.getSessionFilePath();

    try {
      if (fs.existsSync(sessionFilePath)) {
        const cached = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
        if (cached?.jwtToken && cached?.feedToken && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
          console.log("[ANGEL_FEED] Adopting cached Angel One session from disk.");
          return cached;
        }
      }
    } catch {
      // Corrupt or unreadable cache — fall through to a fresh login.
    }

    console.log("[ANGEL_FEED] Logging in to Angel One SmartAPI...");
    const cleanSecret = this.totpSecret.replace(/\s+/g, "").toUpperCase();
    const totpInfo = await TOTP.generate(cleanSecret);
    const totp = typeof totpInfo === "string" ? totpInfo : totpInfo.otp;

    const response = await axios.post(
      ANGEL_LOGIN_URL,
      { clientcode: this.clientCode, password: this.password, totp, state: "sentinel-auto-trader" },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-UserType": "USER",
          "X-SourceID": "WEB",
          "X-MACAddress": "00:00:00:00:00:00",
          "X-PrivateKey": this.apiKey,
        },
        timeout: 10000,
      }
    );

    if (!response.data?.status || !response.data?.data?.jwtToken) {
      throw new Error(response.data?.message || "Angel One login failed");
    }

    const session: AngelSession = {
      jwtToken: response.data.data.jwtToken,
      feedToken: response.data.data.feedToken,
      // Angel sessions are valid until midnight IST; 7h is a conservative refresh
      // window that stays inside any single trading day.
      expiresAt: Date.now() + 7 * 60 * 60 * 1000,
    };

    try {
      const tmpFile = sessionFilePath + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(session), "utf8");
      fs.renameSync(tmpFile, sessionFilePath);
    } catch (e: any) {
      console.warn("[ANGEL_FEED] Failed to persist Angel One session file:", e.message);
    }

    console.log("[ANGEL_FEED] Angel One login successful.");
    return session;
  }

  private resolveAngelToken(securityId: string): string | null {
    const cached = this.secIdToAngelToken.get(securityId);
    if (cached) return cached;

    const symbol = getSymbolForSecurityId(securityId);
    if (!symbol) return null;

    const angelToken = getAngelToken(symbol);
    if (!angelToken) return null;

    this.secIdToAngelToken.set(securityId, angelToken);
    this.angelTokenToSecId.set(angelToken, securityId);
    return angelToken;
  }

  async connectWebSocket(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.session = await this.login();

    if (this.ws) {
      try {
        console.log("[ANGEL_FEED] Closing old WebSocket connection...");
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.ws.removeAllListeners();
        this.ws.on("error", () => {});
        this.ws.close();
      } catch (err: any) {
        console.warn("[ANGEL_FEED] Error closing old WebSocket instance:", err.message);
      }
    }

    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${this.session!.jwtToken}`,
        "x-api-key": this.apiKey,
        "x-client-code": this.clientCode,
        "x-feed-token": this.session!.feedToken,
      };

      this.ws = new WebSocket(ANGEL_WS_URL, { headers });
      this.subscribedSecurityIds.clear();

      this.ws.on("open", () => {
        console.log("[ANGEL_FEED] Angel One WebSocket Connected.");
        if (this.stableTimeout) clearTimeout(this.stableTimeout);
        this.stableTimeout = setTimeout(() => {
          this.reconnectAttempts = 0;
        }, 10000);

        // Angel requires a text "ping" heartbeat at least every 30s to keep the
        // connection alive; send at 20s for margin.
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send("ping");
          }
        }, 20000);

        if (this.pendingSubscriptions.size > 0) {
          const pending = [...this.pendingSubscriptions];
          this.pendingSubscriptions.clear();
          console.log(`[ANGEL_FEED] Flushing ${pending.length} pending subscriptions...`);
          this.subscribeToSecurityIds(pending);
        }

        this.emit("onReconnect");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        // The server replies "pong" (text) to our heartbeat; everything else is a
        // binary tick packet, which is always far larger than 4 bytes.
        if (data.length < 10 && data.toString("utf8") === "pong") return;
        this.parseBinaryMessage(data);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        if (this.stableTimeout) {
          clearTimeout(this.stableTimeout);
          this.stableTimeout = null;
        }

        const reasonStr = reason?.toString() || "no reason";
        const delay = Math.min(60000, 15000 * Math.pow(2, this.reconnectAttempts));
        this.reconnectAttempts++;
        console.warn(`[ANGEL_FEED] WebSocket Closed (code=${code}, reason="${reasonStr}"). Reconnecting in ${delay / 1000}s...`);

        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.emit("onDisconnect");
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(
          () => this.connectWebSocket().catch(e => console.error("[ANGEL_FEED] Reconnect error:", e.message)),
          delay
        );
      });

      this.ws.on("error", (err: any) => {
        console.error("[ANGEL_FEED] WebSocket Error:", err);
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
  }

  onTick(callback: (tick: DhanMarketTick) => void) {
    this.wsCallbacks.push(callback);
  }

  private emitTick(tick: DhanMarketTick) {
    this.wsCallbacks.forEach(cb => cb(tick));
  }

  // Angel Quote-mode binary packet layout (Little Endian), per SmartAPI WebSocket
  // Streaming 2.0 docs. Each WS message carries exactly one tick (unlike Dhan's
  // protocol, which packs several sub-packets per frame behind explicit length
  // headers), so there's no offset-walking loop needed here.
  private parseBinaryMessage(buffer: Buffer): void {
    if (buffer.length < QUOTE_PACKET_MIN_SIZE) return;

    const subscriptionMode = buffer.readInt8(0);
    if (subscriptionMode !== 2) return; // We only subscribe in Quote mode (2).

    // Token: 25-byte UTF-8 field starting at offset 2, null-terminated.
    const tokenRaw = buffer.toString("utf8", 2, 27);
    const nullIdx = tokenRaw.indexOf(" ");
    const angelToken = (nullIdx >= 0 ? tokenRaw.slice(0, nullIdx) : tokenRaw).trim();

    const securityId = this.angelTokenToSecId.get(angelToken);
    if (!securityId) return;

    const exchangeTimestampMs = Number(buffer.readBigInt64LE(35));
    // LTP is transmitted in paise (price * 100).
    const ltp = Number(buffer.readBigInt64LE(43)) / 100;
    const lastTradedQuantity = Number(buffer.readBigInt64LE(51));
    const cumulativeVolume = Number(buffer.readBigInt64LE(67));

    if (!Number.isFinite(ltp) || ltp <= 0 || exchangeTimestampMs <= 0 || cumulativeVolume < 0) return;

    this.emitTick({
      securityId,
      exchangeSegment: 1,
      ltp,
      lastTradedQuantity,
      exchangeTimestampMs,
      cumulativeVolume,
    });
  }

  subscribeToSecurityIds(securityIds: string[]) {
    if (securityIds.length === 0) return;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const queued = securityIds.filter(
        id => !this.subscribedSecurityIds.has(id) && !this.pendingSubscriptions.has(id)
      );
      queued.forEach(id => this.pendingSubscriptions.add(id));
      if (queued.length > 0) {
        console.warn(`[ANGEL_FEED] WebSocket not ready. Queued ${queued.length} subscriptions for when it reconnects.`);
      }
      return;
    }

    const newIds = securityIds.filter(id => !this.subscribedSecurityIds.has(id));
    if (newIds.length === 0) return;

    const angelTokens: string[] = [];
    for (const securityId of newIds) {
      const token = this.resolveAngelToken(securityId);
      if (!token) {
        console.warn(`[ANGEL_FEED] No Angel One token found for Dhan securityId ${securityId}. Skipping.`);
        continue;
      }
      angelTokens.push(token);
      this.subscribedSecurityIds.add(securityId);
    }

    if (angelTokens.length === 0) return;

    const chunkSize = 100;
    for (let i = 0; i < angelTokens.length; i += chunkSize) {
      const chunk = angelTokens.slice(i, i + chunkSize);
      const payload = {
        correlationID: `sub-${Date.now().toString(36).slice(-8)}`,
        action: 1, // Subscribe
        params: {
          mode: 2, // Quote — LTP mode omits volume, which VWAP needs
          tokenList: [{ exchangeType: 1, tokens: chunk }], // 1 = NSE cash market
        },
      };
      this.ws.send(JSON.stringify(payload));
    }

    console.log(`[ANGEL_FEED] Subscribed to ${angelTokens.length} securityIds for Quote stream.`);
  }

  unsubscribeFromSecurityIds(securityIds: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (securityIds.length === 0) return;

    const angelTokens: string[] = [];
    for (const securityId of securityIds) {
      const token = this.secIdToAngelToken.get(securityId);
      if (token) angelTokens.push(token);
      this.subscribedSecurityIds.delete(securityId);
    }
    if (angelTokens.length === 0) return;

    const chunkSize = 100;
    for (let i = 0; i < angelTokens.length; i += chunkSize) {
      const chunk = angelTokens.slice(i, i + chunkSize);
      const payload = {
        correlationID: `unsub-${Date.now().toString(36).slice(-8)}`,
        action: 0, // Unsubscribe
        params: {
          mode: 2,
          tokenList: [{ exchangeType: 1, tokens: chunk }],
        },
      };
      this.ws.send(JSON.stringify(payload));
    }
  }
}
