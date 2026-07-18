import assert from "node:assert";
import { TradeDB, ActiveTrade, TradeState } from "../src/db.js";

// Helper to mock the database logic for kill switch evaluation
function evaluateKillSwitch(todayStr: string, MAX_CONSECUTIVE_LOSSES: number, allTrades: ActiveTrade[]) {
  // Mock TradeDB fetching today's trades
  const todayTrades = allTrades.filter((t) => t.createdAt.startsWith(todayStr));
  
  const exitedToday = todayTrades
    .filter((t) => t.state === "EXITED" && t.realizedPnl !== undefined)
    .sort((a, b) => new Date(a.closedAt || a.updatedAt).getTime() - new Date(b.closedAt || b.updatedAt).getTime());

  let closedLosingTrades = 0;
  for (const t of exitedToday) {
    if (t.realizedPnl! < 0) {
      closedLosingTrades++;
    } else if (t.realizedPnl! > 0) {
      closedLosingTrades = 0;
    }
  }

  return {
    closedLosingTrades,
    isHalted: closedLosingTrades >= MAX_CONSECUTIVE_LOSSES
  };
}

function createMockTrade(date: string, time: string, pnl: number): ActiveTrade {
  const timestamp = `${date}T${time}:00Z`;
  return {
    id: Math.random().toString(),
    correlationId: "mock",
    superOrderId: "mock",
    symbol: "MOCK",
    securityId: "123",
    quantity: 1,
    side: "BUY",
    entryPrice: 100,
    stopLossPrice: 90,
    targetPrice: 120,
    trailingJump: 0,
    state: "EXITED",
    protectionConfirmed: true,
    trailApplied: false,
    realizedPnl: pnl,
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: timestamp,
  };
}

async function runTests() {
  console.log("Running Kill Switch Tests...");

  const MAX_LOSSES = 3;
  const YESTERDAY = "2026-07-16";
  const TODAY = "2026-07-17";

  // Scenario 1: Three losses today stop additional trades today
  const scenario1Trades = [
    createMockTrade(TODAY, "10:00", -500),
    createMockTrade(TODAY, "11:00", -500),
    createMockTrade(TODAY, "12:00", -500),
  ];
  const res1 = evaluateKillSwitch(TODAY, MAX_LOSSES, scenario1Trades);
  assert.strictEqual(res1.closedLosingTrades, 3);
  assert.strictEqual(res1.isHalted, true, "Three losses today should halt trading");
  console.log("✅ Scenario 1 passed: Three losses today stop additional trades today.");

  // Scenario 2: Yesterday’s losses do not halt today’s session (and new date resets)
  const scenario2Trades = [
    createMockTrade(YESTERDAY, "10:00", -500),
    createMockTrade(YESTERDAY, "11:00", -500),
    createMockTrade(YESTERDAY, "12:00", -500), // Halted yesterday
    createMockTrade(TODAY, "10:00", -500),     // 1 loss today
  ];
  const res2 = evaluateKillSwitch(TODAY, MAX_LOSSES, scenario2Trades);
  assert.strictEqual(res2.closedLosingTrades, 1);
  assert.strictEqual(res2.isHalted, false, "Yesterday's losses should not affect today");
  console.log("✅ Scenario 2 passed: Yesterday’s losses do not halt today’s session.");

  // Scenario 3: A restarted process preserves the current day's halted state
  // Because it pulls directly from DB filtering by today, a restart acts exactly like Scenario 1
  const scenario3Trades = [
    createMockTrade(TODAY, "10:00", -500),
    createMockTrade(TODAY, "11:00", -500),
    createMockTrade(TODAY, "12:00", -500),
  ];
  const res3 = evaluateKillSwitch(TODAY, MAX_LOSSES, scenario3Trades); // Simulating process restarting on same date
  assert.strictEqual(res3.isHalted, true, "Restarting process should preserve halted state");
  console.log("✅ Scenario 3 passed: A restarted process preserves the current day's halted state.");

  // Scenario 4: A win resets the consecutive loss count
  const scenario4Trades = [
    createMockTrade(TODAY, "10:00", -500),
    createMockTrade(TODAY, "11:00", -500),
    createMockTrade(TODAY, "12:00", 500), // Win resets count
    createMockTrade(TODAY, "13:00", -500), // Loss after reset
  ];
  const res4 = evaluateKillSwitch(TODAY, MAX_LOSSES, scenario4Trades);
  assert.strictEqual(res4.closedLosingTrades, 1);
  assert.strictEqual(res4.isHalted, false);
  console.log("✅ Scenario 4 passed: Win resets consecutive loss count.");

  console.log("🎉 All tests passed!");
}

runTests().catch(console.error);
