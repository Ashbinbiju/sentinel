/**
 * Minimal Dhan WebSocket diagnostic — generates a FRESH token via TOTP
 * and tests whether it works for WebSocket.
 */
import { WebSocket } from "ws";
import { TOTP } from "totp-generator";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

const clientId = process.env.DHAN_CLIENT_ID?.trim();
const pin = process.env.DHAN_PIN?.trim();
const totpSecret = process.env.DHAN_TOTP_SECRET?.trim();

let accessToken = process.env.DHAN_ACCESS_TOKEN?.trim() || "";
const tokenFilePath = path.resolve(process.cwd(), "../../.dhan_token");
if (fs.existsSync(tokenFilePath)) {
  accessToken = fs.readFileSync(tokenFilePath, "utf8").trim();
}

if (!clientId) { console.error("Missing DHAN_CLIENT_ID"); process.exit(1); }

async function testWithToken(label: string, token: string) {
  console.log(`\n--- Testing: ${label} ---`);
  console.log(`Token length: ${token.length}`);
  console.log(`Token prefix: ${token.substring(0, 30)}...`);

  const wsUrl = `wss://api-feed.dhan.co?version=2&token=${token}&clientId=${clientId}&authType=2`;

  return new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      console.log(`[${label}] ✅ Connection survived 15 seconds!`);
      ws.close();
      resolve();
    }, 15000);

    ws.on("open", () => {
      console.log(`[${label}] OPEN at ${new Date().toISOString()}`);
    });

    ws.on("message", (data: Buffer) => {
      console.log(`[${label}] MSG: ${data.length} bytes`);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      console.log(`[${label}] ❌ CLOSE code=${code} reason="${reason?.toString() || "none"}" at ${new Date().toISOString()}`);
      resolve();
    });

    ws.on("error", (err: any) => {
      clearTimeout(timeout);
      console.error(`[${label}] ERROR:`, err.message);
      resolve();
    });

    ws.on("unexpected-response", (_req: any, res: any) => {
      clearTimeout(timeout);
      console.error(`[${label}] HTTP ${res.statusCode} ${res.statusMessage}`);
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => { console.error(`Body: ${body}`); resolve(); });
    });
  });
}

async function main() {
  // Test 1: Existing token
  console.log("=== Test 1: Existing Token ===");
  await testWithToken("EXISTING", accessToken);

  // Test 2: Fresh TOTP token
  if (pin && totpSecret) {
    console.log("\n=== Test 2: Fresh TOTP Token ===");
    try {
      const cleanSecret = totpSecret.replace(/\s+/g, "").toUpperCase();
      const totpInfo = await TOTP.generate(cleanSecret);
      const totpCode = typeof totpInfo === "string" ? totpInfo : totpInfo.otp;
      console.log(`TOTP generated: ${totpCode}`);

      const response = await axios.post(
        `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${clientId}&pin=${pin}&totp=${totpCode}`,
        {}
      );

      const rawToken = response.data?.accessToken ?? response.data?.token ?? response.data?.data?.accessToken ?? "";
      const freshToken = typeof rawToken === "string" ? rawToken.trim() : "";

      if (freshToken.length > 0) {
        console.log(`Fresh token obtained! Length: ${freshToken.length}`);
        await testWithToken("FRESH", freshToken);
      } else {
        console.error("No token in auth response:", response.data);
      }
    } catch (err: any) {
      console.error("TOTP auth failed:", err?.response?.data || err.message);
    }
  } else {
    console.log("\nSkipping fresh token test (no PIN/TOTP_SECRET)");
  }

  process.exit(0);
}

main();
