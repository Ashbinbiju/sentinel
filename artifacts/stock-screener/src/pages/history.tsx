import { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import {
  Calendar,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  BarChart2,
  RefreshCw,
  ShieldAlert,
  Target,
} from "lucide-react";
import { toISTTime } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoryTrade {
  id: number;
  symbol: string;
  date: string;
  signalTime: string;
  entryPrice: string;
  sl: string;
  target1: string;
  target2: string;
  status: string;
  plPct: number | null;
}

interface DaySummary {
  total: number;
  winners: number;
  losers: number;
  breakeven: number;
  pending: number;
}

interface TradeHistoryDay {
  date: string;
  trades: HistoryTrade[];
  summary: DaySummary;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): { long: string; dayOfWeek: string; daysAgo: string } {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const todayIST = new Date(Date.now() + 19800000);
    const todayMid = new Date(todayIST.getUTCFullYear(), todayIST.getUTCMonth(), todayIST.getUTCDate());
    const diff = Math.round((todayMid.getTime() - date.getTime()) / 86400000);
    const daysAgo = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : `${diff} days ago`;
    const long = date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const dayOfWeek = date.toLocaleDateString("en-IN", { weekday: "short" });
    return { long, dayOfWeek, daysAgo };
  } catch {
    return { long: dateStr, dayOfWeek: "", daysAgo: "" };
  }
}

function getStatusConfig(status: string): {
  label: string;
  classes: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case "TARGET 2 HIT":
      return {
        label: "T2 Hit 🎯",
        classes: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        icon: <TrendingUp className="w-3 h-3" />,
      };
    case "TARGET 1 HIT":
      return {
        label: "T1 Hit ✓",
        classes: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
        icon: <TrendingUp className="w-3 h-3" />,
      };
    case "T1 HIT & TRAILING SL HIT":
      return {
        label: "Breakeven ⚖️",
        classes: "bg-amber-500/10 text-amber-400 border-amber-500/20",
        icon: <Minus className="w-3 h-3" />,
      };
    case "SL HIT":
      return {
        label: "SL Hit 🛑",
        classes: "bg-rose-500/10 text-rose-400 border-rose-500/20",
        icon: <TrendingDown className="w-3 h-3" />,
      };
    case "SQUARED OFF":
      return {
        label: "Closed 🕒",
        classes: "bg-slate-500/10 text-slate-400 border-slate-500/20",
        icon: <Clock className="w-3 h-3" />,
      };
    default:
      return {
        label: "Active ⏳",
        classes: "bg-blue-500/10 text-blue-400 border-blue-500/20",
        icon: <Clock className="w-3 h-3" />,
      };
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PlBadge({ plPct }: { plPct: number | null }) {
  if (plPct === null) return (
    <span className="text-[11px] font-mono text-muted-foreground/40">—</span>
  );
  if (plPct > 0) return (
    <span className="text-[12px] font-mono font-bold text-emerald-400">+{plPct.toFixed(2)}%</span>
  );
  if (plPct < 0) return (
    <span className="text-[12px] font-mono font-bold text-rose-400">{plPct.toFixed(2)}%</span>
  );
  return (
    <span className="text-[12px] font-mono font-bold text-amber-400">0.00%</span>
  );
}

function TradeRow({ trade }: { trade: HistoryTrade }) {
  const status = getStatusConfig(trade.status);
  const entry = parseFloat(trade.entryPrice);
  const sl = parseFloat(trade.sl);
  const t1 = parseFloat(trade.target1);
  const t2 = parseFloat(trade.target2);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-3 px-4 hover:bg-accent/10 transition-colors border-b border-border/20 last:border-0">
      {/* Symbol + status */}
      <div className="flex items-center gap-2 min-w-[180px]">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-foreground">{trade.symbol}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide ${status.classes}`}>
              {status.icon}
              {status.label}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
            Signal @ {toISTTime(trade.signalTime)} IST
          </div>
        </div>
      </div>

      {/* Price grid */}
      <div className="flex items-center gap-3 flex-1 flex-wrap">
        <div className="flex flex-col items-center min-w-[52px]">
          <span className="text-[9px] text-sky-400/60 uppercase tracking-wide font-semibold">Entry</span>
          <span className="font-mono text-[11px] font-semibold text-sky-300">₹{entry.toFixed(2)}</span>
        </div>
        <div className="flex flex-col items-center min-w-[52px]">
          <span className="text-[9px] text-rose-400/60 uppercase tracking-wide font-semibold flex items-center gap-0.5">
            <ShieldAlert className="w-2.5 h-2.5" /> SL
          </span>
          <span className="font-mono text-[11px] font-semibold text-rose-300">₹{sl.toFixed(2)}</span>
        </div>
        <div className="flex flex-col items-center min-w-[52px]">
          <span className="text-[9px] text-emerald-400/60 uppercase tracking-wide font-semibold flex items-center gap-0.5">
            <Target className="w-2.5 h-2.5" /> T1
          </span>
          <span className="font-mono text-[11px] font-semibold text-emerald-300">₹{t1.toFixed(2)}</span>
        </div>
        <div className="flex flex-col items-center min-w-[52px]">
          <span className="text-[9px] text-emerald-400/60 uppercase tracking-wide font-semibold flex items-center gap-0.5">
            <Target className="w-2.5 h-2.5" /> T2
          </span>
          <span className="font-mono text-[11px] font-semibold text-emerald-300">₹{t2.toFixed(2)}</span>
        </div>
      </div>

      {/* P&L */}
      <div className="flex flex-col items-end min-w-[60px]">
        <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wide mb-0.5">Est. P&L</span>
        <PlBadge plPct={trade.plPct} />
      </div>
    </div>
  );
}

function DayCard({ day }: { day: TradeHistoryDay }) {
  const [open, setOpen] = useState(true);
  const { long, dayOfWeek, daysAgo } = formatDate(day.date);
  const { summary } = day;

  const winRate = summary.total > 0
    ? Math.round(((summary.winners + summary.breakeven) / summary.total) * 100)
    : null;

  return (
    <div className="rounded-xl border border-border/40 bg-card overflow-hidden shadow-sm">
      {/* Day header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/20 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <Calendar className="w-4 h-4 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-foreground">{long}</span>
              <span className="text-[10px] text-muted-foreground/60 font-mono">{dayOfWeek}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">{daysAgo}</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Day pill summary */}
          <div className="hidden sm:flex items-center gap-2">
            {summary.winners > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                {summary.winners}W
              </span>
            )}
            {summary.losers > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/20">
                {summary.losers}L
              </span>
            )}
            {summary.breakeven > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">
                {summary.breakeven}BE
              </span>
            )}
            {summary.pending > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/20">
                {summary.pending}P
              </span>
            )}
            {winRate !== null && (
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                winRate >= 60 ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                : winRate >= 40 ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              }`}>
                {winRate}% WR
              </span>
            )}
          </div>
          <span className="text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* Trade rows */}
      {open && (
        <div className="border-t border-border/30">
          {day.trades.length === 0 ? (
            <p className="text-sm text-muted-foreground italic px-4 py-4">No trades recorded.</p>
          ) : (
            day.trades.map((trade) => <TradeRow key={trade.id} trade={trade} />)
          )}
        </div>
      )}
    </div>
  );
}

// ── Overall Stats Banner ──────────────────────────────────────────────────────

function StatsBanner({ days }: { days: TradeHistoryDay[] }) {
  const allTrades = days.flatMap((d) => d.trades);
  const terminal = allTrades.filter((t) => t.plPct !== null);
  const winners = terminal.filter((t) => (t.plPct ?? 0) > 0).length;
  const losers = terminal.filter((t) => (t.plPct ?? 0) < 0).length;
  const breakeven = terminal.filter((t) => t.plPct === 0).length;
  const winRate = terminal.length > 0 ? ((winners + breakeven) / terminal.length) * 100 : null;
  const avgWin = winners > 0
    ? terminal.filter((t) => (t.plPct ?? 0) > 0).reduce((s, t) => s + (t.plPct ?? 0), 0) / winners
    : null;
  const avgLoss = losers > 0
    ? terminal.filter((t) => (t.plPct ?? 0) < 0).reduce((s, t) => s + (t.plPct ?? 0), 0) / losers
    : null;

  const stats = [
    { label: "Total Trades", value: allTrades.length.toString(), sub: `${terminal.length} resolved` },
    { label: "Win Rate", value: winRate !== null ? `${winRate.toFixed(0)}%` : "—", sub: `${winners}W · ${losers}L · ${breakeven}BE`, highlight: winRate !== null ? (winRate >= 50 ? "green" : "red") : "neutral" },
    { label: "Avg Winner", value: avgWin !== null ? `+${avgWin.toFixed(2)}%` : "—", highlight: "green" },
    { label: "Avg Loser", value: avgLoss !== null ? `${avgLoss.toFixed(2)}%` : "—", highlight: "red" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      {stats.map((s) => (
        <div key={s.label} className="rounded-xl border border-border/40 bg-card px-4 py-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{s.label}</div>
          <div className={`text-xl font-bold font-mono ${
            s.highlight === "green" ? "text-emerald-400"
            : s.highlight === "red" ? "text-rose-400"
            : "text-foreground"
          }`}>
            {s.value}
          </div>
          {s.sub && <div className="text-[10px] text-muted-foreground/60 mt-0.5">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
type DayOption = (typeof DAY_OPTIONS)[number];

export default function History() {
  const [selectedDays, setSelectedDays] = useState<DayOption>(30);
  const [data, setData] = useState<TradeHistoryDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchHistory(days: DayOption) {
    setLoading(true);
    setError(null);
    try {
      const base = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${base}/api/stocks/trades/history?days=${days}`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const json = await res.json();
      setData(json.days ?? []);
    } catch (e: any) {
      setError(e.message ?? "Failed to load history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHistory(selectedDays);
  }, [selectedDays]);

  return (
    <Layout>
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Trade History</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Real outcomes from the database — not browser snapshots
              </p>
            </div>
          </div>

          {/* Day range selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">Range:</span>
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDays(d)}
                className={`px-2.5 py-1 rounded border text-[11px] font-bold tracking-wider transition-colors ${
                  selectedDays === d
                    ? "bg-primary/20 text-primary border-primary/40"
                    : "bg-card text-muted-foreground border-border/40 hover:bg-accent/30"
                }`}
              >
                {d}d
              </button>
            ))}
            <button
              onClick={() => fetchHistory(selectedDays)}
              title="Refresh"
              className="ml-1 p-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-card border border-border/30 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-12 border border-rose-500/20 rounded-xl bg-rose-500/5">
            <TrendingDown className="w-8 h-8 text-rose-400/50 mx-auto mb-3" />
            <p className="text-sm text-rose-400 font-medium">{error}</p>
            <button
              onClick={() => fetchHistory(selectedDays)}
              className="mt-3 text-xs text-muted-foreground hover:text-foreground underline"
            >
              Try again
            </button>
          </div>
        ) : data.length === 0 ? (
          <div className="text-center py-16 border border-border/30 border-dashed rounded-xl bg-card/30">
            <Calendar className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <h3 className="text-base font-medium text-foreground">No trades found</h3>
            <p className="text-sm text-muted-foreground mt-1">
              No signals were recorded in the last {selectedDays} days.
            </p>
          </div>
        ) : (
          <>
            <StatsBanner days={data} />
            <div className="space-y-3">
              {data.map((day) => (
                <DayCard key={day.date} day={day} />
              ))}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
