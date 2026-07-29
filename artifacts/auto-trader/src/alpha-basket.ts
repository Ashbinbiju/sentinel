/**
 * Sentinel 25-Stock High-Conviction Alpha Basket
 * Curated from comprehensive Nifty 100 backtest validation (July 2026).
 * Features: >50% Win Rate, High R-Multiples, Institutional Liquidity (>₹100 Cr Turnover).
 */
export const SENTINEL_ALPHA_BASKET: string[] = [
  // FMCG & Consumer Staples
  "NESTLEIND",
  "BRITANNIA",
  "HINDUNILVR",
  "ITC",

  // Large Financials & Banking
  "BAJFINANCE",
  "CHOLAFIN",
  "BAJAJFINSV",
  "SBIN",
  "BAJAJHLDNG",

  // Telecom, Real Estate & Infrastructure
  "INDIGO",
  "ADANIPORTS",
  "DLF",
  "BHARTIARTL",
  "LT",
  "RELIANCE",

  // IT & Technology
  "HCLTECH",
  "INFY",

  // Energy, Utilities & Defense
  "MAZDOCK",
  "TITAN",
  "TATAPOWER",
];

export function isAlphaBasketStock(symbol: string): boolean {
  const cleanSym = symbol.trim().toUpperCase();
  return SENTINEL_ALPHA_BASKET.includes(cleanSym);
}
