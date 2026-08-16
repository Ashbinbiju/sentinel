import assert from "node:assert";

// backtest-orb-fvg imports @workspace/db, which constructs a pg Pool at import
// time and throws without this. Nothing here ever connects.
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:5432/unused";

/** 5-min bar starting at the given IST hour:minute on 2026-08-14. */
function bar(h: number, m: number, o: number, hi: number, lo: number, c: number) {
  return { t: Math.floor(Date.UTC(2026, 7, 14, h, m) / 1000) - 330 * 60, o, h: hi, l: lo, c, v: 1000 };
}

// Opening range 09:15-09:30 -> high 105, low 100.
const openingRange = [
  bar(9, 15, 100, 105, 100, 102),
  bar(9, 20, 102, 104, 100, 100),
  bar(9, 25, 100, 103, 100, 101),
];

// 09:40 both closes above the OR high (prev close 103 was below) and prints a
// bullish FVG: its low 105 clears the 09:30 bar's high of 104.
const breakoutRun = [
  bar(9, 30, 101, 104, 101, 102),
  bar(9, 35, 102, 104.5, 102, 103),
  bar(9, 40, 103, 110, 105, 109),
];

async function runTests() {
  const { runSymbol } = await import("../src/backtest-orb-fvg.js");
  console.log("Running ORB+FVG port tests...");

  // 1. Breakout with a live FVG fires a long; stop is the opposite OR level.
  {
    const bars = [...openingRange, ...breakoutRun, bar(9, 45, 109, 110, 99, 101)];
    const [t, ...rest] = runSymbol("TEST", bars);
    assert.strictEqual(rest.length, 0, "should take exactly one trade");
    assert.strictEqual(t.side, "BUY");
    assert.strictEqual(t.entry, 109, "entry is the breakout bar's close");
    assert.strictEqual(t.sl, 100, "stop is the OR low");
    assert.strictEqual(t.risk, 9);
    assert.strictEqual(t.reason, "STOP");
    assert.strictEqual(Number(t.rMultiple.toFixed(4)), -1, "stop out is exactly -1R");
    console.log("✅ 1: breakout + FVG fires long, stops at OR low for -1R");
  }

  // 2. Same breakout, but the 09:40 low no longer clears the 09:30 high, so no
  //    FVG exists and the signal must be suppressed.
  {
    const bars = [
      ...openingRange,
      bar(9, 30, 101, 104, 101, 102),
      bar(9, 35, 102, 104.5, 102, 103),
      bar(9, 40, 103, 110, 103, 109), // low 103 < prior high 104 -> no gap
      bar(9, 45, 109, 110, 99, 101),
    ];
    assert.strictEqual(runSymbol("TEST", bars).length, 0, "no FVG means no trade");
    console.log("✅ 2: identical breakout without an FVG is rejected");
  }

  // 3. Runner reaches T3 (entry 109 + 3 x 9 risk = 136) and closes there.
  {
    const bars = [...openingRange, ...breakoutRun, bar(9, 45, 109, 140, 108, 138)];
    const [t] = runSymbol("TEST", bars);
    assert.strictEqual(t.reason, "T3");
    assert.strictEqual(t.exit, 136);
    assert.ok(t.hit1 && t.hit2 && t.hit3, "T1/T2/T3 should all be flagged");
    assert.strictEqual(Number(t.rMultiple.toFixed(4)), 3, "T3 is exactly +3R");
    console.log("✅ 3: runner to T3 books +3R and flags T1/T2/T3");
  }

  // 4. A bar touching BOTH the stop and T3 is scored as the stop, and flagged
  //    ambiguous. TradingView's indicator resolves this the other way.
  {
    const bars = [...openingRange, ...breakoutRun, bar(9, 45, 109, 140, 99, 120)];
    const [t] = runSymbol("TEST", bars);
    assert.strictEqual(t.reason, "STOP", "ambiguous bar must resolve pessimistically");
    assert.ok(t.ambiguous, "and be flagged for the caller");
    console.log("✅ 4: stop-and-target in one bar scores as the stop, flagged");
  }

  // 5. Only one long per day, even after the position closes.
  {
    const bars = [
      ...openingRange, ...breakoutRun,
      bar(9, 45, 109, 110, 99, 101),   // stopped out
      bar(9, 50, 101, 104, 100, 103),  // back below the OR high
      bar(9, 55, 103, 112, 106, 111),  // would re-trigger: closes above, has FVG
    ];
    assert.strictEqual(runSymbol("TEST", bars).length, 1, "max one long per day");
    console.log("✅ 5: second long on the same day is suppressed");
  }

  // 6. Breakouts before 09:30 are ignored - the range is not locked yet.
  {
    const bars = [
      bar(9, 15, 100, 105, 100, 102),
      bar(9, 20, 102, 104, 100, 100),
      bar(9, 25, 100, 130, 100, 128), // huge move inside the OR window
      bar(9, 30, 128, 129, 127, 128),
    ];
    assert.strictEqual(runSymbol("TEST", bars).length, 0, "no signals during the OR window");
    console.log("✅ 6: moves inside 09:15-09:30 never signal");
  }

  console.log("🎉 All ORB+FVG port tests passed!");
}

runTests().catch(e => { console.error(e); process.exit(1); });
