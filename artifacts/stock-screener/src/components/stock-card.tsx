import type { StockItem } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, getBgColorClass } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";

interface StockCardProps {
  stock: StockItem;
}

export function StockCard({ stock }: StockCardProps) {
  const href = `https://www.tradingview.com/chart/?symbol=NSE%3A${stock.symbol}`;
  const hasIndicators = stock.vwap !== null && stock.vwap !== undefined;
  const aboveVwap = hasIndicators && stock.confirmedClose !== null && stock.confirmedClose !== undefined && stock.vwap !== null && stock.vwap !== undefined
    ? stock.confirmedClose > stock.vwap
    : null;
  const aboveEma = stock.ema20 !== null && stock.ema20 !== undefined && stock.confirmedClose !== null && stock.confirmedClose !== undefined
    ? stock.confirmedClose > stock.ema20
    : null;
  const entrySignal = stock.entrySignal === true;

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block">
      <Card
        data-testid={`card-stock-${stock.symbol}`}
        className={`p-3 bg-card hover:bg-accent/50 transition-colors border-border/50 flex flex-col justify-between cursor-pointer group ${entrySignal ? "ring-1 ring-emerald-500/60" : ""}`}
      >
        <div className="flex justify-between items-start mb-1.5">
          <h4 className="font-bold text-foreground truncate mr-2 text-sm" title={stock.symbol}>
            {stock.symbol}
          </h4>
          <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-medium ${getBgColorClass(stock.changePct)}`}>
            {formatPercent(stock.changePct)}
          </span>
        </div>

        <div className="flex justify-between items-center mb-2">
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">LTP</span>
            <span className="font-mono text-foreground font-medium text-sm">{formatCurrency(stock.ltp)}</span>
          </div>
          {entrySignal && (
            <span className="text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-1.5 py-0.5 rounded uppercase tracking-wide">
              Entry ✓
            </span>
          )}
          {!entrySignal && <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />}
        </div>

        {hasIndicators ? (
          <div className="flex gap-1.5">
            <span
              className={`text-[9px] font-mono px-1 py-0.5 rounded border ${
                aboveVwap
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/30"
              }`}
              title={`VWAP: ₹${stock.vwap?.toFixed(2)}`}
            >
              VWAP {aboveVwap ? "↑" : "↓"}
            </span>
            <span
              className={`text-[9px] font-mono px-1 py-0.5 rounded border ${
                aboveEma
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/30"
              }`}
              title={`EMA20: ₹${stock.ema20?.toFixed(2)}`}
            >
              EMA {aboveEma ? "↑" : "↓"}
            </span>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <span className="text-[9px] font-mono px-1 py-0.5 rounded border bg-muted/30 text-muted-foreground/50 border-border/30">
              VWAP —
            </span>
            <span className="text-[9px] font-mono px-1 py-0.5 rounded border bg-muted/30 text-muted-foreground/50 border-border/30">
              EMA —
            </span>
          </div>
        )}
      </Card>
    </a>
  );
}
