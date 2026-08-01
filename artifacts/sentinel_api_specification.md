# Sentinel Trading System — External API Specifications & Integration Guide

This document provides a complete technical reference for all 3 external APIs powering the Sentinel Momentum Auto-Trader engine.

---

## 1. Dynamic Stock Selection API (Intraday Screener)

### A. Sector Performance Ranking
- **Purpose**: Fetch top performing sectors in real-time.
- **HTTP Method**: `GET`
- **URL**: `https://intradayscreener.com/api/indices/sectorData/1`
- **Headers**:
  ```http
  Accept: application/json
  User-Agent: Mozilla/5.0
  ```

#### **Sample Response**:
```json
{
  "labels": ["NIFTY AUTO", "NIFTY IT", "NIFTY PHARMA", "NIFTY REALTY"],
  "keywords": ["nifty-auto", "nifty-it", "nifty-pharma", "nifty-realty"],
  "datasets": [2.45, 1.80, -0.25, 0.50]
}
```
* **Field Notes**: `datasets` contains the percentage change of each sector index. Sentinel selects the top 2 sectors with highest positive momentum.

---

### B. Sector Constituent Stock Watchlist
- **Purpose**: Fetch individual stocks within the leading sector.
- **HTTP Method**: `GET`
- **URL**: `https://intradayscreener.com/api/indices/index-constituents/{sectorKeyword}/1?filter=cash`
- **Example**: `https://intradayscreener.com/api/indices/index-constituents/nifty-auto/1?filter=cash`

#### **Sample Response**:
```json
{
  "indexConstituents": [
    {
      "symbol": "ASHOKLEY",
      "ltp": 160.50,
      "changePct": 2.15,
      "volume": 12450000
    },
    {
      "symbol": "MOTHERSON",
      "ltp": 147.75,
      "changePct": 1.95,
      "volume": 8900000
    }
  ]
}
```

---

## 2. Intraday Candle History API (Upstox)

- **Purpose**: Fetch historical 5-minute OHLCV candles to compute previous day High/Low/Close, Floor Pivots (P, R1, S1), 20D Average Daily Volume (ADV), and 2.0x Volume Surge.
- **HTTP Method**: `GET`
- **URL**: `https://api.upstox.com/v2/historical-candle/intraday/{instrumentKey}/5minute`
- **Example**: `https://api.upstox.com/v2/historical-candle/intraday/NSE_EQ|INE208A01029/5minute`

#### **Sample Response**:
```json
{
  "status": "success",
  "data": {
    "candles": [
      [
        "2026-07-31T09:20:00+05:30", // [0] Timestamp (ISO / Epoch)
        158.40,                     // [1] Open
        160.80,                     // [2] High
        158.10,                     // [3] Low
        160.50,                     // [4] Close
        452000,                     // [5] Volume
        0                           // [6] Open Interest
      ],
      [
        "2026-07-31T09:15:00+05:30",
        156.20,
        158.50,
        156.00,
        158.40,
        320000,
        0
      ]
    ]
  }
}
```

---

## 3. Live Execution Broker API (Dhan)

### A. Fund Limit / Account Balance
- **Purpose**: Check available cash balance for position sizing.
- **HTTP Method**: `GET`
- **URL**: `https://api.dhan.co/v2/fundlimit`
- **Headers**:
  ```http
  access-token: {DHAN_ACCESS_TOKEN}
  Content-Type: application/json
  ```

#### **Sample Response**:
```json
{
  "dhanClientId": "1107793529",
  "availabelBalance": 50000.00,
  "sodLimit": 50000.00,
  "collateralAmount": 0.00
}
```

---

### B. Place 5x Leveraged Super Order (Bracket Order with Entry, SL & Target)
- **Purpose**: Execute an intraday order with automatic Target (2.0R) and Stop Loss protection legs.
- **HTTP Method**: `POST`
- **URL**: `https://api.dhan.co/v2/super/orders`
- **Headers**:
  ```http
  access-token: {DHAN_ACCESS_TOKEN}
  Content-Type: application/json
  ```

#### **Sample Request Body**:
```json
{
  "dhanClientId": "1107793529",
  "correlationId": "sentinel-178552000-a1b2c",
  "transactionType": "BUY",
  "exchangeSegment": "NSE_EQ",
  "productType": "INTRADAY",
  "orderType": "MARKET",
  "securityId": "212",
  "quantity": 150,
  "price": 0,
  "targetPrice": 165.60,
  "stopLossPrice": 157.90,
  "trailingJump": 1.25
}
```

#### **Sample Response**:
```json
{
  "orderId": "11260731000984",
  "orderStatus": "PENDING"
}
```

---

### C. Live Market Feed (Dhan WebSocket)
- **Purpose**: Receive real-time 1-second price ticks during live trading hours.
- **URL**: `wss://api-feed.dhan.co?version=2&token={DHAN_ACCESS_TOKEN}&clientId={DHAN_CLIENT_ID}&authType=2`

#### **Subscription JSON Packet**:
```json
{
  "RequestCode": 17,
  "InstrumentCount": 1,
  "InstrumentList": [
    {
      "ExchangeSegment": "NSE_EQ",
      "SecurityId": "212"
    }
  ]
}
```

---

## 📐 **Summary of Strategy Calculations Applied to API Data**

1. **Pivot Formula**: $P = \frac{H + L + C}{3}$, $R1 = 2P - L$, $S1 = 2P - H$
2. **Breakout Condition**: Candle Close $> \max(\text{Prev High}, R1)$ and Volume $\ge 2.0 \times \text{AvgVol}_{20D}$
3. **Liquidity Floor**: $\text{ADVCr} = \frac{\text{AvgVol}_{20D} \times 75 \times \text{Close}}{10,000,000} \ge \text{₹10 Cr}$
4. **Price Cap**: $\text{Stock Price} \le \text{₹3,000}$
