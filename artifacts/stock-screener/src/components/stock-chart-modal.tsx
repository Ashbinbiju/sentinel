import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TradingViewChart } from "@/components/trading-view-chart";
import { formatCurrency, formatPercent, getBgColorClass } from "@/lib/format";
import type { StockItem } from "@workspace/api-client-react";

interface StockChartModalProps {
  stock: StockItem | null;
  onClose: () => void;
}

export function StockChartModal({ stock, onClose }: StockChartModalProps) {
  return (
    <Dialog open={!!stock} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-w-5xl w-full h-[80vh] flex flex-col p-0 gap-0 border-border bg-background">
        <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-3">
            <span className="font-mono text-lg">{stock?.symbol}</span>
            {stock && (
              <>
                <span className="font-mono text-base text-muted-foreground">
                  {formatCurrency(stock.ltp)}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-medium ${getBgColorClass(stock.changePct)}`}>
                  {formatPercent(stock.changePct)}
                </span>
              </>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0">
          {stock && <TradingViewChart symbol={stock.symbol} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
