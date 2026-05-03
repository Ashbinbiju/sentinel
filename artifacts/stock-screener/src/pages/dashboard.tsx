import React from "react";
import { Layout } from "@/components/layout";
import { Ticker } from "@/components/ticker";
import { StockCard } from "@/components/stock-card";
import { useGetSectors, getGetSectorsQueryKey, useGetMomentumPicks, getGetMomentumPicksQueryKey } from "@workspace/api-client-react";
import { formatPercent, getColorClass } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

function toISTDisplay(isoUtc: string): string {
  try {
    return new Date(isoUtc).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " IST";
  } catch {
    return "";
  }
}

function formatSessionDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return dateStr;
  }
}

export default function Dashboard() {
  const { data: sectorsData, isLoading: isLoadingSectors } = useGetSectors({
    query: { refetchInterval: 30000, queryKey: getGetSectorsQueryKey() }
  });

  const { data: momentumData, isLoading: isLoadingMomentum } = useGetMomentumPicks({
    query: { refetchInterval: 30000, queryKey: getGetMomentumPicksQueryKey() }
  });

  const sessionLabel = momentumData?.indicatorDate
    ? momentumData.isLiveSession
      ? "Live Today"
      : formatSessionDate(momentumData.indicatorDate)
    : null;

  const lastCandleIST = momentumData?.lastCandleTimeIST
    ? momentumData.lastCandleTimeIST + " IST"
    : null;

  const updatedIST = momentumData?.fetchedAt ? toISTDisplay(momentumData.fetchedAt) : null;

  return (
    <Layout>
      <Ticker />
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="flex flex-col md:flex-row gap-6">
          {/* Main Content */}
          <div className="flex-1 space-y-6">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2 className="text-2xl font-bold tracking-tight">Momentum Screener</h2>

              {!isLoadingMomentum && sessionLabel && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                      momentumData?.isLiveSession
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                        : "bg-amber-500/15 text-amber-400 border-amber-500/40"
                    }`}
                  >
                    {momentumData?.isLiveSession ? "● " : "◌ "}{sessionLabel}
                  </span>
                  {lastCandleIST && (
                    <span className="text-xs text-muted-foreground font-mono">
                      last candle {lastCandleIST}
                    </span>
                  )}
                  {updatedIST && (
                    <span className="text-xs text-muted-foreground">
                      · refreshed {updatedIST}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* EMA20 note when session is live but early */}
            {!isLoadingMomentum && momentumData?.isLiveSession && (
              <p className="text-xs text-muted-foreground -mt-3">
                VWAP fires from the 2nd candle (9:20 AM IST) · EMA20 needs 20 candles (~11:00 AM IST)
              </p>
            )}

            {isLoadingMomentum ? (
              <div className="space-y-6">
                {[1, 2].map(i => (
                  <div key={i} className="space-y-3">
                    <Skeleton className="h-8 w-48" />
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {[1, 2, 3, 4, 5].map(j => <Skeleton key={j} className="h-24 w-full" />)}
                    </div>
                  </div>
                ))}
              </div>
            ) : momentumData?.sectors.length === 0 ? (
              <div className="p-12 text-center border border-border rounded-lg bg-card/50 text-muted-foreground">
                No momentum stocks found in the current market window.
              </div>
            ) : (
              <div className="space-y-8">
                {momentumData?.sectors.map((sector) => (
                  <div key={sector.sectorKeyword} className="space-y-3">
                    <div className="flex items-baseline space-x-3 border-b border-border/50 pb-2">
                      <h3 className="text-lg font-semibold">{sector.sectorName}</h3>
                      <span className={`text-sm font-mono font-medium ${getColorClass(sector.sectorChangePct)}`}>
                        {formatPercent(sector.sectorChangePct)}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {sector.stocks.length} stocks
                      </span>
                    </div>
                    {sector.stocks.length > 0 ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                        {sector.stocks.map(stock => (
                          <StockCard key={stock.symbol} stock={stock} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No stocks matched criteria in this sector.</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="w-full md:w-80 shrink-0 space-y-6">
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="p-3 border-b border-border bg-muted/30">
                <h3 className="font-semibold text-sm">Sector Performance</h3>
              </div>
              <div className="p-0">
                {isLoadingSectors ? (
                  <div className="space-y-2 p-3">
                    {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-8 w-full" />)}
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {sectorsData?.map(sector => (
                      <div key={sector.keyword} className="flex justify-between items-center p-3 text-sm hover:bg-accent/30 transition-colors">
                        <span className="font-medium">{sector.name}</span>
                        <span className={`font-mono ${getColorClass(sector.changePct)}`}>
                          {formatPercent(sector.changePct)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* IST Clock */}
            <ISTClock />
          </div>
        </div>
      </div>
    </Layout>
  );
}

function ISTClock() {
  const [time, setTime] = React.useState(() => getNowIST());

  React.useEffect(() => {
    const id = setInterval(() => setTime(getNowIST()), 1000);
    return () => clearInterval(id);
  }, []);

  const isMarketHours =
    time.h * 60 + time.m >= 9 * 60 + 15 &&
    time.h * 60 + time.m < 15 * 60 + 30;

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">India Time</p>
      <p className="font-mono text-2xl font-bold tracking-widest">
        {String(time.h).padStart(2, "0")}:{String(time.m).padStart(2, "0")}:{String(time.s).padStart(2, "0")}
      </p>
      <p className={`text-xs font-medium ${isMarketHours ? "text-emerald-400" : "text-muted-foreground"}`}>
        {isMarketHours ? "● Market Open" : "◌ Market Closed"}
      </p>
      {isMarketHours && (
        <p className="text-[10px] text-muted-foreground">NSE · 9:15 – 15:30 IST</p>
      )}
    </div>
  );
}

function getNowIST(): { h: number; m: number; s: number } {
  const now = new Date(Date.now() + 19800000); // +5:30
  return {
    h: now.getUTCHours(),
    m: now.getUTCMinutes(),
    s: now.getUTCSeconds(),
  };
}
