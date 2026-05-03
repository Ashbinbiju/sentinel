import { useGetMarketIndices, getGetMarketIndicesQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, getColorClass } from "@/lib/format";

export function Ticker() {
  const { data: indices, isLoading } = useGetMarketIndices({
    query: { refetchInterval: 5 * 60 * 1000, queryKey: getGetMarketIndicesQueryKey() },
  });

  if (isLoading) {
    return (
      <div className="h-10 bg-card border-b border-border overflow-hidden flex items-center px-4">
        <div className="flex space-x-8 animate-pulse">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center space-x-2">
              <div className="w-16 h-4 bg-muted rounded"></div>
              <div className="w-20 h-4 bg-muted rounded"></div>
              <div className="w-12 h-4 bg-muted rounded"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!indices || indices.length === 0) return null;

  return (
    <div className="h-10 bg-card border-b border-border overflow-hidden flex items-center relative select-none">
      <div className="flex space-x-8 px-4 whitespace-nowrap animate-[marquee_30s_linear_infinite] hover:[animation-play-state:paused]">
        {[...indices, ...indices].map((index, i) => (
          <div key={`${index.symbol}-${i}`} className="flex items-center space-x-2 text-sm">
            <span className="font-semibold text-foreground">{index.symbol}</span>
            <span className="font-mono">{formatCurrency(index.ltp)}</span>
            <span className={`font-mono ${getColorClass(index.changePct)}`}>
              {formatPercent(index.changePct)}
            </span>
          </div>
        ))}
      </div>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes marquee {
          0% { transform: translateX(0%); }
          100% { transform: translateX(-50%); }
        }
      `}} />
    </div>
  );
}
