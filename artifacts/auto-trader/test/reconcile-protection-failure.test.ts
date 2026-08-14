import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

// db.ts reads DATABASE_URL (via @workspace/db) and TRADE_STATE_PATH at import
// time, so both must be set before engine.js/db.js are imported below. Static
// imports would resolve before this runs, so we load dynamically instead.
dotenv.config({ path: "../../.env" });

const tmpDbPath = path.join(os.tmpdir(), `sentinel-test-trades-${Date.now()}.json`);
process.env.TRADE_STATE_PATH = tmpDbPath;
process.env.BOOTSTRAP_DB = "true";

// A symbol/date pair that can never match a real row, so markTradeClosed()'s
// (harmless, try/caught) Postgres write in Scenario 3 can only ever affect
// zero rows — never a real trade record.
const FAKE_SYMBOL = "ZZZTESTONLY";
const FAKE_CREATED_AT = "1999-01-01T00:00:00.000Z";

function seedTrade(overrides: Record<string, any> = {}) {
  return {
    id: "test-trade-1",
    correlationId: "corr-1",
    superOrderId: "so-1",
    symbol: FAKE_SYMBOL,
    securityId: "sec-1",
    quantity: 45,
    side: "BUY",
    entryPrice: 873.5,
    stopLossPrice: 864.75,
    targetPrice: 878.5,
    trailingJump: 0,
    state: "PROTECTION_CONFIRMED",
    protectionConfirmed: true,
    trailApplied: false,
    productType: "INTRADAY",
    createdAt: FAKE_CREATED_AT,
    updatedAt: FAKE_CREATED_AT,
    ...overrides,
  };
}

function writeTrades(trades: any[]) {
  fs.writeFileSync(tmpDbPath, JSON.stringify(trades, null, 2), "utf8");
}

function readTrades(): any[] {
  return JSON.parse(fs.readFileSync(tmpDbPath, "utf8"));
}

function makeMockBroker(opts: {
  netQty: number;
  legStatus: "TRIGGERED" | "TRADED";
  fills?: { transactionType: string; tradedPrice: number; tradedQuantity: number }[];
}) {
  return {
    async getPositions() {
      return [
        {
          securityId: "sec-1",
          tradingSymbol: FAKE_SYMBOL,
          productType: "INTRADAY",
          netQty: opts.netQty,
          buyAvg: 873.5,
          buyQty: 45,
          costPrice: 873.5,
          sellAvg: 0,
          sellQty: 0,
          realizedProfit: 0,
          unrealizedProfit: 0,
          dhanClientId: "x",
          positionType: opts.netQty >= 0 ? "LONG" : "SHORT",
          exchangeSegment: "NSE_EQ",
        },
      ];
    },
    async getSuperOrderList() {
      return [
        {
          orderId: "so-1",
          orderStatus: "CLOSED",
          tradingSymbol: FAKE_SYMBOL,
          securityId: "sec-1",
          transactionType: "BUY",
          exchangeSegment: "NSE_EQ",
          productType: "INTRADAY",
          orderType: "MARKET",
          quantity: 45,
          tradedQty: 0,
          price: 0,
          legDetails: [
            {
              orderId: "leg-sl-1",
              legName: "STOP_LOSS_LEG",
              orderStatus: opts.legStatus,
              price: 864.75,
              remainingQuantity: 45,
              triggeredQuantity: 0,
              trailingJump: 0,
            },
          ],
        },
      ];
    },
    async getTradesByOrderId() {
      return opts.fills ?? [];
    },
  };
}

async function runTests() {
  console.log("Running reconcileExits() protection-failure tests...");

  const { ExecutionEngine } = await import("../src/engine.js");

  // Scenario 1: leg triggered, position still open in the SAME direction,
  // seen for the first time -> watch, don't force an exit yet.
  writeTrades([seedTrade()]);
  {
    const engine = new ExecutionEngine(makeMockBroker({ netQty: 45, legStatus: "TRIGGERED" }) as any);
    await engine.reconcileExits();
    const [trade] = readTrades();
    assert.strictEqual(trade.state, "PROTECTION_CONFIRMED", "first sighting should not force an exit yet");
    assert.strictEqual(typeof trade.triggeredButOpenSinceMs, "number", "should stamp the first-seen time");
  }
  console.log("✅ Scenario 1 passed: first sighting watches, doesn't force exit.");

  // Scenario 2: same condition persists past the grace window -> forces exit.
  {
    const trades = readTrades();
    trades[0].triggeredButOpenSinceMs = Date.now() - 20_000; // simulate 20s elapsed
    writeTrades(trades);

    const engine = new ExecutionEngine(makeMockBroker({ netQty: 45, legStatus: "TRIGGERED" }) as any);
    await engine.reconcileExits();
    const [trade] = readTrades();
    assert.strictEqual(trade.state, "PROTECTION_FAILED_RECONCILIATION_REQUIRED", "should force exit after the grace window");
  }
  console.log("✅ Scenario 2 passed: persists past grace window -> forces market exit.");

  // Scenario 3: leg triggered, position actually flat -> normal close path
  // must still work, unaffected by the new branch.
  writeTrades([seedTrade()]);
  {
    const engine = new ExecutionEngine(makeMockBroker({
      netQty: 0,
      legStatus: "TRADED",
      fills: [{ transactionType: "SELL", tradedPrice: 864.75, tradedQuantity: 45 }],
    }) as any);
    await engine.reconcileExits();
    const [trade] = readTrades();
    assert.strictEqual(trade.state, "EXITED", "flat position should still close normally");
  }
  console.log("✅ Scenario 3 passed: flat position still closes normally.");

  // Scenario 4: leg triggered, position REVERSED (opposite sign) -> must hit
  // the existing reversal branch, not the new protection-failure branch.
  writeTrades([seedTrade()]);
  {
    const engine = new ExecutionEngine(makeMockBroker({ netQty: -45, legStatus: "TRIGGERED" }) as any);
    await engine.reconcileExits();
    const [trade] = readTrades();
    assert.strictEqual(trade.state, "REVERSAL_RECONCILIATION_REQUIRED", "reversed position should still use the existing reversal path");
  }
  console.log("✅ Scenario 4 passed: reversed position still uses the reversal path.");

  fs.rmSync(tmpDbPath, { force: true });
  console.log("🎉 All tests passed!");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
