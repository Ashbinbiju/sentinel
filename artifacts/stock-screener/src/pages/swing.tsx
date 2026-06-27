import { useEffect, useState, type ReactNode } from "react";
import { Layout } from "@/components/layout";
import { formatCurrency, formatPercent, toISTTime } from "@/lib/format";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Layers3,
  LineChart,
  RefreshCw,
  Target,
  TrendingDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  indexTrendIndex?: string | null;
  indexTrendDirection?: string | null;
  indexTrendText?: string | null;
  indexTrendScoreAdjustment?: number;
  technicalStage?: string | null;
  technicalScoreAdjustment?: number;
  technicalIndicatorText?: string | null;
  technicalRs55?: number | null;
  technicalVolumeRatio?: number | null;
  technicalAboveEma200?: boolean | null;
  technicalMacdTrend?: string | null;
  technicalAdxTrend?: string | null;
  insiderActivity?: string | null;
  insiderScoreAdjustment?: number;
  insiderActivityText?: string | null;
  insiderTransactionValue?: number | null;
  insiderTransactionDate?: string | null;
  insiderCategory?: string | null;
}

interface SwingScannerResponse {
  fetchedAt: string;
  date: string;
  selectedSectors: string[];
  sectorCount: number;
  universeCount: number;
  candidateCount: number;
  savedCount: number;
  niftyReturn: number;
  picks: SwingPick[];
}

type SwingScanJobStatus = "queued" | "running" | "completed" | "failed";

interface SwingScanJobResponse {
  jobId: string;
  status: SwingScanJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  selectedSectors: string[];
  sectorCount: number;
  universeCount: number;
  processedCount: number;
  candidateCount: number;
  savedCount: number;
  progressPct: number;
  message: string;
  error: string | null;
  result: SwingScannerResponse | null;
}

interface SwingSectorOption {
  name: string;
  count: number;
}

interface SwingSectorsResponse {
  totalSectors: number;
  totalSymbols: number;
  sectors: SwingSectorOption[];
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
  indexTrendIndex: string | null;
  indexTrendDirection: string | null;
  indexTrendText: string | null;
  indexTrendScoreAdjustment: string;
  technicalStage: string | null;
  technicalScoreAdjustment: string;
  technicalIndicatorText: string | null;
  technicalRs55: string | null;
  technicalVolumeRatio: string | null;
  technicalAboveEma200: boolean | null;
  technicalMacdTrend: string | null;
  technicalAdxTrend: string | null;
  insiderActivity: string | null;
  insiderScoreAdjustment: string;
  insiderActivityText: string | null;
  insiderTransactionValue: string | null;
  insiderTransactionDate: string | null;
  insiderCategory: string | null;
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
    expired: number;
    open: number;
  };
  trades: SwingTrackerTrade[];
}

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_API_URL || "";
  return `${base}${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store" });
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
    case "EXPIRED":
      return {
        label: "Expired",
        className: "border-slate-500/30 bg-slate-500/10 text-slate-400",
        icon: <Clock3 className="h-3.5 w-3.5" />,
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

function InsiderActivityBadge({
  text,
  adjustment,
}: {
  text?: string | null;
  adjustment?: string | number | null;
}) {
  if (!text) return null;

  const score = Number(adjustment ?? 0);
  const isSupportive = score > 0;
  const className = isSupportive
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-amber-500/35 bg-amber-500/10 text-amber-200";

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-bold ${className}`} title={text}>
      {isSupportive ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{text}</span>
    </span>
  );
}

function IndexTrendBadge({
  text,
  adjustment,
}: {
  text?: string | null;
  adjustment?: string | number | null;
}) {
  if (!text) return null;

  const score = Number(adjustment ?? 0);
  const className =
    score > 0 ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : score < 0 ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
        : "border-slate-500/30 bg-slate-500/10 text-slate-300";

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-bold ${className}`} title={text}>
      <LineChart className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

function TechnicalIndicatorBadge({
  text,
  adjustment,
}: {
  text?: string | null;
  adjustment?: string | number | null;
}) {
  if (!text) return null;

  const score = Number(adjustment ?? 0);
  const className =
    score > 0 ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
      : score < 0 ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
        : "border-slate-500/30 bg-slate-500/10 text-slate-300";

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-bold ${className}`} title={text}>
      <BarChart3 className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
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
            <IndexTrendBadge text={pick.indexTrendText} adjustment={pick.indexTrendScoreAdjustment} />
            <TechnicalIndicatorBadge text={pick.technicalIndicatorText} adjustment={pick.technicalScoreAdjustment} />
            <InsiderActivityBadge text={pick.insiderActivityText} adjustment={pick.insiderScoreAdjustment} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{pick.sector} - {pick.setup}</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Grade</div>
          <div className="font-mono text-lg font-extrabold text-emerald-300">{pick.grade}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="CMP" value={formatCurrency(pick.currentPrice)} />
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
            <IndexTrendBadge text={trade.indexTrendText} adjustment={trade.indexTrendScoreAdjustment} />
            <TechnicalIndicatorBadge text={trade.technicalIndicatorText} adjustment={trade.technicalScoreAdjustment} />
            <InsiderActivityBadge text={trade.insiderActivityText} adjustment={trade.insiderScoreAdjustment} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {trade.sector ?? "Sector"} - {trade.setup} - Scan {toISTTime(trade.signalTime)} IST
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
        <Metric label="CMP" value={formatCurrency(last)} />
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
  const [scanJob, setScanJob] = useState<SwingScanJobResponse | null>(null);
  const [tracker, setTracker] = useState<SwingTrackerResponse | null>(null);
  const [sectorOptions, setSectorOptions] = useState<SwingSectorOption[]>([]);
  const [selectedSectors, setSelectedSectors] = useState<string[]>([]);
  const [scannerLoading, setScannerLoading] = useState(false);
  const [trackerLoading, setTrackerLoading] = useState(false);
  const [sectorsLoading, setSectorsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSectorCount = selectedSectors.length || sectorOptions.length;
  const allSectorsSelected = sectorOptions.length > 0 && selectedSectorCount === sectorOptions.length;
  const selectedSectorLabel =
    sectorOptions.length === 0 ? "Loading sectors"
      : allSectorsSelected ? `All sectors (${sectorOptions.length})`
        : selectedSectors.length === 1 ? selectedSectors[0]
          : `${selectedSectors.length} sectors`;
  const selectedSymbolCount = allSectorsSelected
    ? sectorOptions.reduce((sum, sector) => sum + sector.count, 0)
    : sectorOptions
      .filter((sector) => selectedSectors.includes(sector.name))
      .reduce((sum, sector) => sum + sector.count, 0);

  async function loadSectors() {
    setSectorsLoading(true);
    try {
      const data = await fetchJson<SwingSectorsResponse>("/api/stocks/swing-sectors");
      setSectorOptions(data.sectors);
      setSelectedSectors((current) => current.length > 0 ? current : data.sectors.map((sector) => sector.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load swing sectors");
    } finally {
      setSectorsLoading(false);
    }
  }

  function selectAllSectors() {
    setSelectedSectors(sectorOptions.map((sector) => sector.name));
  }

  function selectOnlySector(name: string) {
    setSelectedSectors([name]);
  }

  function toggleSector(name: string) {
    setSelectedSectors((current) => {
      const base = current.length > 0 ? current : sectorOptions.map((sector) => sector.name);
      if (base.includes(name)) {
        const next = base.filter((sector) => sector !== name);
        return next.length > 0 ? next : [name];
      }
      return [...base, name];
    });
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

  async function handleScanJob(data: SwingScanJobResponse) {
    setScanJob(data);

    if (data.status === "completed" && data.result) {
      setScanner(data.result);
      setScannerLoading(false);
      await loadTracker();
      return;
    }

    if (data.status === "failed") {
      setScannerLoading(false);
      setError(data.error || "Swing scanner failed");
      return;
    }

    setScannerLoading(true);
  }

  async function pollScanJob(jobId: string) {
    try {
      const data = await fetchJson<SwingScanJobResponse>(`/api/stocks/swing-scanner/jobs/${encodeURIComponent(jobId)}`);
      await handleScanJob(data);
    } catch (err) {
      setScannerLoading(false);
      setError(err instanceof Error ? err.message : "Failed to check swing scan progress");
    }
  }

  async function loadScanner() {
    setScanner(null);
    setScanJob(null);
    setScannerLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedSectors.length > 0 && selectedSectors.length !== sectorOptions.length) {
        params.set("sectors", selectedSectors.join(","));
      }
      const query = params.toString();
      const data = await fetchJson<SwingScanJobResponse>(`/api/stocks/swing-scanner${query ? `?${query}` : ""}`);
      await handleScanJob(data);
    } catch (err) {
      setScannerLoading(false);
      setError(err instanceof Error ? err.message : "Swing scanner failed");
    }
  }

  useEffect(() => {
    loadSectors();
    loadTracker();
  }, []);

  useEffect(() => {
    if (!scanJob || !["queued", "running"].includes(scanJob.status)) return;
    const timer = window.setTimeout(() => {
      void pollScanJob(scanJob.jobId);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [scanJob?.jobId, scanJob?.status, scanJob?.processedCount]);

  const summary = tracker?.summary;
  const scanIsActive = scanJob?.status === "queued" || scanJob?.status === "running";
  const scanProgressText = scanJob ? `${scanJob.processedCount}/${scanJob.universeCount}` : null;
  const scanProgressPct = scanJob ? Math.max(0, Math.min(100, scanJob.progressPct)) : 0;

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
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={sectorsLoading || sectorOptions.length === 0}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-60"
              >
                <Layers3 className="h-4 w-4" />
                <span>{selectedSectorLabel}</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    selectAllSectors();
                  }}
                  className="cursor-pointer font-semibold text-emerald-300"
                >
                  All sectors
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {sectorOptions.reduce((sum, sector) => sum + sector.count, 0)}
                  </span>
                </DropdownMenuItem>
                <div className="max-h-80 overflow-y-auto py-1">
                  {sectorOptions.map((sector) => (
                    <DropdownMenuCheckboxItem
                      key={sector.name}
                      checked={selectedSectors.includes(sector.name)}
                      onCheckedChange={() => toggleSector(sector.name)}
                      onSelect={(event) => event.preventDefault()}
                      className="gap-2 pr-1"
                    >
                      <span className="min-w-0 flex-1 truncate">{sector.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{sector.count}</span>
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectOnlySector(sector.name);
                        }}
                        className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground hover:border-emerald-500/40 hover:text-emerald-300"
                      >
                        Only
                      </button>
                    </DropdownMenuCheckboxItem>
                  ))}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
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
              disabled={scannerLoading || sectorsLoading}
              className="inline-flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/15 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${scannerLoading ? "animate-spin" : ""}`} />
              {scannerLoading ? "Scanning" : "Run Scan"}
            </button>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {scanJob && (
          <section className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-emerald-200">
                  {scanIsActive ? "Swing scan running" : scanJob.status === "completed" ? "Swing scan complete" : "Swing scan failed"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{scanJob.message}</div>
              </div>
              <div className="font-mono text-sm font-bold text-emerald-300">
                {scanProgressText} symbols
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-background/70">
              <div
                className="h-full rounded-full bg-emerald-400 transition-all"
                style={{ width: `${scanProgressPct}%` }}
              />
            </div>
          </section>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Sectors" value={scanner ? `${scanner.sectorCount}/${sectorOptions.length || scanner.sectorCount}` : scanJob ? `${scanJob.sectorCount}/${sectorOptions.length || scanJob.sectorCount}` : `${selectedSectorCount}/${sectorOptions.length || selectedSectorCount}`} tone="blue" />
          <Metric label="Symbols" value={scanner ? scanner.universeCount : scanJob ? scanProgressText : selectedSymbolCount || "-"} tone="blue" />
          <Metric label="Candidates" value={scanner ? scanner.candidateCount : scanJob ? scanJob.candidateCount : "-"} tone="green" />
          <Metric label="Saved Today" value={scanner ? scanner.savedCount : scanJob ? scanJob.savedCount : "-"} tone="amber" />
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
            <div className="rounded-lg border border-border/50 bg-card p-8 text-center text-muted-foreground">
              {scanJob ? scanJob.message : "Starting swing scan..."}
            </div>
          ) : scanner?.picks?.length ? (
            <div className="grid auto-rows-fr gap-4 xl:grid-cols-2">
              {scanner.picks.map((pick) => (
                <PickCard key={`${pick.symbol}-${pick.signalTime}`} pick={pick} />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/50 bg-card p-8 text-center text-muted-foreground">
              Run scan to generate swing picks from the selected sector universe.
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
                <span className="rounded border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-slate-400">{summary.expired} expired</span>
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
