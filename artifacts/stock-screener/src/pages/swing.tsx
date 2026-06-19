import { useEffect, useState, type ReactNode } from "react";
import { Layout } from "@/components/layout";
import { formatCurrency, formatPercent, toISTTime } from "@/lib/format";
import {
  Activity,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Clock3,
  LineChart,
  RefreshCw,
  Target,
  TrendingDown,
} from "lucide-react";

interface SwingPick {
  symbol: string;
  sector: string;
  signalTime: string;
  currentPrice: number;
  entryPrice: number;
  sl: number;
  target: number;
  score: number;
  signalScore: number;
  grade: string;
  setup: string;
  entryType: "BREAKOUT" | "PULLBACK";
  reason: string;
  expectedHoldDays: number;
  recentReturn: number;
  relativeStrength: number;
  sectorRelativeStrength: number;
  rvol: number;
  avgTurnover: number;
  entryDistancePct: number;
  rewardRisk: number;
  breakoutQuality: string;
  trendPersistence: number;
  freshBreakoutAge: number | null;
  consolidationCandles: number;
}

interface SwingScannerResponse {
  fetchedAt: string;
  date: string;
  universeCount: number;
  candidateCount: number;
  savedCount: number;
  niftyReturn: number;
  picks: SwingPick[];
}

interface SwingTrackerTrade {
  id: number;
  symbol: string;
  date: string;
  signalTime: string;
  sector: string | null;
  entryType: "BREAKOUT" | "PULLBACK";
  currentPrice: string;
  entryPrice: string;
  sl: string;
  target: string;
  score: string;
  grade: string;
  setup: string;
  reason: string | null;
  expectedHoldDays: string;
  status: string;
  entryHitDate: string | null;
  exitDate: string | null;
  lastPrice: string | null;
  lastCheckedAt: string | null;
  plPct: number | null;
  daysOpen: number | null;
}

interface SwingTrackerResponse {
  fetchedAt: string;
  summary: {
    total: number;
    watchlist: number;
    active: number;
    targetHit: number;
    slHit: number;
    exitReview: number;
    open: number;
  };
  trades: SwingTrackerTrade[];
}

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_API_URL || "";
  return `${base}${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path));
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatTurnover(value: number): string {
  const crore = value / 10_000_000;
  if (crore >= 100) return `${Math.round(crore)} Cr`;
  return `${crore.toFixed(1)} Cr`;
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

function numberFrom(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function StatusBadge({ status }: { status: string }) {
  const config = getStatusConfig(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${config.className}`}>
      {config.icon}
      {config.label}
    </span>
  );
}

function getStatusConfig(status: string): { label: string; className: string; icon: ReactNode } {
  switch (status) {
    case "TARGET HIT":
      return {
        label: "Target Hit",
        className: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      };
    case "SL HIT":
      return {
        label: "SL Hit",
        className: "border-rose-500/30 bg-rose-500/15 text-rose-300",
        icon: <TrendingDown className="h-3.5 w-3.5" />,
      };
    case "ACTIVE":
      return {
        label: "Active",
        className: "border-sky-500/30 bg-sky-500/15 text-sky-300",
        icon: <Activity className="h-3.5 w-3.5" />,
      };
    case "EXIT REVIEW":
      return {
        label: "Review",
        className: "border-amber-500/30 bg-amber-500/15 text-amber-300",
        icon: <CalendarClock className="h-3.5 w-3.5" />,
      };
    default:
      return {
        label: "Watchlist",
        className: "border-slate-500/30 bg-slate-500/15 text-slate-300",
        icon: <Clock3 className="h-3.5 w-3.5" />,
      };
  }
}

function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: "green" | "red" | "blue" | "amber" }) {
  const toneClass =
    tone === "green" ? "text-emerald-300"
      : tone === "red" ? "text-rose-300"
        : tone === "amber" ? "text-amber-300"
          : tone === "blue" ? "text-sky-300"
            : "text-foreground";

  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-sm font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

function PickCard({ pick }: { pick: SwingPick }) {
  const targetPct = ((pick.target - pick.entryPrice) / pick.entryPrice) * 100;
  const riskPct = ((pick.entryPrice - pick.sl) / pick.entryPrice) * 100;

  return (
    <article className="h-full rounded-lg border border-emerald-500/20 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-extrabold text-foreground">{pick.symbol}</h3>
            <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
              BUY
            </span>
            <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">
              {pick.entryType}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{pick.sector} - {pick.setup}</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Grade</div>
          <div className="font-mono text-lg font-extrabold text-emerald-300">{pick.grade}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Current" value={formatCurrency(pick.currentPrice)} />
        <Metric label="Entry" value={formatCurrency(pick.entryPrice)} tone="blue" />
        <Metric label="SL" value={formatCurrency(pick.sl)} tone="red" />
        <Metric label="Target" value={formatCurrency(pick.target)} tone="green" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Score" value={pick.score.toFixed(1)} tone="green" />
        <Metric label="R/R" value={`${pick.rewardRisk.toFixed(2)}x`} />
        <Metric label="Risk" value={formatPercent(-riskPct)} tone="red" />
        <Metric label="Target" value={formatPercent(targetPct)} tone="green" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Relative strength</span>
          <span className="font-mono font-semibold text-emerald-300">{formatPercent(pick.relativeStrength)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">RVOL</span>
          <span className="font-mono font-semibold">{pick.rvol.toFixed(2)}x</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Turnover</span>
          <span className="font-mono font-semibold">{formatTurnover(pick.avgTurnover)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Hold</span>
          <span className="font-mono font-semibold">{pick.expectedHoldDays}d</span>
        </div>
      </div>

      {pick.reason && (
        <div className="mt-4 rounded-md border border-border/50 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          {pick.reason}
        </div>
      )}
    </article>
  );
}

function TrackerCard({ trade }: { trade: SwingTrackerTrade }) {
  const entry = numberFrom(trade.entryPrice);
  const sl = numberFrom(trade.sl);
  const target = numberFrom(trade.target);
  const last = numberFrom(trade.lastPrice ?? trade.currentPrice);
  const plClass =
    trade.plPct === null ? "text-muted-foreground"
      : trade.plPct > 0 ? "text-emerald-300"
        : trade.plPct < 0 ? "text-rose-300"
          : "text-amber-300";

  return (
    <article className="rounded-lg border border-border/50 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-extrabold text-foreground">{trade.symbol}</h3>
            <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
              BUY
            </span>
            <StatusBadge status={trade.status} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {trade.sector ?? "Sector"} - {trade.setup} - Signal {toISTTime(trade.signalTime)} IST
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">P&L</div>
          <div className={`font-mono text-lg font-extrabold ${plClass}`}>
            {trade.plPct === null ? "-" : formatPercent(trade.plPct)}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Metric label="Entry" value={formatCurrency(entry)} tone="blue" />
        <Metric label="Last" value={formatCurrency(last)} />
        <Metric label="SL" value={formatCurrency(sl)} tone="red" />
        <Metric label="Target" value={formatCurrency(target)} tone="green" />
        <Metric label="Score" value={Number(trade.score).toFixed(1)} tone="green" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded border border-border/50 bg-background/40 px-2 py-1">Scan {formatDate(trade.date)}</span>
        <span className="rounded border border-border/50 bg-background/40 px-2 py-1">Entry {formatDate(trade.entryHitDate)}</span>
        <span className="rounded border border-border/50 bg-background/40 px-2 py-1">Exit {formatDate(trade.exitDate)}</span>
        <span className="rounded border border-border/50 bg-background/40 px-2 py-1">Open {trade.daysOpen ?? 0}d</span>
      </div>
    </article>
  );
}

export default function Swing() {
  const [scanner, setScanner] = useState<SwingScannerResponse | null>(null);
  const [tracker, setTracker] = useState<SwingTrackerResponse | null>(null);
  const [scannerLoading, setScannerLoading] = useState(false);
  const [trackerLoading, setTrackerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadScanner() {
    setScannerLoading(true);
    setError(null);
    try {
      const data = await fetchJson<SwingScannerResponse>("/api/stocks/swing-scanner");
      setScanner(data);
      await loadTracker();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swing scanner failed");
    } finally {
      setScannerLoading(false);
    }
  }

  async function loadTracker() {
    setTrackerLoading(true);
    try {
      const data = await fetchJson<SwingTrackerResponse>("/api/stocks/swing-trades?days=45");
      setTracker(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swing tracker failed");
    } finally {
      setTrackerLoading(false);
    }
  }

  useEffect(() => {
    loadScanner();
  }, []);

  const summary = tracker?.summary;

  return (
    <Layout>
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-5 sm:px-6">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-emerald-400">
              <LineChart className="h-5 w-5" />
              <span className="text-sm font-bold uppercase tracking-[0.18em]">Swing Scanner</span>
            </div>
            <h1 className="mt-2 text-2xl font-extrabold text-foreground">Daily swing entries</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={loadTracker}
              disabled={trackerLoading}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${trackerLoading ? "animate-spin" : ""}`} />
              Tracker
            </button>
            <button
              onClick={loadScanner}
              disabled={scannerLoading}
              className="inline-flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/15 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${scannerLoading ? "animate-spin" : ""}`} />
              Run Scan
            </button>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Universe" value={scanner ? scanner.universeCount : "-"} tone="blue" />
          <Metric label="Candidates" value={scanner ? scanner.candidateCount : "-"} tone="green" />
          <Metric label="Saved Today" value={scanner ? scanner.savedCount : "-"} tone="amber" />
          <Metric label="Open Tracker" value={summary ? summary.open : "-"} tone="green" />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-emerald-400" />
              <h2 className="text-lg font-extrabold text-foreground">Scanner Picks</h2>
            </div>
            {scanner?.fetchedAt && (
              <span className="text-xs text-muted-foreground">Last run {toISTTime(scanner.fetchedAt)} IST</span>
            )}
          </div>

          {scannerLoading && !scanner ? (
            <div className="rounded-lg border border-border/50 bg-card p-8 text-center text-muted-foreground">Scanning daily candles...</div>
          ) : scanner?.picks?.length ? (
            <div className="grid auto-rows-fr gap-4 xl:grid-cols-2">
              {scanner.picks.map((pick) => (
                <PickCard key={`${pick.symbol}-${pick.signalTime}`} pick={pick} />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/50 bg-card p-8 text-center text-muted-foreground">
              No swing picks found.
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-sky-400" />
              <h2 className="text-lg font-extrabold text-foreground">Swing Tracker</h2>
            </div>
            {summary && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-slate-300">{summary.watchlist} watch</span>
                <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-300">{summary.active} active</span>
                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">{summary.targetHit} target</span>
                <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-300">{summary.slHit} sl</span>
              </div>
            )}
          </div>

          {trackerLoading && !tracker ? (
            <div className="rounded-lg border border-border/50 bg-card p-8 text-center text-muted-foreground">Loading tracker...</div>
          ) : tracker?.trades?.length ? (
            <div className="grid gap-4">
              {tracker.trades.map((trade) => (
                <TrackerCard key={trade.id} trade={trade} />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/50 bg-card p-8 text-center text-muted-foreground">
              No swing entries saved yet.
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
