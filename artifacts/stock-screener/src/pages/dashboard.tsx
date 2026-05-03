import { Layout } from "@/components/layout";
import { Ticker } from "@/components/ticker";
import { StockCard } from "@/components/stock-card";
import { useGetSectors, getGetSectorsQueryKey, useGetMomentumPicks, getGetMomentumPicksQueryKey } from "@workspace/api-client-react";
import { formatPercent, getColorClass } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { useSavedPicks } from "@/hooks/use-saved-picks";
import { RefreshCw, Save, Check } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { saveTodayPicks, getTodayPicks } = useSavedPicks();
  const [isSaving, setIsSaving] = useState(false);

  const { data: sectorsData, isLoading: isLoadingSectors } = useGetSectors({
    query: { refetchInterval: 5 * 60 * 1000, queryKey: getGetSectorsQueryKey() }
  });

  const { data: momentumData, isLoading: isLoadingMomentum, isFetching } = useGetMomentumPicks({
    query: { refetchInterval: 5 * 60 * 1000, queryKey: getGetMomentumPicksQueryKey() }
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetMarketIndicesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetSectorsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMomentumPicksQueryKey() });
  };

  const handleSave = () => {
    if (!momentumData) return;
    setIsSaving(true);
    saveTodayPicks(momentumData.fetchedAt, momentumData.sectors);
    setTimeout(() => {
      setIsSaving(false);
      toast({
        title: "Picks Saved",
        description: "Today's momentum picks have been saved to your history.",
      });
    }, 500);
  };

  const todayPicks = getTodayPicks();
  const hasSavedToday = !!todayPicks;

  return (
    <Layout>
      <Ticker />
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="flex flex-col md:flex-row gap-6">
          {/* Main Content */}
          <div className="flex-1 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Momentum Screener</h2>
                <p className="text-muted-foreground text-sm mt-1">
                  Top 4 sectors and stocks changing 0.3% - 3.0% today.
                </p>
              </div>
              <div className="flex space-x-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleRefresh}
                  disabled={isFetching}
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button 
                  variant="default" 
                  size="sm" 
                  onClick={handleSave}
                  disabled={!momentumData || isSaving || hasSavedToday}
                >
                  {hasSavedToday ? (
                    <Check className="w-4 h-4 mr-2" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  {hasSavedToday ? "Saved Today" : "Save Picks"}
                </Button>
              </div>
            </div>

            {isLoadingMomentum ? (
              <div className="space-y-6">
                {[1, 2].map(i => (
                  <div key={i} className="space-y-3">
                    <Skeleton className="h-8 w-48" />
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {[1, 2, 3, 4, 5].map(j => <Skeleton key={j} className="h-20 w-full" />)}
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
            
            {hasSavedToday && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
                <h4 className="font-semibold text-primary mb-1 flex items-center">
                  <Check className="w-4 h-4 mr-1" /> Picks Saved
                </h4>
                <p className="text-muted-foreground">
                  You've captured today's momentum data. Check the History tab to review past picks.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
