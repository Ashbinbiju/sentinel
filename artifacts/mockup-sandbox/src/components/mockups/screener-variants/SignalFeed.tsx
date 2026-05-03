import React, { useState } from "react";

const INDICES = [
  { symbol: "NIFTY 50", ltp: 23997.55, change: -0.74 },
  { symbol: "GIFT NIFTY", ltp: 24310.5, change: 0.69 },
  { symbol: "BANKNIFTY", ltp: 54863.35, change: -0.98 },
  { symbol: "MIDCAP 100", ltp: 59784.85, change: -0.98 },
];

const SECTORS_SIDEBAR = [
  { name: "IT", change: 0.37 },
  { name: "Pharma", change: 0.03 },
  { name: "Healthcare", change: -0.15 },
  { name: "Energy", change: -0.46 },
  { name: "Media", change: -0.52 },
  { name: "Oil & Gas", change: -0.63 },
  { name: "Auto", change: -0.64 },
  { name: "Pvt Bank", change: -0.88 },
  { name: "Bank", change: -0.98 },
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
      { symbol: "KPITTECH", ltp: 759.05, change: 2.50, vwap: false, ema: false, entry: false },
    ],
  },
  {
    name: "NIFTY PHARMA", change: 0.03,
    stocks: [
      { symbol: "SUNPHARMA", ltp: 1808.30, change: 1.64, vwap: true, ema: true, entry: true },
      { symbol: "ALKEM", ltp: 5400.00, change: 1.04, vwap: true, ema: true, entry: true },
      { symbol: "AJANTPHA", ltp: 2822.70, change: 0.66, vwap: true, ema: true, entry: true },
      { symbol: "PPLPHAR", ltp: 161.87, change: 1.06, vwap: true, ema: true, entry: true },
      { symbol: "GLAND", ltp: 1750.80, change: 0.67, vwap: false, ema: false, entry: false },
      { symbol: "SOLARA", ltp: 422.00, change: 1.02, vwap: false, ema: false, entry: false },
      { symbol: "AARTIDRUGS", ltp: 512.40, change: 0.78, vwap: false, ema: false, entry: false },
    ],
  },
];

const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtP = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2 });

type View = "all" | "entry";

export function SignalFeed() {
  const [view, setView] = useState<View>("all");

  const filteredSectors = TOP_SECTORS.map((s) => ({
    ...s,
    stocks: view === "entry" ? s.stocks.filter((st) => st.entry) : s.stocks,
  }));

  return (
    <div className="min-h-screen bg-[#080810] text-white flex flex-col" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Navbar */}
      <nav className="sticky top-0 z-10 bg-[#080810]/90 backdrop-blur border-b border-white/[0.06] px-4 sm:px-6 py-3 flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-2 mr-auto">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <span className="font-bold text-sm hidden sm:block">NSE Screener</span>
        </div>

        {/* Indices pill row */}
        <div className="flex gap-2 overflow-x-auto">
          {INDICES.map((idx) => (
            <div key={idx.symbol} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06] shrink-0">
              <span className="text-[10px] text-white/40 hidden sm:block">{idx.symbol}</span>
              <span className={`text-[11px] font-bold font-mono ${idx.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(idx.change)}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className="px-2 py-1 rounded-md text-[10px] bg-amber-500/10 text-amber-400 border border-amber-400/20 hidden sm:block">◌ Apr 30</span>
        </div>
      </nav>

      <div className="flex flex-1">
        {/* Sidebar (desktop only) */}
        <aside className="hidden lg:flex w-52 flex-col border-r border-white/[0.06] bg-[#0a0a14] shrink-0">
          <div className="p-4 border-b border-white/[0.06]">
            <div className="text-[10px] text-white/30 uppercase tracking-widest mb-2">IST Clock</div>
            <div className="font-mono text-xl font-bold text-white">15:02:34</div>
            <div className="text-[10px] text-white/30 mt-0.5">Market Closed · NSE</div>
          </div>
          <div className="p-4 border-b border-white/[0.06]">
            <div className="text-[10px] text-white/30 uppercase tracking-widest mb-2">Session</div>
            <div className="text-xs text-amber-400">◌ Apr 30, 2026</div>
            <div className="text-[10px] text-white/30 mt-1">Last candle 15:25 IST</div>
          </div>
          <div className="p-3 flex-1 space-y-px">
            {SECTORS_SIDEBAR.map((s) => (
              <div key={s.name} className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors">
                <span className="text-[11px] text-white/50">{s.name}</span>
                <span className={`text-[11px] font-mono font-semibold ${s.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(s.change)}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* Main feed */}
        <main className="flex-1 overflow-y-auto">
          {/* Filter bar */}
          <div className="sticky top-0 z-[5] bg-[#080810]/90 backdrop-blur border-b border-white/[0.06] px-4 sm:px-6 py-2 flex items-center gap-3">
            <span className="text-xs text-white/30">Show:</span>
            <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
              {(["all", "entry"] as View[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors ${view === v ? "bg-violet-500 text-white" : "text-white/40 hover:text-white/60"}`}
                >
                  {v === "all" ? "All Stocks" : "Entry Signals Only"}
                </button>
              ))}
            </div>
            <span className="ml-auto text-[10px] text-white/20 hidden sm:block">Refreshed 15:02 IST</span>
          </div>

          <div className="p-4 sm:p-6 space-y-8">
            {filteredSectors.map((sector) => (
              <section key={sector.name}>
                {/* Sector header */}
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-1 h-8 rounded-full ${sector.change >= 0 ? "bg-emerald-500" : "bg-red-500"}`} />
                  <div>
                    <h3 className="font-bold text-base">{sector.name}</h3>
                    <span className={`text-sm font-mono font-semibold ${sector.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(sector.change)}</span>
                  </div>
                  <span className="ml-auto text-xs text-white/20">{sector.stocks.length} stocks</span>
                </div>

                {/* Stock rows */}
                <div className="rounded-xl border border-white/[0.06] overflow-hidden divide-y divide-white/[0.04]">
                  {sector.stocks.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-white/30">No entry signals in this sector</div>
                  ) : sector.stocks.map((s, i) => (
                    <div
                      key={s.symbol}
                      className={`flex items-center gap-3 sm:gap-4 px-4 py-3 transition-colors ${s.entry ? "bg-violet-500/[0.04] hover:bg-violet-500/[0.07]" : "hover:bg-white/[0.02]"}`}
                    >
                      {/* Rank */}
                      <span className="text-[10px] text-white/15 w-4 shrink-0 text-right">{i + 1}</span>

                      {/* Symbol */}
                      <div className="min-w-[80px] sm:min-w-[100px]">
                        <div className="font-bold text-sm">{s.symbol}</div>
                        <div className="text-[10px] text-white/30 font-mono">{fmtP(s.ltp)}</div>
                      </div>

                      {/* Change bar */}
                      <div className="flex-1 hidden sm:flex items-center gap-2">
                        <div className="w-20 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                          <div
                            className={`h-full rounded-full ${s.change >= 0 ? "bg-emerald-400" : "bg-red-400"}`}
                            style={{ width: `${Math.min(100, (s.change / 3) * 100)}%` }}
                          />
                        </div>
                      </div>

                      {/* Change % */}
                      <span className={`text-sm font-mono font-bold w-14 text-right shrink-0 ${s.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {fmt(s.change)}
                      </span>

                      {/* Indicators */}
                      <div className="flex gap-1 shrink-0">
                        <span className={`text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded font-mono ${s.vwap ? "text-emerald-400 bg-emerald-400/10" : "text-red-400 bg-red-400/10"}`}>
                          V{s.vwap ? "↑" : "↓"}
                        </span>
                        <span className={`text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded font-mono ${s.ema ? "text-emerald-400 bg-emerald-400/10" : "text-red-400 bg-red-400/10"}`}>
                          E{s.ema ? "↑" : "↓"}
                        </span>
                      </div>

                      {/* Entry signal */}
                      <div className="w-14 sm:w-20 text-right shrink-0">
                        {s.entry ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/20 text-violet-300 border border-violet-400/20">
                            ENTRY
                          </span>
                        ) : (
                          <span className="text-[10px] text-white/10">—</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
