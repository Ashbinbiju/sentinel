import axios from "axios";

export interface ScripMasterRow {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size: string;
}

let scripMap: Map<string, string> = new Map();

/**
 * Downloads and parses the Angel One Scrip Master JSON to map NSE symbols to Angel Tokens.
 * This file is huge (~20MB), so we only download it once on startup and keep the Equity tokens in memory.
 */
export async function initializeScripMaster() {
  console.log("[SCRIP] Downloading Angel One Scrip Master...");
  try {
    const url = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
    const { data } = await axios.get<ScripMasterRow[]>(url);
    
    let count = 0;
    for (const row of data) {
      // We only care about NSE Equity for intraday trading
      if (row.exch_seg === "NSE" && row.instrumenttype === "") {
        // e.g. symbol "RELIANCE-EQ" -> name "RELIANCE"
        // Sometimes the Sentinel API returns "RELIANCE", so we map the base name to the token
        const cleanName = row.name.toUpperCase();
        scripMap.set(cleanName, row.token);
        count++;
      }
    }
    console.log(`[SCRIP] Successfully loaded ${count} NSE Equity tokens.`);
  } catch (error) {
    console.error("[SCRIP] Failed to load Scrip Master:", error);
    process.exit(1);
  }
}

/**
 * Returns the Angel One Token for a given NSE symbol.
 * Example: getToken("RELIANCE") -> "2885"
 */
export function getToken(symbol: string): string | null {
  const cleanSymbol = symbol.toUpperCase().trim();
  const token = scripMap.get(cleanSymbol);
  if (!token) {
    console.warn(`[SCRIP] Warning: Could not find Angel One token for symbol: ${symbol}`);
    return null;
  }
  return token;
}
