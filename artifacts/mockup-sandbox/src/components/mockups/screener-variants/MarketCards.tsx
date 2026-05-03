import React, { useState } from "react";

const INDICES = [
  { symbol: "NIFTY 50", ltp: 23997.55, change: -0.74 },
  { symbol: "GIFT NIFTY", ltp: 24310.5, change: 0.69 },
  { symbol: "BANKNIFTY", ltp: 54863.35, change: -0.98 },
  { symbol: "MIDCAP 100", ltp: 59784.85, change: -0.98 },
  { symbol: "SMLCAP 100", ltp: 18007.15, change: -1.12 },
];

const SECTORS = [
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
    name: "IT", fullName: "NIFTY IT", change: 0.37,
    stocks: [
      { symbol: "INFY", ltp: 1181.80, change: 1.21, vwap: true, ema: true, entry: true },
      { symbol: "TECHM", ltp: 1473.50, change: 0.93, vwap: true, ema: true, entry: true },
      { symbol: "LTTS", ltp: 3626.30, change: 1.84, vwap: true, ema: true, entry: true },
      { symbol: "MPHASIS", ltp: 2276.70, change: 1.14, vwap: true, ema: false, entry: false },
      { symbol: "INTELLECT", ltp: 745.35, change: 0.75, vwap: true, ema: true, entry: true },
      { symbol: "ECLERX", ltp: 1429.00, change: 0.90, vwap: false, ema: false, entry: false },
    ],
  },
  {
    name: "Pharma", fullName: "NIFTY PHARMA", change: 0.03,
    stocks: [
      { symbol: "SUNPHARMA", ltp: 1808.30, change: 1.64, vwap: true, ema: true, entry: true },
      { symbol: "ALKEM", ltp: 5400.00, change: 1.04, vwap: true, ema: true, entry: true },
      { symbol: "AJANTPHA", ltp: 2822.70, change: 0.66, vwap: true, ema: true, entry: true },
      { symbol: "PPLPHAR", ltp: 161.87, change: 1.06, vwap: true, ema: true, entry: true },
      { symbol: "GLAND", ltp: 1750.80, change: 0.67, vwap: false, ema: false, entry: false },
    ],
  },
];

type Tab = "signals" | "sectors" | "indices";
const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtP = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2 });

export function MarketCards() {
  const [tab, setTab] = useState<Tab>("signals");

  return (
    <div className="min-h-screen bg-[#0b0b12] text-white flex flex-col" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Top header */}
      <header className="bg-[#0f0f1a] border-b border-white/5 px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-indigo-500 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <span className="font-bold text-sm tracking-tight">NSE Terminal</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20">◌ Apr 30 Session</span>
          <div className="text-xs text-white/40 font-mono hidden sm:block">15:02 IST</div>
        </div>
      </header>

      {/* Horizontal indices scroll */}
      <div className="flex gap-3 px-4 py-2 overflow-x-auto bg-[#0d0d18] border-b border-white/5 shrink-0">
        {INDICES.map((idx) => (
          <div key={idx.symbol} className="flex flex-col gap-0.5 min-w-[100px] shrink-0">
            <span className="text-[9px] text-white/30 uppercase tracking-wider">{idx.symbol}</span>
            <span className="text-sm font-semibold font-mono">{fmtP(idx.ltp)}</span>
            <span className={`text-[10px] font-medium ${idx.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(idx.change)}</span>
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pb-16 sm:pb-0">
        {tab === "signals" && (
          <div className="p-4 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">Momentum Picks</h2>
              <span className="text-[10px] text-white/30">Updated 15:02 IST · last candle 15:25</span>
            </div>
            {TOP_SECTORS.map((sector) => (
              <div key={sector.name} className="space-y-2">
                <div className="flex items-center gap-2 pb-1 border-b border-white/5">
                  <span className="text-xs font-bold text-white/80">{sector.fullName}</span>
                  <span className={`text-xs font-mono font-semibold ${sector.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(sector.change)}</span>
                  <span className="ml-auto text-[10px] text-white/20">{sector.stocks.length} stocks</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {sector.stocks.map((s) => (
                    <div
                      key={s.symbol}
                      className={`rounded-xl p-3 border transition-colors relative overflow-hidden ${
                        s.entry
                          ? "bg-indigo-500/5 border-indigo-500/30 shadow-[0_0_12px_rgba(99,102,241,0.1)]"
                          : "bg-white/[0.02] border-white/5"
                      }`}
                    >
                      {s.entry && (
                        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-indigo-400 to-transparent" />
                      )}
                      <div className="flex items-start justify-between mb-1.5">
                        <span className="font-bold text-sm">{s.symbol}</span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${s.change >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                          {fmt(s.change)}
                        </span>
                      </div>
                      <div className="text-xs text-white/40 mb-2">{fmtP(s.ltp)}</div>
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${s.vwap ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                          VWAP {s.vwap ? "↑" : "↓"}
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${s.ema ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                          EMA {s.ema ? "↑" : "↓"}
                        </span>
                        {s.entry && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-indigo-500/20 text-indigo-300">
                            ENTRY ✓
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "sectors" && (
          <div className="p-4 space-y-1">
            <h2 className="text-base font-bold mb-3">Sector Performance</h2>
            {SECTORS.map((s) => (
              <div key={s.name} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/5">
                <span className="text-sm font-medium">NIFTY {s.name}</span>
                <div className="flex items-center gap-3">
                  <div className="w-24 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${s.change >= 0 ? "bg-emerald-400" : "bg-red-400"}`}
                      style={{ width: `${Math.min(100, Math.abs(s.change) * 25)}%`, marginLeft: s.change < 0 ? "auto" : undefined }}
                    />
                  </div>
                  <span className={`text-sm font-mono font-semibold w-14 text-right ${s.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {fmt(s.change)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "indices" && (
          <div className="p-4 space-y-2">
            <h2 className="text-base font-bold mb-3">Market Indices</h2>
            {INDICES.map((idx) => (
              <div key={idx.symbol} className="flex items-center justify-between p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <div>
                  <div className="font-bold text-sm">{idx.symbol}</div>
                  <div className="text-xl font-mono font-semibold mt-0.5">{fmtP(idx.ltp)}</div>
                </div>
                <div className={`text-lg font-bold font-mono ${idx.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {fmt(idx.change)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mobile bottom nav */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-[#0f0f1a] border-t border-white/5 flex">
        {([
          { id: "signals", label: "Signals", icon: "⚡" },
          { id: "sectors", label: "Sectors", icon: "📊" },
          { id: "indices", label: "Indices", icon: "📈" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-3 text-[10px] transition-colors ${tab === t.id ? "text-indigo-400" : "text-white/30"}`}
          >
            <span className="text-base">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* Desktop top nav (sm+) */}
      <div className="hidden sm:flex border-t border-white/5 bg-[#0d0d18] shrink-0">
        {([
          { id: "signals", label: "⚡ Signals" },
          { id: "sectors", label: "📊 Sectors" },
          { id: "indices", label: "📈 Indices" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 text-xs border-t-2 transition-colors ${tab === t.id ? "border-indigo-500 text-indigo-400 bg-indigo-500/5" : "border-transparent text-white/30 hover:text-white/60"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
