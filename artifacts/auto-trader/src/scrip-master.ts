import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const _scripFile = fileURLToPath(import.meta.url);
const _scripDir = path.dirname(_scripFile);
const CACHE_FILE = process.env.SCRIP_CACHE_PATH ?? path.join(_scripDir, '../data/.dhan_scrip_cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory maps
// symbolMap: "TCS" -> "11536"
let symbolMap = new Map<string, string>();

function parseScripMaster(csvData: string): void {
  const lines = csvData.split('\n');
  const tempSymbolMap = new Map<string, string>();

  // Dhan CSV Columns:
  // 0: SEM_EXM_EXCH_ID
  // 1: SEM_SEGMENT
  // 2: SEM_SMST_SECURITY_ID
  // 3: SEM_INSTRUMENT_NAME
  // 4: SEM_EXPIRY_CODE
  // 5: UNDERLYING_SECURITY_ID
  // 6: UNDERLYING_SYMBOL
  // 7: SYMBOL_NAME
  // 8: SM_SYMBOL_NAME
  // 9: SEM_TRADING_SYMBOL
  // 10: DISPLAY_NAME
  // 11: SEM_CUSTOM_SYMBOL
  // 12: INSTRUMENT_TYPE
  // 13: SEM_EXCH_INSTRUMENT_TYPE
  // 14: SERIES
  // 15: SEM_SERIES

  let headers: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    if (i === 0) {
      headers = line.split(',');
      continue;
    }
    
    const cols = line.split(',');
    if (cols.length < 16) continue;
    
    const exchId = cols[0]; // SEM_EXM_EXCH_ID
    const segment = cols[1]; // SEM_SEGMENT
    const securityId = cols[2]; // SEM_SMST_SECURITY_ID
    const tradingSymbol = cols[5]; // SEM_TRADING_SYMBOL
    const series = cols[14]; // SEM_SERIES
    
    // We want NSE Equity
    if (exchId === 'NSE' && segment === 'E' && (series === 'EQ' || series === 'BE' || series === 'SM')) {
      if (tradingSymbol && securityId) {
        // Dhan trading symbol might be "TCS-EQ". We strip "-EQ" to get pure symbol.
        const cleanSymbol = tradingSymbol.replace(/-EQ$/i, '').replace(/-BE$/i, '').trim().toUpperCase();
        tempSymbolMap.set(cleanSymbol, securityId);
      }
    }
  }

  symbolMap = tempSymbolMap;
}

export async function initializeScripMaster(): Promise<void> {
  console.log('[SCRIP_MASTER] Initializing Dhan instrument map...');

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      const isFresh = Date.now() - stats.mtimeMs < CACHE_TTL_MS;

      if (isFresh) {
        const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        if (cachedData.symbolMap) {
          symbolMap = new Map(Object.entries(cachedData.symbolMap));
          console.log(`[SCRIP_MASTER] Loaded ${symbolMap.size} symbols from cache.`);
          return;
        }
      }
    }

    console.log('[SCRIP_MASTER] Downloading fresh Dhan scrip master...');
    const response = await axios.get(SCRIP_MASTER_URL);
    parseScripMaster(response.data);

    // Save to cache
    const cacheData = {
      symbolMap: Object.fromEntries(symbolMap),
      timestamp: Date.now()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData));

    console.log(`[SCRIP_MASTER] Initialized successfully with ${symbolMap.size} equities.`);
  } catch (error: any) {
    console.error('[SCRIP_MASTER] Failed to initialize:', error.message);
    
    // Fallback to cache if available even if stale
    if (fs.existsSync(CACHE_FILE)) {
      console.log('[SCRIP_MASTER] Falling back to stale cache...');
      try {
        const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        symbolMap = new Map(Object.entries(cachedData.symbolMap));
        console.log(`[SCRIP_MASTER] Loaded ${symbolMap.size} symbols from stale cache.`);
      } catch (err) {
        console.error('[SCRIP_MASTER] Cache fallback failed.');
      }
    }
  }
}

/**
 * Returns the Dhan Security ID for a given Trading Symbol.
 * Example: "TCS" -> "11536"
 */
export function getSecurityId(symbol: string): string | null {
  const cleanSymbol = symbol.trim().toUpperCase();
  return symbolMap.get(cleanSymbol) || null;
}
