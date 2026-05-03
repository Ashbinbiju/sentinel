import React, { useState } from "react";

const SECTORS = [
  { name: "NIFTY IT", keyword: "NIFTY_IT", change: 0.37 },
  { name: "NIFTY PHARMA", keyword: "NIFTY_PHARMA", change: 0.03 },
  { name: "NIFTY HEALTHCARE", keyword: "NIFTY_HEALTHCARE", change: -0.15 },
  { name: "NIFTY ENERGY", keyword: "NIFTY_ENERGY", change: -0.46 },
  { name: "NIFTY MEDIA", keyword: "NIFTY_MEDIA", change: -0.52 },
  { name: "NIFTY OIL & GAS", keyword: "NIFTY_OIL_AND_GAS", change: -0.63 },
  { name: "NIFTY AUTO", keyword: "NIFTY_AUTO", change: -0.64 },
  { name: "NIFTY PVT BANK", keyword: "NIFTY_PVT_BANK", change: -0.88 },
  { name: "NIFTY BANK", keyword: "NIFTY_BANK", change: -0.98 },
];

const INDICES = [
  { symbol: "NIFTY 50", ltp: 23997.55, change: -0.74 },
  { symbol: "GIFT NIFTY", ltp: 24310.5, change: 0.69 },
  { symbol: "NIFTY BANK", ltp: 54863.35, change: -0.98 },
  { symbol: "NIFTY MIDCAP 100", ltp: 59784.85, change: -0.98 },
  { symbol: "NIFTY SMLCAP 100", ltp: 18007.15, change: -1.12 },
];

const TOP_SECTORS = [
  {
    name: "NIFTY IT", change: 0.37,
    stocks: [
      { symbol: "INFY", ltp: 1181.80, change: 1.21, vwap: true, ema: true, entry: true },
      { symbol: "TECHM", ltp: 1473.50, change: 0.93, vwap: true, ema: true, entry: true },
      { symbol: "LTTS", ltp: 3626.30, change: 1.84, vwap: true, ema: true, entry: true },
      { symbol: "MPHASIS", ltp: 2276.70, change: 1.14, vwap: true, ema: false, entry: false },
      { symbol: "INTELLECT", ltp: 745.35, change: 0.75, vwap: true, ema: true, entry: true },
      { symbol: "ECLERX", ltp: 1429.00, change: 0.90, vwap: false, ema: false, entry: false },
      { symbol: "OFSS", ltp: 9726.50, change: 0.40, vwap: false, ema: false, entry: false },
      { symbol: "HAPPST", ltp: 373.10, change: 0.47, vwap: false, ema: false, entry: false },
      { symbol: "KPITTECH", ltp: 759.05, change: 2.50, vwap: false, ema: false, entry: false },
    ],
  },
  {
    name: "NIFTY PHARMA", change: 0.03,
    stocks: [
      { symbol: "SUNPHA", ltp: 1808.30, change: 1.64, vwap: true, ema: true, entry: true },
      { symbol: "ALKEM", ltp: 5400.00, change: 1.04, vwap: true, ema: true, entry: true },
      { symbol: "AJANTPHA", ltp: 2822.70, change: 0.66, vwap: true, ema: true, entry: true },
      { symbol: "PPLPHAR", ltp: 161.87, change: 1.06, vwap: true, ema: true, entry: true },
      { symbol: "GLAND", ltp: 1750.80, change: 0.67, vwap: false, ema: false, entry: false },
      { symbol: "SOLARA", ltp: 422.00, change: 1.02, vwap: false, ema: false, entry: false },
    ],
  },
];

const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtPrice = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2 });

export function ProTerminal() {
  const [activeTab, setActiveTab] = useState(0);
  const sector = TOP_SECTORS[activeTab];

  return (
    <div className="min-h-screen bg-[#06060a] text-[#c8ccd4] font-mono text-xs flex flex-col select-none">
      {/* Ticker bar */}
      <div className="flex gap-0 bg-[#0d0d14] border-b border-[#1e1e2a] overflow-x-auto shrink-0">
        {INDICES.map((idx) => (
          <div key={idx.symbol} className="flex items-center gap-2 px-4 py-1.5 border-r border-[#1e1e2a] whitespace-nowrap shrink-0">
            <span className="text-[#6b7280] text-[10px] uppercase tracking-wide">{idx.symbol}</span>
            <span className="text-[#e2e8f0] font-semibold">{fmtPrice(idx.ltp)}</span>
            <span className={idx.change >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
              {fmt(idx.change)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-52 bg-[#09090f] border-r border-[#1e1e2a] flex flex-col shrink-0">
          {/* IST Clock */}
          <div className="p-3 border-b border-[#1e1e2a]">
            <div className="text-[10px] text-[#4b5563] uppercase tracking-wider mb-1">India Time</div>
            <div className="text-[#e2e8f0] text-lg font-bold tracking-widest">15:02:34</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#4b5563]" />
              <span className="text-[10px] text-[#4b5563]">Market Closed</span>
            </div>
          </div>

          {/* Session badge */}
          <div className="px-3 py-2 border-b border-[#1e1e2a]">
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">◌ 30 Apr</span>
            </div>
            <div className="text-[10px] text-[#4b5563] mt-1">Last candle 15:25 IST</div>
          </div>

          {/* Sector table */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] text-[#4b5563] uppercase tracking-wider border-b border-[#1e1e2a]">Sectors</div>
            {SECTORS.map((s) => (
              <div key={s.keyword} className="flex justify-between items-center px-3 py-1.5 hover:bg-[#111118] border-b border-[#1a1a22]">
                <span className="text-[#9ca3af] text-[10px]">{s.name.replace("NIFTY ", "")}</span>
                <span className={`text-[10px] font-semibold ${s.change >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {fmt(s.change)}
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* Main panel */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Sector tabs */}
          <div className="flex border-b border-[#1e1e2a] bg-[#09090f] shrink-0">
            {TOP_SECTORS.map((s, i) => (
              <button
                key={s.name}
                onClick={() => setActiveTab(i)}
                className={`px-4 py-2 text-[11px] border-r border-[#1e1e2a] transition-colors ${
                  activeTab === i
                    ? "bg-[#0f0f1a] text-[#e2e8f0] border-b-2 border-b-[#6366f1]"
                    : "text-[#6b7280] hover:text-[#9ca3af] hover:bg-[#0d0d14]"
                }`}
              >
                {s.name}
                <span className={`ml-2 ${s.change >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>{fmt(s.change)}</span>
              </button>
            ))}
          </div>

          {/* Table header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-0 px-4 py-2 text-[10px] text-[#4b5563] uppercase tracking-wider border-b border-[#1e1e2a] bg-[#09090f] shrink-0">
            <span>Symbol</span>
            <span className="w-24 text-right">LTP</span>
            <span className="w-16 text-right">Chg%</span>
            <span className="w-12 text-center">VWAP</span>
            <span className="w-12 text-center">EMA20</span>
            <span className="w-16 text-center">Signal</span>
          </div>

          {/* Table rows */}
          <div className="flex-1 overflow-y-auto">
            {sector.stocks.map((s) => (
              <div
                key={s.symbol}
                className={`grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-0 px-4 py-2 border-b border-[#111118] hover:bg-[#0d0d14] items-center transition-colors ${s.entry ? "border-l-2 border-l-[#6366f1]" : ""}`}
              >
                <span className="text-[#e2e8f0] font-semibold">{s.symbol}</span>
                <span className="w-24 text-right text-[#c8ccd4]">{fmtPrice(s.ltp)}</span>
                <span className={`w-16 text-right font-semibold ${s.change >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {fmt(s.change)}
                </span>
                <span className="w-12 text-center">
                  <span className={`text-[10px] px-1 py-0.5 rounded ${s.vwap ? "text-[#22c55e] bg-[#22c55e]/10" : "text-[#ef4444] bg-[#ef4444]/10"}`}>
                    {s.vwap ? "↑" : "↓"}
                  </span>
                </span>
                <span className="w-12 text-center">
                  <span className={`text-[10px] px-1 py-0.5 rounded ${s.ema ? "text-[#22c55e] bg-[#22c55e]/10" : "text-[#ef4444] bg-[#ef4444]/10"}`}>
                    {s.ema ? "↑" : "↓"}
                  </span>
                </span>
                <span className="w-16 text-center">
                  {s.entry ? (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-[#6366f1]/20 text-[#818cf8] border border-[#6366f1]/30 font-semibold">
                      ENTRY ✓
                    </span>
                  ) : (
                    <span className="text-[10px] text-[#374151]">—</span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-[#1e1e2a] bg-[#09090f] flex items-center justify-between shrink-0">
            <span className="text-[10px] text-[#4b5563]">{sector.stocks.length} stocks · refreshed 15:02 IST</span>
            <span className="text-[10px] text-[#4b5563]">VWAP+EMA20 signals from 5-min candles</span>
          </div>
        </main>
      </div>
    </div>
  );
}
