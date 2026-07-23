# Sentinel Auto-Trader: System Knowledge & Agent Rules

Welcome to the Sentinel project! When an AI Agent starts a new session in this workspace, they must read this file to understand the architecture, deployment environment, and critical quirks of the system.

## 1. System Architecture
The project is an automated algorithmic trading bot that interfaces with the **Dhan API**.
It consists of two main PM2-managed applications:
- **`sentinel-api`**: An API server for historical data and web-dashboard mocking.
- **`auto-trader`**: The core execution engine.

### Core Components of `auto-trader`:
- **`index.ts`**: The main execution loop. It fetches daily watchlists (gainers/losers), orchestrates REST backfills, handles the scheduled 3-min watchlist refreshes, and runs a global safety loop for things like Intraday auto-square-off (3:14 PM).
- **`dhan.ts` (`DhanBroker`)**: Manages the Dhan REST API and WebSocket connection. It parses raw binary quote/ticker packets, places orders (including Super Orders for bracket SL/Target), and validates/renews the authentication token.
- **`candle-engine.ts` (`CandleEngine`)**: Ingests raw Dhan ticks, manages out-of-order/timezone-skewed packets, and aggregates ticks into 1m and 5m candles. When a 5m candle closes, it emits an `onCandleClosed` event.
- **`engine.ts` (`ExecutionEngine`)**: Receives finalized candles, evaluates technical strategies against previous day highs/lows (PDH/PDL), places bracket orders, and manages position reconciliation.
- **`db.ts` (`TradeDB`)**: A lightweight JSON-based file database that persists active and historical trades to `data/trades.json`.

## 2. Deployment Environment
- **Host**: Ubuntu AWS EC2 Instance.
- **Process Manager**: `pm2`
- **Commands**:
  - Updating code: `git pull` then `pnpm run build`
  - Restarting PM2 safely: `pm2 delete auto-trader && pm2 start ecosystem.config.js --only auto-trader && pm2 save`
  - Viewing logs: `pm2 logs auto-trader`

## 3. Critical Rules & Known Gotchas

### A. PM2 Watch Mode (CRITICAL)
- **Rule**: `watch: false` MUST be enforced in `ecosystem.config.js` for `auto-trader`.
- **Reason**: The `auto-trader` dynamically writes state to `artifacts/auto-trader/data/trades.json` upon every tick/trade change. If PM2 `watch` is enabled, PM2 will detect this file change and infinitely crash/restart the bot during live market execution.

### B. Dhan API Authentication
- **Rule**: The Dhan API uses an `access-token` that expires.
- **Logic**: `validateOrRenewToken()` in `dhan.ts` attempts to automatically refresh the token using `DHAN_PIN` and `DHAN_TOTP_SECRET` if a `DH-901` or `Invalid_Authentication` error is hit. The new token is written to `../../.dhan_token` so that both the API and trader apps share the valid token.

### C. WebSocket Idempotency & Continuity
- **Rule**: The `DhanBroker` uses a `subscribedSymbols` Set to ensure `subscribeToSecurityIds()` does not spam duplicate subscription packets. This Set is cleared during a WebSocket reconnect.
- **Rule**: The `CandleEngine` uses `lastFinalized1mSlot` and `lastFinalized5mSlot` to prevent the same candle from being finalized multiple times. Dhan quote packets can sometimes carry stale timestamps; these maps ensure strict forward-progression.

### D. Timezone Handling
- **Rule**: All logic must operate within IST (Indian Standard Time).
- **Quirk**: The Dhan WebSocket sometimes sends `exchangeTimestampMs` that appears 5 hours 30 minutes in the future relative to the EC2 server (if the EC2 is in UTC). `candle-engine.ts` explicitly corrects this 19,800,000 ms skew before processing ticks.

---
*Note to Agents: Use this document to contextualize any debugging of WebSocket streams, PM2 restarts, or trade execution loops.*
