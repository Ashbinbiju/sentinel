import React from "react";
import type { StockItem } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, getColorClass } from "@/lib/format";
import { Sparkline } from "@/components/sparkline";

interface StockCardProps {
  stock: StockItem;
}

export function StockCard({ stock }: StockCardProps) {
  const href = `https://www.tradingview.com/chart/?symbol=NSE%3A${stock.symbol}`;
  const entry = stock.entrySignal === true;
  const aboveVwap =
    stock.vwap != null && stock.confirmedClose != null
      ? stock.confirmedClose > stock.vwap
      : null;
  const aboveEma =
    stock.ema20 != null && stock.confirmedClose != null
      ? stock.confirmedClose > stock.ema20
      : null;

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block group">
      <div
        className={`relative rounded-xl border transition-all duration-200 overflow-hidden
          ${entry
            ? "bg-emerald-950/30 border-emerald-500/30 shadow-[0_0_16px_rgba(16,185,129,0.08)] hover:border-emerald-400/50"
            : "bg-card border-border/40 hover:border-border hover:bg-accent/20"
          }`}
      >
        {/* Entry glow top line */}
        {entry && (
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent" />
        )}

        <div className="p-3">
          {/* Header row */}
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-bold text-sm text-foreground truncate">{stock.symbol}</span>
              {entry && (
                <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase tracking-wide">
                  ENTRY
                </span>
              )}
            </div>
            <span className={`text-xs font-mono font-semibold shrink-0 px-1.5 py-0.5 rounded ${
              stock.changePct >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
            }`}>
              {formatPercent(stock.changePct)}
            </span>
          </div>

          {/* LTP */}
          <div className="font-mono text-base font-semibold text-foreground mb-2">
            {formatCurrency(stock.ltp)}
          </div>

          {/* Sparkline */}
          {stock.sparkline && stock.sparkline.length > 2 && (
            <div className="mb-2 rounded overflow-hidden opacity-80">
              <Sparkline closes={stock.sparkline} vwap={stock.vwap} height={34} id={stock.symbol} />
            </div>
          )}

          {/* Indicator badges */}
          <div className="flex gap-1 mb-2">
            {stock.vwap != null ? (
              <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border font-medium
                ${aboveVwap ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" : "bg-rose-500/10 text-rose-400 border-rose-500/25"}`}
                title={`VWAP: ${formatCurrency(stock.vwap)}`}>
                VWAP {aboveVwap ? "↑" : "↓"}
              </span>
            ) : (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-muted/20 text-muted-foreground/40 border-border/20">VWAP —</span>
            )}
            {stock.ema20 != null ? (
              <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border font-medium
                ${aboveEma ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" : "bg-rose-500/10 text-rose-400 border-rose-500/25"}`}
                title={`EMA20: ${formatCurrency(stock.ema20)}`}>
                EMA {aboveEma ? "↑" : "↓"}
              </span>
            ) : (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-muted/20 text-muted-foreground/40 border-border/20">EMA —</span>
            )}
          </div>

          {/* SL / Target row — only for entry signals */}
          {entry && stock.sl != null && stock.target1 != null && stock.target2 != null && (
            <div className="mt-2 pt-2 border-t border-emerald-500/15 space-y-1">
              <div className="grid grid-cols-3 gap-1 text-[9px]">
                <div className="flex flex-col items-center gap-0.5 bg-rose-500/10 rounded px-1 py-1">
                  <span className="text-rose-400/60 uppercase tracking-wide font-semibold">SL</span>
                  <span className="font-mono text-rose-300 font-bold text-[10px]">₹{stock.sl.toFixed(1)}</span>
                </div>
                <div className="flex flex-col items-center gap-0.5 bg-emerald-500/10 rounded px-1 py-1">
                  <span className="text-emerald-400/60 uppercase tracking-wide font-semibold">T1</span>
                  <span className="font-mono text-emerald-300 font-bold text-[10px]">₹{stock.target1.toFixed(1)}</span>
                </div>
                <div className="flex flex-col items-center gap-0.5 bg-emerald-500/15 rounded px-1 py-1">
                  <span className="text-emerald-400/60 uppercase tracking-wide font-semibold">T2</span>
                  <span className="font-mono text-emerald-300 font-bold text-[10px]">₹{stock.target2.toFixed(1)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </a>
  );
}
