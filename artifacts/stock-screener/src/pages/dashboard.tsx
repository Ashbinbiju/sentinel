import React, { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import { Ticker } from "@/components/ticker";
import { StockCard } from "@/components/stock-card";
import {
  useGetSectors,
  getGetSectorsQueryKey,
  useGetMomentumPicks,
  getGetMomentumPicksQueryKey,
  type TopPick,
} from "@workspace/api-client-react";
import { formatPercent, getColorClass, formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, Target, ShieldAlert, Clock, Zap, ChevronRight } from "lucide-react";

// ── Formatting helpers ───────────────────────────────────────────────────────

function cleanSectorName(name: string): string {
  return name
    .replace(/^NIFTY[_ ]/, "")
    .replace(/_/g, " ")
    .replace(/\bPVT\b/, "Pvt")
    .replace(/\bFIN\b/, "Fin")
    .replace(/\bSERVICE\b/, "Service")
    .replace(/\bFMCG\b/, "FMCG")
    .replace(/\bAUTO\b/, "Auto")
    .replace(/\bBANK\b/, "Bank")
    .replace(/\bMEDIA\b/, "Media")
    .replace(/\bENERGY\b/, "Energy")
    .replace(/\bIT\b/, "IT")
    .replace(/\bPHARMA\b/, "Pharma")
    .replace(/\bHEALTHCARE\b/, "Healthcare")
    .replace(/\bCONSUMPTION\b/, "Consumption")
    .replace(/\bOIL AND GAS\b/, "Oil & Gas")
    .trim();
}

// ── IST helpers ──────────────────────────────────────────────────────────────

function getNowIST() {
  const now = new Date(Date.now() + 19800000);
  return { h: now.getUTCHours(), m: now.getUTCMinutes(), s: now.getUTCSeconds() };
}

function toISTDisplay(isoUtc: string): string {
  try {
    return (
      new Date(isoUtc).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " IST"
    );
  } catch {
    return "";
  }
}

function formatSessionDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch {
    return dateStr;
  }
}

// ── IST Live Clock ────────────────────────────────────────────────────────────

function ISTClock() {
  const [t, setT] = useState(getNowIST);
  useEffect(() => {
    const id = setInterval(() => setT(getNowIST()), 1000);
    return () => clearInterval(id);
  }, []);
  const mins = t.h * 60 + t.m;
  const open = mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full ${open ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/30"}`} />
      <span className="font-mono text-sm font-medium tabular-nums text-foreground/80">
        {String(t.h).padStart(2, "0")}:{String(t.m).padStart(2, "0")} IST
      </span>
      <span className={`text-xs ${open ? "text-emerald-400" : "text-muted-foreground"}`}>
        {open ? "Market Open" : "Closed"}
      </span>
    </div>
  );
}

// ── Top 5 Pick Card ──────────────────────────────────────────────────────────

function TopPickCard({ pick, rank }: { pick: TopPick; rank: number }) {
  const href = `https://www.tradingview.com/chart/?symbol=NSE%3A${pick.symbol}`;
  const riskAmt = pick.entry - pick.sl;
  const t1Pct = ((pick.target1 - pick.entry) / pick.entry) * 100;
  const t2Pct = ((pick.target2 - pick.entry) / pick.entry) * 100;

  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="block shrink-0 w-[240px] sm:w-[260px] group">
      <div className="relative rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/40 via-card to-card overflow-hidden hover:border-emerald-400/40 transition-all duration-200 shadow-[0_0_20px_rgba(16,185,129,0.06)]">
        {/* Top accent bar */}
        <div className="h-0.5 bg-gradient-to-r from-emerald-500/60 via-emerald-400 to-emerald-500/60" />

        <div className="p-4">
          {/* Rank + symbol + sector */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                {rank}
              </span>
              <div>
                <div className="font-bold text-base text-foreground leading-none">{pick.symbol}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{cleanSectorName(pick.sectorName)}</div>
              </div>
            </div>
            <span className={`text-sm font-mono font-bold px-2 py-0.5 rounded ${pick.changePct >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
              {formatPercent(pick.changePct)}
            </span>
          </div>

          {/* Entry price */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Entry</div>
            <div className="font-mono text-lg font-bold text-foreground">₹{pick.entry.toFixed(2)}</div>
          </div>

          {/* SL / T1 / T2 grid */}
          <div className="grid grid-cols-3 gap-1.5 mb-3">
            <div className="flex flex-col gap-0.5 bg-rose-500/10 rounded-lg px-2 py-1.5 border border-rose-500/15">
              <div className="flex items-center gap-1">
                <ShieldAlert className="w-2.5 h-2.5 text-rose-400/70" />
                <span className="text-[9px] text-rose-400/70 font-semibold uppercase tracking-wide">SL</span>
              </div>
              <span className="font-mono text-xs font-bold text-rose-300">₹{pick.sl.toFixed(1)}</span>
              <span className="text-[8px] text-rose-400/50">-{pick.riskPct.toFixed(1)}%</span>
            </div>
            <div className="flex flex-col gap-0.5 bg-emerald-500/10 rounded-lg px-2 py-1.5 border border-emerald-500/15">
              <div className="flex items-center gap-1">
                <Target className="w-2.5 h-2.5 text-emerald-400/70" />
                <span className="text-[9px] text-emerald-400/70 font-semibold uppercase tracking-wide">T1</span>
              </div>
              <span className="font-mono text-xs font-bold text-emerald-300">₹{pick.target1.toFixed(1)}</span>
              <span className="text-[8px] text-emerald-400/50">+{t1Pct.toFixed(1)}%</span>
            </div>
            <div className="flex flex-col gap-0.5 bg-emerald-500/15 rounded-lg px-2 py-1.5 border border-emerald-500/20">
              <div className="flex items-center gap-1">
                <TrendingUp className="w-2.5 h-2.5 text-emerald-400/70" />
                <span className="text-[9px] text-emerald-400/70 font-semibold uppercase tracking-wide">T2</span>
              </div>
              <span className="font-mono text-xs font-bold text-emerald-300">₹{pick.target2.toFixed(1)}</span>
              <span className="text-[8px] text-emerald-400/50">+{t2Pct.toFixed(1)}%</span>
            </div>
          </div>

          {/* Smart exit rule */}
          <div className="bg-muted/20 rounded-lg p-2 border border-border/30">
            <div className="flex items-start gap-1.5">
              <Zap className="w-3 h-3 text-amber-400/70 shrink-0 mt-0.5" />
              <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">
                {pick.smartExit}
              </p>
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { data: sectorsData, isLoading: isLoadingSectors } = useGetSectors({
    query: { refetchInterval: 30000, queryKey: getGetSectorsQueryKey() },
  });

  const { data: momentumData, isLoading: isLoadingMomentum } = useGetMomentumPicks({
    query: { refetchInterval: 30000, queryKey: getGetMomentumPicksQueryKey() },
  });

  const sessionLabel = momentumData?.indicatorDate
    ? momentumData.isLiveSession
      ? "Live Today"
      : formatSessionDate(momentumData.indicatorDate)
    : null;

  const updatedIST = momentumData?.fetchedAt ? toISTDisplay(momentumData.fetchedAt) : null;
  const topPicks = momentumData?.topPicks ?? [];
  const hasTopPicks = topPicks.length > 0;

  return (
    <Layout>
      <Ticker />

      {/* ── Top bar: session info + IST clock ── */}
      <div className="border-b border-border/30 bg-background/80 backdrop-blur-sm px-4 py-2 flex items-center gap-4 flex-wrap">
        <ISTClock />
        {sessionLabel && !isLoadingMomentum && (
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
            momentumData?.isLiveSession
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
              : "bg-amber-500/10 text-amber-400 border-amber-500/30"
          }`}>
            {momentumData?.isLiveSession ? "● " : "◌ "}{sessionLabel}
          </span>
        )}
        {momentumData?.lastCandleTimeIST && !isLoadingMomentum && (
          <span className="text-xs text-muted-foreground font-mono">
            last candle {momentumData.lastCandleTimeIST} IST
          </span>
        )}
        {updatedIST && !isLoadingMomentum && (
          <span className="text-xs text-muted-foreground ml-auto hidden sm:block">
            refreshed {updatedIST}
          </span>
        )}
      </div>

      {/* ── Top 5 Intraday Picks ── */}
      <div className="border-b border-border/30 bg-gradient-to-r from-emerald-950/20 via-background to-background">
        <div className="px-4 pt-4 pb-1 flex items-center gap-2">
          <Zap className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-400">Top 5 Intraday Picks</h2>
        </div>

        {isLoadingMomentum ? (
          <div className="flex gap-3 px-4 pb-4 overflow-x-auto">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="w-[240px] h-[220px] shrink-0 rounded-xl" />
            ))}
          </div>
        ) : hasTopPicks ? (
          <div className="flex gap-3 px-4 pb-4 overflow-x-auto">
            {topPicks.map((pick, i) => (
              <TopPickCard key={pick.symbol} pick={pick} rank={i + 1} />
            ))}
          </div>
        ) : (
          <div className="px-4 pb-4">
            <div className="rounded-xl border border-border/30 bg-card/30 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {momentumData?.isLiveSession
                  ? "No entry signals yet — VWAP+EMA20 both need to align above the close. EMA20 requires 20 candles (~11:00 AM IST)."
                  : "Showing last session's signals. Top picks appear once VWAP and EMA20 align."}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Main content: sectors + sidebar ── */}
      <div className="px-4 py-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Sectors + stocks */}
          <div className="flex-1 min-w-0 space-y-6">
            <h2 className="text-lg font-bold tracking-tight text-foreground">Momentum Screener</h2>

            {isLoadingMomentum ? (
              <div className="space-y-6">
                {[1, 2].map((i) => (
                  <div key={i} className="space-y-3">
                    <Skeleton className="h-7 w-40" />
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                      {[1, 2, 3, 4].map((j) => <Skeleton key={j} className="h-32 w-full rounded-xl" />)}
                    </div>
                  </div>
                ))}
              </div>
            ) : momentumData?.sectors.length === 0 ? (
              <div className="p-12 text-center border border-border/30 rounded-xl bg-card/30 text-muted-foreground">
                No momentum stocks found in the current market window.
              </div>
            ) : (
              <div className="space-y-8">
                {momentumData?.sectors.map((sector) => (
                  <div key={sector.sectorKeyword}>
                    {(() => {
                      const entryStocks = sector.stocks.filter((s) => s.entrySignal === true);
                      return (<>
                    <div className="flex items-center gap-3 mb-3 pb-2 border-b border-border/30">
                      <div className={`w-1 h-5 rounded-full ${sector.sectorChangePct >= 0 ? "bg-emerald-500" : "bg-rose-500"}`} />
                      <h3 className="font-bold text-foreground">{cleanSectorName(sector.sectorName)}</h3>
                      <span className={`text-sm font-mono font-semibold ${getColorClass(sector.sectorChangePct)}`}>
                        {formatPercent(sector.sectorChangePct)}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {entryStocks.length} signal{entryStocks.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {(() => {
                      return entryStocks.length > 0 ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                          {entryStocks.map((stock) => (
                            <StockCard key={stock.symbol} stock={stock} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">
                          No entry signals in this sector yet.
                        </p>
                      );
                    })()}
                    </>); })()}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="w-full lg:w-72 shrink-0 space-y-4">
            {/* Sector Performance */}
            <div className="rounded-xl border border-border/40 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30 bg-muted/20 flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
                <h3 className="font-semibold text-sm">Sector Performance</h3>
              </div>
              <div className="divide-y divide-border/20">
                {isLoadingSectors ? (
                  <div className="space-y-2 p-3">
                    {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                  </div>
                ) : (
                  sectorsData
                    ?.filter((s, i, arr) => arr.findIndex((x) => x.keyword === s.keyword) === i)
                    .map((sector) => (
                    <div key={sector.keyword} className="flex items-center justify-between px-4 py-2.5 hover:bg-accent/20 transition-colors">
                      <span className="text-sm text-foreground/80">{cleanSectorName(sector.name)}</span>
                      <span className={`text-sm font-mono font-semibold ${getColorClass(sector.changePct)}`}>
                        {formatPercent(sector.changePct)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Smart Exit Legend */}
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Smart Exit Rules</span>
              </div>
              <div className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
                <p>• Exit if any 5-min candle closes <span className="text-foreground/70 font-medium">below VWAP</span></p>
                <p>• At T1, move SL to <span className="text-foreground/70 font-medium">breakeven</span> (entry price)</p>
                <p>• Book full at T2 or exit by <span className="text-foreground/70 font-medium">15:15 IST</span></p>
                <p>• SL is set <span className="text-foreground/70 font-medium">0.4% below VWAP</span> support</p>
              </div>
            </div>

            {/* Signal legend */}
            <div className="rounded-xl border border-border/30 bg-card p-4 space-y-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Signal Key</span>
              <div className="space-y-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/25 font-mono">VWAP ↑</span>
                  <span>Close above VWAP</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/25 font-mono">EMA ↑</span>
                  <span>Close above EMA20</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-[9px] px-2">ENTRY</span>
                  <span>Both aligned — trade setup</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
