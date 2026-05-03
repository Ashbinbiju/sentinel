import type { StockItem } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, getBgColorClass } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { BarChart2 } from "lucide-react";

interface StockCardProps {
  stock: StockItem;
  onClick?: (stock: StockItem) => void;
}

export function StockCard({ stock, onClick }: StockCardProps) {
  return (
    <Card
      data-testid={`card-stock-${stock.symbol}`}
      onClick={() => onClick?.(stock)}
      className="p-3 bg-card hover:bg-accent/50 transition-colors border-border/50 flex flex-col justify-between cursor-pointer group"
    >
      <div className="flex justify-between items-start mb-2">
        <h4 className="font-bold text-foreground truncate mr-2" title={stock.symbol}>
          {stock.symbol}
        </h4>
        <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-medium ${getBgColorClass(stock.changePct)}`}>
          {formatPercent(stock.changePct)}
        </span>
      </div>
      <div className="flex justify-between items-end">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">LTP</span>
          <span className="font-mono text-foreground font-medium">{formatCurrency(stock.ltp)}</span>
        </div>
        <BarChart2 className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
      </div>
    </Card>
  );
}
