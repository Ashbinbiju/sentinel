import type { StockItem } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, getColorClass, getBgColorClass } from "@/lib/format";
import { Card } from "@/components/ui/card";

export function StockCard({ stock }: { stock: StockItem }) {
  return (
    <Card className="p-3 bg-card hover:bg-accent/50 transition-colors border-border/50 flex flex-col justify-between">
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
      </div>
    </Card>
  );
}
