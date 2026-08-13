import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

const ANGEL_SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const _scripFile = fileURLToPath(import.meta.url);
const _scripDir = path.dirname(_scripFile);
const CACHE_FILE = process.env.ANGEL_SCRIP_CACHE_PATH ?? path.join(_scripDir, "../data/.angel_scrip_cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface AngelScripMasterRow {
  token: string;
  name: string;
  symbol: string;
  exch_seg: string;
  instrumenttype: string;
}

// symbolMap: "TCS" -> "11536" (Angel's symboltoken, distinct from Dhan's securityId)
let symbolMap = new Map<string, string>();

function parseScripMaster(rows: AngelScripMasterRow[]): void {
  const tempSymbolMap = new Map<string, string>();

  for (const row of rows) {
    // Cash-market NSE equities only. instrumenttype is empty string for plain equity.
    if (row.exch_seg === "NSE" && row.instrumenttype === "") {
      if (row.name && row.token) {
        tempSymbolMap.set(row.name.trim().toUpperCase(), row.token);
      }
      if (row.symbol && row.token) {
        const cleanSymbol = row.symbol.replace(/-EQ$/i, "").replace(/-BE$/i, "").trim().toUpperCase();
        tempSymbolMap.set(cleanSymbol, row.token);
      }
    }
  }

  symbolMap = tempSymbolMap;
}

export async function initializeAngelScripMaster(): Promise<void> {
  console.log("[ANGEL_SCRIP_MASTER] Initializing Angel One instrument map...");

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      const isFresh = Date.now() - stats.mtimeMs < CACHE_TTL_MS;

      if (isFresh) {
        const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
        if (cachedData.symbolMap) {
          symbolMap = new Map(Object.entries(cachedData.symbolMap));
          console.log(`[ANGEL_SCRIP_MASTER] Loaded ${symbolMap.size} symbols from cache.`);
          return;
        }
      }
    }

    console.log("[ANGEL_SCRIP_MASTER] Downloading fresh Angel One scrip master...");
    const response = await axios.get(ANGEL_SCRIP_MASTER_URL);
    parseScripMaster(response.data);

    const cacheData = {
      symbolMap: Object.fromEntries(symbolMap),
      timestamp: Date.now(),
    };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData));

    console.log(`[ANGEL_SCRIP_MASTER] Initialized successfully with ${symbolMap.size} equities.`);
  } catch (error: any) {
    console.error("[ANGEL_SCRIP_MASTER] Failed to initialize:", error.message);

    if (fs.existsSync(CACHE_FILE)) {
      console.log("[ANGEL_SCRIP_MASTER] Falling back to stale cache...");
      try {
        const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
        symbolMap = new Map(Object.entries(cachedData.symbolMap));
        console.log(`[ANGEL_SCRIP_MASTER] Loaded ${symbolMap.size} symbols from stale cache.`);
      } catch (err) {
        console.error("[ANGEL_SCRIP_MASTER] Cache fallback failed.");
      }
    }
  }
}

/**
 * Returns the Angel One symboltoken for a given Trading Symbol.
 * Example: "TCS" -> "11536"
 */
export function getAngelToken(symbol: string): string | null {
  const cleanSymbol = symbol.trim().toUpperCase();
  return symbolMap.get(cleanSymbol) || null;
}
