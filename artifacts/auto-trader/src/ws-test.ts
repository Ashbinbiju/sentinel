/**
 * Minimal Dhan WebSocket diagnostic — isolates whether the issue is
 * our code, the token, or Dhan's service.
 */
import { WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

const clientId = process.env.DHAN_CLIENT_ID?.trim();
let accessToken = process.env.DHAN_ACCESS_TOKEN?.trim() || "";

const tokenFilePath = path.resolve(process.cwd(), "../../.dhan_token");
if (fs.existsSync(tokenFilePath)) {
  accessToken = fs.readFileSync(tokenFilePath, "utf8").trim();
}

if (!clientId || !accessToken) {
  console.error("Missing DHAN_CLIENT_ID or access token");
  process.exit(1);
}

console.log(`Client ID: ${clientId}`);
console.log(`Token length: ${accessToken.length}`);
console.log(`Token first 20 chars: ${accessToken.substring(0, 20)}...`);
console.log(`Token last 20 chars: ...${accessToken.substring(accessToken.length - 20)}`);

// Check for characters that might break the URL
const hasSpecialChars = /[+/= \n\r\t]/.test(accessToken);
console.log(`Token has URL-unsafe chars: ${hasSpecialChars}`);
if (hasSpecialChars) {
  console.log(`  Spaces: ${(accessToken.match(/ /g) || []).length}`);
  console.log(`  Newlines: ${(accessToken.match(/[\n\r]/g) || []).length}`);
  console.log(`  Plus: ${(accessToken.match(/\+/g) || []).length}`);
  console.log(`  Equals: ${(accessToken.match(/=/g) || []).length}`);
  console.log(`  Slash: ${(accessToken.match(/\//g) || []).length}`);
}

const wsUrl = `wss://api-feed.dhan.co?version=2&token=${accessToken}&clientId=${clientId}&authType=2`;
console.log(`\nWS URL length: ${wsUrl.length}`);
console.log(`Connecting...`);

const ws = new WebSocket(wsUrl);

ws.on("open", () => {
  console.log(`[OPEN] Connected at ${new Date().toISOString()}`);
  
  // Don't subscribe to anything — just see if the bare connection survives
  console.log("[TEST] Holding connection open with no subscriptions...");
});

ws.on("message", (data: Buffer) => {
  console.log(`[MSG] Received ${data.length} bytes (code=${data.readUInt8(0)})`);
});

ws.on("close", (code: number, reason: Buffer) => {
  console.log(`[CLOSE] code=${code} reason="${reason?.toString() || "none"}" at ${new Date().toISOString()}`);
  process.exit(0);
});

ws.on("error", (err: any) => {
  console.error(`[ERROR]`, err.message);
});

ws.on("unexpected-response", (req: any, res: any) => {
  console.error(`[UNEXPECTED-RESPONSE] HTTP ${res.statusCode} ${res.statusMessage}`);
  let body = "";
  res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  res.on("end", () => {
    console.error(`Response body: ${body}`);
    process.exit(1);
  });
});

// Keep alive for 30 seconds
setTimeout(() => {
  console.log("[TEST] 30 seconds elapsed — connection survived! Closing.");
  ws.close();
  process.exit(0);
}, 30000);
