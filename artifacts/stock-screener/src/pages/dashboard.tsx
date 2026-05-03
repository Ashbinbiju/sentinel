import React, { useState, useEffect, useRef } from "react";
import { Layout } from "@/components/layout";
import { Ticker } from "@/components/ticker";
import { StockCard } from "@/components/stock-card";
import {
  useGetSectors,
  getGetSectorsQueryKey,
  useGetMomentumPicks,
  getGetMomentumPicksQueryKey,
  type TopPick,
} from "@workspace/api-client-react";
import { formatPercent, getColorClass } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, Target, ShieldAlert, Zap, RefreshCw, Bell, BellOff, BarChart2 } from "lucide-react";
import { Sparkline } from "@/components/sparkline";

// ── Formatting helpers ───────────────────────────────────────────────────────

function cleanSectorName(name: string): string {
  return name
    .replace(/^NIFTY[_ ]/, "")
    .replace(/_/g, " ")
    .replace(/\bPVT\b/, "Pvt")
    .replace(/\bFIN\b/, "Fin")
    .replace(/\bSERVICE\b/, "Service")
    .replace(/\bFMCG\b/, "FMCG")
    .replace(/\bAUTO\b/, "Auto")
    .replace(/\bBANK\b/, "Bank")
    .replace(/\bMEDIA\b/, "Media")
    .replace(/\bENERGY\b/, "Energy")
    .replace(/\bIT\b/, "IT")
    .replace(/\bPHARMA\b/, "Pharma")
    .replace(/\bHEALTHCARE\b/, "Healthcare")
    .replace(/\bCONSUMPTION\b/, "Consumption")
    .replace(/\bOIL AND GAS\b/, "Oil & Gas")
    .trim();
}

// ── IST helpers ──────────────────────────────────────────────────────────────

function getNowIST() {
  const now = new Date(Date.now() + 19800000);
  return { h: now.getUTCHours(), m: now.getUTCMinutes(), s: now.getUTCSeconds() };
}

function toISTDisplay(isoUtc: string): string {
  try {
    return (
      new Date(isoUtc).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " IST"
    );
  } catch {
    return "";
  }
}

function formatSessionDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch {
    return dateStr;
  }
}

function formatSessionDateFull(dateStr: string): { short: string; long: string; dayOfWeek: string; daysAgo: string } {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const todayIST = new Date(Date.now() + 19800000);
    const todayMidnight = new Date(todayIST.getUTCFullYear(), todayIST.getUTCMonth(), todayIST.getUTCDate());
    const diffDays = Math.round((todayMidnight.getTime() - date.getTime()) / 86400000);
    const daysAgo = diffDays === 1 ? "yesterday" : diffDays === 0 ? "today" : `${diffDays} days ago`;
    const short = date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const long = date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const dayOfWeek = date.toLocaleDateString("en-IN", { weekday: "long" });
    return { short, long, dayOfWeek, daysAgo };
  } catch {
    return { short: dateStr, long: dateStr, dayOfWeek: "", daysAgo: "" };
  }
}

function isMarketOpen(): boolean {
  const { h, m } = getNowIST();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

// ── Countdown ring (circular progress) ───────────────────────────────────────

const POLL_INTERVAL = 60; // seconds

function CountdownRing({
  seconds,
  total = POLL_INTERVAL,
  active,
  scanning,
}: {
  seconds: number;
  total?: number;
  active: boolean;
  scanning: boolean;
}) {
  const r = 9;
  const circ = 2 * Math.PI * r;
  const progress = seconds / total; // 1 = full, 0 = empty
  const offset = circ * (1 - progress);

  const color = scanning ? "#34d399" : active ? "#34d399" : "#4b5563";
  const textColor = active ? "#d1fae5" : "#6b7280";

  return (
    <div className="flex items-center gap-1.5 shrink-0" title={active ? `Next scan in ${seconds}s` : "Auto-scan paused (market closed)"}>
      <svg width="24" height="24" viewBox="0 0 24 24" className={scanning ? "animate-pulse" : ""}>
        {/* Track */}
        <circle cx="12" cy="12" r={r} fill="none" stroke="#1e293b" strokeWidth="2.2" />
        {/* Progress arc */}
        <circle
          cx="12" cy="12" r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeDasharray={circ}
          strokeDashoffset={scanning ? 0 : offset}
          strokeLinecap="round"
          style={{ transform: "rotate(-90deg)", transformOrigin: "12px 12px", transition: "stroke-dashoffset 0.9s linear" }}
          strokeOpacity={active ? 0.85 : 0.35}
        />
        {/* Centre text */}
        {!scanning && (
          <text x="12" y="12" dominantBaseline="middle" textAnchor="middle"
            fontSize="5.5" fontWeight="700" fill={textColor} fontFamily="ui-monospace,monospace">
            {active ? seconds : "–"}
          </text>
        )}
        {scanning && (
          <circle cx="12" cy="12" r="3" fill="#34d399" fillOpacity="0.9" />
        )}
      </svg>
      <span className={`text-[10px] font-mono tabular-nums hidden sm:block ${active ? "text-emerald-400/70" : "text-muted-foreground/40"}`}>
        {scanning ? "scanning" : active ? `${seconds}s` : "paused"}
      </span>
    </div>
  );
}

// ── IST Live Clock ────────────────────────────────────────────────────────────

function formatDuration(totalMins: number): string {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function ISTClock() {
  const [t, setT] = useState(getNowIST);
  useEffect(() => {
    const id = setInterval(() => setT(getNowIST()), 1000);
    return () => clearInterval(id);
  }, []);

  const OPEN_MIN  = 9 * 60 + 15;   // 09:15
  const CLOSE_MIN = 15 * 60 + 30;  // 15:30
  const mins = t.h * 60 + t.m;
  const open = mins >= OPEN_MIN && mins < CLOSE_MIN;

  let sessionTag: React.ReactNode;
  if (open) {
    const minsLeft = CLOSE_MIN - mins - 1;
    sessionTag = (
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-emerald-400 font-medium">Open</span>
        <span className="hidden sm:inline text-[10px] text-emerald-400/55 font-mono tabular-nums">
          closes in {formatDuration(minsLeft)}
        </span>
      </span>
    );
  } else {
    // Figure out mins until next open
    let minsUntilOpen: number;
    let opensLabel: string;
    if (mins < OPEN_MIN) {
      minsUntilOpen = OPEN_MIN - mins;
      opensLabel = `opens in ${formatDuration(minsUntilOpen)}`;
    } else {
      // After 15:30 — next open is tomorrow at 09:15
      const minsLeftToday = 24 * 60 - mins;
      minsUntilOpen = minsLeftToday + OPEN_MIN;
      opensLabel = minsUntilOpen > 14 * 60 ? "opens tomorrow" : `opens in ${formatDuration(minsUntilOpen)}`;
    }
    sessionTag = (
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Closed</span>
        <span className="hidden sm:inline text-[10px] text-muted-foreground/50 font-mono tabular-nums">
          {opensLabel}
        </span>
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${open ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/25"}`} />
      <span className="font-mono text-sm font-medium tabular-nums text-foreground/80">
        {String(t.h).padStart(2, "0")}:{String(t.m).padStart(2, "0")} IST
      </span>
      {sessionTag}
    </div>
  );
}

// ── Top 5 Pick Card ──────────────────────────────────────────────────────────

function TopPickCard({ pick, rank, fullWidth = false }: { pick: TopPick; rank: number; fullWidth?: boolean }) {
  const href = `https://www.tradingview.com/chart/?symbol=NSE%3A${pick.symbol}`;
  const t1Pct = ((pick.target1 - pick.entry) / pick.entry) * 100;
  const t2Pct = ((pick.target2 - pick.entry) / pick.entry) * 100;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`block group ${fullWidth ? "w-full" : "shrink-0 w-[78vw] max-w-[280px] sm:flex-1 sm:w-auto sm:min-w-[180px] sm:max-w-none"}`}
    >
      <div className="relative rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/40 via-card to-card overflow-hidden hover:border-emerald-400/40 transition-all duration-200 shadow-[0_0_20px_rgba(16,185,129,0.06)]">
        <div className="h-0.5 bg-gradient-to-r from-emerald-500/60 via-emerald-400 to-emerald-500/60" />

        <div className="p-4">
          {/* Rank + symbol + sector + % */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-[11px] font-bold flex items-center justify-center shrink-0">
                {rank}
              </span>
              <div>
                <div className="font-bold text-base text-foreground leading-none">{pick.symbol}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{cleanSectorName(pick.sectorName)}</div>
              </div>
            </div>
            <span className={`text-sm font-mono font-bold px-2 py-0.5 rounded ${pick.changePct >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
              {formatPercent(pick.changePct)}
            </span>
          </div>

          {/* Entry price */}
          <div className="mb-2">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Entry</div>
            <div className={`font-mono font-bold text-foreground ${fullWidth ? "text-2xl" : "text-lg"}`}>₹{pick.entry.toFixed(2)}</div>
          </div>

          {/* Sparkline */}
          {pick.sparkline && pick.sparkline.length > 2 && (
            <div className="mb-3 rounded overflow-hidden opacity-85 -mx-1">
              <Sparkline closes={pick.sparkline} vwap={pick.vwap} height={42} id={`pick-${pick.symbol}`} />
            </div>
          )}

          {/* SL / T1 / T2 grid */}
          <div className="grid grid-cols-3 gap-1.5 mb-3">
            <div className="flex flex-col gap-0.5 bg-rose-500/10 rounded-lg px-2 py-1.5 border border-rose-500/15">
              <div className="flex items-center gap-1">
                <ShieldAlert className="w-2.5 h-2.5 text-rose-400/70" />
                <span className="text-[9px] text-rose-400/70 font-semibold uppercase tracking-wide">SL</span>
              </div>
              <span className="font-mono text-xs font-bold text-rose-300">₹{pick.sl.toFixed(1)}</span>
              <span className="text-[8px] text-rose-400/50">-{pick.riskPct.toFixed(1)}%</span>
            </div>
            <div className="flex flex-col gap-0.5 bg-emerald-500/10 rounded-lg px-2 py-1.5 border border-emerald-500/15">
              <div className="flex items-center gap-1">
                <Target className="w-2.5 h-2.5 text-emerald-400/70" />
                <span className="text-[9px] text-emerald-400/70 font-semibold uppercase tracking-wide">T1</span>
              </div>
              <span className="font-mono text-xs font-bold text-emerald-300">₹{pick.target1.toFixed(1)}</span>
              <span className="text-[8px] text-emerald-400/50">+{t1Pct.toFixed(1)}%</span>
            </div>
            <div className="flex flex-col gap-0.5 bg-emerald-500/15 rounded-lg px-2 py-1.5 border border-emerald-500/20">
              <div className="flex items-center gap-1">
                <TrendingUp className="w-2.5 h-2.5 text-emerald-400/70" />
                <span className="text-[9px] text-emerald-400/70 font-semibold uppercase tracking-wide">T2</span>
              </div>
              <span className="font-mono text-xs font-bold text-emerald-300">₹{pick.target2.toFixed(1)}</span>
              <span className="text-[8px] text-emerald-400/50">+{t2Pct.toFixed(1)}%</span>
            </div>
          </div>

          {/* Smart exit */}
          <div className="bg-muted/20 rounded-lg p-2 border border-border/30">
            <div className="flex items-start gap-1.5">
              <Zap className="w-3 h-3 text-amber-400/70 shrink-0 mt-0.5" />
              <p className={`text-[10px] text-muted-foreground leading-relaxed ${fullWidth ? "" : "line-clamp-2"}`}>
                {pick.smartExit}
              </p>
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

// ── Signal Toast ─────────────────────────────────────────────────────────────

interface ToastSignal {
  id: number;
  symbol: string;
  sectorName: string;
  entry: number;
}

function SignalToastItem({ toast, onDone }: { toast: ToastSignal; onDone: () => void }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const hide = setTimeout(() => setVisible(false), 3800);
    const remove = setTimeout(onDone, 4300);
    return () => { clearTimeout(hide); clearTimeout(remove); };
  }, []);
  return (
    <div className={`transition-all duration-500 ${visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"}`}>
      <div className="flex items-center gap-3 bg-card border border-emerald-500/40 rounded-xl px-4 py-3 shadow-[0_0_24px_rgba(16,185,129,0.15)] min-w-[240px]">
        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-foreground">{toast.symbol}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold uppercase tracking-wide">ENTRY</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            ₹{toast.entry.toFixed(2)} · {cleanSectorName(toast.sectorName)}
          </div>
        </div>
        <Zap className="w-4 h-4 text-emerald-400 shrink-0" />
      </div>
    </div>
  );
}

function SignalToastContainer({ toasts, onRemove }: { toasts: ToastSignal[]; onRemove: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <SignalToastItem key={t.id} toast={t} onDone={() => onRemove(t.id)} />
      ))}
    </div>
  );
}

// ── Audio chime ───────────────────────────────────────────────────────────────

function playChime() {
  try {
    const ctx = new AudioContext();
    const notes = [523.25, 659.25];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.18);
      gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.18);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.35);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.4);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // silent
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

type MobileTab = "picks" | "signals" | "sectors";

export default function Dashboard() {
  const { data: sectorsData, isLoading: isLoadingSectors, isFetching: isFetchingSectors, refetch: refetchSectors } = useGetSectors({
    query: { queryKey: getGetSectorsQueryKey() },
  });

  const { data: momentumData, isLoading: isLoadingMomentum, isFetching: isFetchingMomentum, refetch: refetchMomentum } = useGetMomentumPicks({
    query: { queryKey: getGetMomentumPicksQueryKey() },
  });

  const [manualRefreshing, setManualRefreshing] = useState(false);
  const isRefreshing = manualRefreshing || isFetchingSectors || isFetchingMomentum;

  // ── Auto-poll countdown ────────────────────────────────────────────────────
  const [countdown, setCountdown] = useState(POLL_INTERVAL);
  const [marketOpen, setMarketOpen] = useState(isMarketOpen);
  const isAutoPolling = marketOpen && !isRefreshing;

  // Countdown tick — runs every second, checks market open, fires auto-refresh
  const countdownRef = useRef(POLL_INTERVAL);
  useEffect(() => {
    const tick = setInterval(() => {
      const open = isMarketOpen();
      setMarketOpen(open);
      if (!open) {
        // Reset so it's ready when market opens
        countdownRef.current = POLL_INTERVAL;
        setCountdown(POLL_INTERVAL);
        return;
      }
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) {
        countdownRef.current = POLL_INTERVAL;
        setCountdown(POLL_INTERVAL);
        refetchSectors();
        refetchMomentum();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [refetchSectors, refetchMomentum]);

  const [toasts, setToasts] = useState<ToastSignal[]>([]);
  const toastIdRef = useRef(0);

  function addToasts(newSignals: Array<{ symbol: string; sectorName: string; entry: number }>) {
    setToasts((prev) => [...prev, ...newSignals.map((s) => ({ ...s, id: ++toastIdRef.current }))]);
  }
  function removeToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  const [alertsOn, setAlertsOn] = useState<boolean>(() => {
    try { return localStorage.getItem("sentinel_alerts") !== "off"; } catch { return true; }
  });
  function toggleAlerts() {
    setAlertsOn((prev) => {
      const next = !prev;
      try { localStorage.setItem("sentinel_alerts", next ? "on" : "off"); } catch {}
      return next;
    });
  }

  // Mobile tab state
  const [mobileTab, setMobileTab] = useState<MobileTab>("picks");

  const prevSignalsRef = useRef<Set<string>>(new Set());
  const isFirstFetch = useRef(true);

  useEffect(() => {
    if (!momentumData?.sectors) return;
    const current = new Set<string>();
    const newSignals: Array<{ symbol: string; sectorName: string; entry: number }> = [];
    for (const sector of momentumData.sectors) {
      for (const stock of sector.stocks) {
        if (stock.entrySignal === true) {
          current.add(stock.symbol);
          if (!isFirstFetch.current && !prevSignalsRef.current.has(stock.symbol)) {
            newSignals.push({ symbol: stock.symbol, sectorName: sector.sectorName, entry: stock.confirmedClose ?? stock.ltp ?? 0 });
          }
        }
      }
    }
    if (!isFirstFetch.current && newSignals.length > 0) {
      if (alertsOn) playChime();
      addToasts(newSignals);
    }
    isFirstFetch.current = false;
    prevSignalsRef.current = current;
  }, [momentumData, alertsOn]);

  function handleRefresh() {
    // Reset countdown so auto-poll restarts from 60 after manual refresh
    countdownRef.current = POLL_INTERVAL;
    setCountdown(POLL_INTERVAL);
    setManualRefreshing(true);
    Promise.all([refetchSectors(), refetchMomentum()]).finally(() => {
      setTimeout(() => setManualRefreshing(false), 600);
    });
  }

  const sessionLabel = momentumData?.indicatorDate
    ? momentumData.isLiveSession ? "Live" : formatSessionDate(momentumData.indicatorDate)
    : null;

  const sessionDateFull = momentumData?.indicatorDate && !momentumData.isLiveSession
    ? formatSessionDateFull(momentumData.indicatorDate)
    : null;

  const updatedIST = momentumData?.fetchedAt ? toISTDisplay(momentumData.fetchedAt) : null;
  const topPicks = momentumData?.topPicks ?? [];
  const hasTopPicks = topPicks.length > 0;

  // ── Shared action buttons ─────────────────────────────────────────────────
  const AlertBtn = () => (
    <button
      onClick={toggleAlerts}
      title={alertsOn ? "Alerts on" : "Alerts muted"}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all text-xs
        ${alertsOn
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
          : "border-border/40 bg-card text-muted-foreground/50"}`}
    >
      {alertsOn ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">{alertsOn ? "Alerts on" : "Muted"}</span>
    </button>
  );

  const RefreshBtn = () => (
    <div className="flex items-center gap-2">
      <CountdownRing seconds={countdown} active={isAutoPolling} scanning={isRefreshing} />
      <button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/40 bg-card hover:bg-accent/30 disabled:opacity-50 transition-all text-xs text-muted-foreground"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-emerald-400" : ""}`} />
        <span className="hidden sm:inline">{isRefreshing ? "Scanning…" : "Refresh"}</span>
      </button>
    </div>
  );

  // ── Mobile tab bar ────────────────────────────────────────────────────────
  const tabs: { id: MobileTab; label: string; Icon: React.ElementType }[] = [
    { id: "picks", label: "Picks", Icon: Zap },
    { id: "signals", label: "Signals", Icon: TrendingUp },
    { id: "sectors", label: "Sectors", Icon: BarChart2 },
  ];

  return (
    <Layout>
      <SignalToastContainer toasts={toasts} onRemove={removeToast} />

      {/* ══════════════ MOBILE LAYOUT (< md) ══════════════ */}
      <div className="md:hidden flex flex-col min-h-[calc(100vh-3.5rem)]">
        {/* Scrolling ticker */}
        <Ticker />

        {/* Compact mobile session bar */}
        <div className="border-b border-border/30 bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 px-3 py-2">
            <ISTClock />
            {momentumData?.isLiveSession && sessionLabel && !isLoadingMomentum && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                {sessionLabel}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <AlertBtn />
              <RefreshBtn />
            </div>
          </div>
          {/* Stale data strip — mobile */}
          {sessionDateFull && !isLoadingMomentum && (
            <div className="px-3 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70" />
                <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">Previous Session</span>
              </div>
              <span className="text-[10px] text-amber-300/80 font-medium">
                {sessionDateFull.dayOfWeek}, {sessionDateFull.long}
              </span>
              <span className="text-[10px] text-muted-foreground/60">·</span>
              <span className="text-[10px] text-muted-foreground font-mono">{sessionDateFull.daysAgo}</span>
              {momentumData?.lastCandleTimeIST && (
                <>
                  <span className="text-[10px] text-muted-foreground/60">·</span>
                  <span className="text-[10px] text-muted-foreground font-mono">last candle {momentumData.lastCandleTimeIST} IST</span>
                </>
              )}
              {updatedIST && (
                <>
                  <span className="text-[10px] text-muted-foreground/60">·</span>
                  <span className="text-[10px] text-muted-foreground font-mono">refreshed {updatedIST}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto pb-20">

          {/* ── PICKS TAB ── */}
          {mobileTab === "picks" && (
            <div className="px-3 pt-4 pb-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-400">Top 5 Intraday Picks</h2>
              </div>
              {isLoadingMomentum ? (
                [1,2,3,4,5].map((i) => <Skeleton key={i} className="w-full h-48 rounded-xl" />)
              ) : hasTopPicks ? (
                topPicks.map((pick, i) => (
                  <TopPickCard key={pick.symbol} pick={pick} rank={i + 1} fullWidth />
                ))
              ) : (
                <div className="rounded-xl border border-border/30 bg-card/30 p-8 text-center">
                  <Zap className="w-8 h-8 text-emerald-400/30 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {momentumData?.isLiveSession
                      ? "No entry signals yet — VWAP+EMA20 both need to align. EMA20 requires ~20 candles (11:00 AM IST)."
                      : "No picks this session. Top picks appear once VWAP and EMA20 align."}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── SIGNALS TAB ── */}
          {mobileTab === "signals" && (
            <div className="px-3 pt-4 pb-4 space-y-6">
              {isLoadingMomentum ? (
                [1, 2].map((i) => (
                  <div key={i} className="space-y-3">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-28 w-full rounded-xl" />
                    <Skeleton className="h-28 w-full rounded-xl" />
                  </div>
                ))
              ) : momentumData?.sectors.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  No signals found for this session.
                </div>
              ) : (
                momentumData?.sectors.map((sector) => {
                  const entryStocks = sector.stocks.filter((s) => s.entrySignal === true);
                  if (entryStocks.length === 0) return null;
                  return (
                    <div key={sector.sectorKeyword}>
                      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/30">
                        <div className={`w-1 h-4 rounded-full ${sector.sectorChangePct >= 0 ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="font-bold text-sm text-foreground">{cleanSectorName(sector.sectorName)}</span>
                        <span className={`text-xs font-mono font-semibold ${getColorClass(sector.sectorChangePct)}`}>
                          {formatPercent(sector.sectorChangePct)}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">{entryStocks.length} signal{entryStocks.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="space-y-2">
                        {entryStocks.map((stock) => (
                          <StockCard key={stock.symbol} stock={stock} />
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* ── SECTORS TAB ── */}
          {mobileTab === "sectors" && (
            <div className="px-3 pt-4 pb-4 space-y-4">
              {/* Sector performance */}
              <div className="rounded-xl border border-border/40 bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border/30 bg-muted/20 flex items-center gap-2">
                  <BarChart2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Sector Performance</h3>
                </div>
                <div className="divide-y divide-border/20">
                  {isLoadingSectors ? (
                    <div className="space-y-2 p-3">
                      {[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
                    </div>
                  ) : (
                    sectorsData
                      ?.filter((s, i, arr) => arr.findIndex((x) => x.keyword === s.keyword) === i)
                      .map((sector) => (
                        <div key={sector.keyword} className="flex items-center justify-between px-4 py-3">
                          <span className="text-sm text-foreground/80">{cleanSectorName(sector.name)}</span>
                          <span className={`text-sm font-mono font-semibold ${getColorClass(sector.changePct)}`}>
                            {formatPercent(sector.changePct)}
                          </span>
                        </div>
                      ))
                  )}
                </div>
              </div>

              {/* Smart Exit Rules */}
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Smart Exit Rules</span>
                </div>
                <div className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
                  <p>• Exit if any 5-min candle closes <span className="text-foreground/70 font-medium">below VWAP</span></p>
                  <p>• At T1, move SL to <span className="text-foreground/70 font-medium">breakeven</span> (entry price)</p>
                  <p>• Book full at T2 or exit by <span className="text-foreground/70 font-medium">15:15 IST</span></p>
                  <p>• SL is set <span className="text-foreground/70 font-medium">0.4% below VWAP</span> support</p>
                </div>
              </div>

              {/* Signal Key */}
              <div className="rounded-xl border border-border/30 bg-card p-4 space-y-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Signal Key</span>
                <div className="space-y-2 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/25 font-mono text-xs">VWAP ↑</span>
                    <span>Close above VWAP</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/25 font-mono text-xs">EMA ↑</span>
                    <span>Close above EMA20</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-[9px] px-2 py-0.5">ENTRY</span>
                    <span>Both aligned — trade setup</span>
                  </div>
                </div>
              </div>

              {updatedIST && !isLoadingMomentum && (
                <p className="text-center text-xs text-muted-foreground pb-2">
                  Last refreshed {updatedIST}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Fixed bottom tab bar */}
        <div className="fixed bottom-0 inset-x-0 z-40 h-16 bg-card/95 backdrop-blur-sm border-t border-border flex safe-area-inset-bottom">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setMobileTab(id)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all duration-150 ${
                mobileTab === id
                  ? "text-emerald-400"
                  : "text-muted-foreground/50 hover:text-muted-foreground"
              }`}
            >
              <Icon className={`w-5 h-5 transition-all ${mobileTab === id ? "drop-shadow-[0_0_6px_rgba(52,211,153,0.6)]" : ""}`} />
              <span className="text-[10px] font-semibold tracking-wide">{label}</span>
              {mobileTab === id && (
                <div className="absolute bottom-0 w-8 h-0.5 bg-emerald-400 rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════ DESKTOP LAYOUT (≥ md) ══════════════ */}
      <div className="hidden md:block">
        <Ticker />

        {/* Session bar */}
        <div className="border-b border-border/30 bg-background/80 backdrop-blur-sm">
          <div className="px-4 py-2 flex items-center gap-4">
            <ISTClock />
            {momentumData?.isLiveSession && sessionLabel && !isLoadingMomentum && (
              <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                ● {sessionLabel}
              </span>
            )}
            {momentumData?.isLiveSession && momentumData?.lastCandleTimeIST && !isLoadingMomentum && (
              <span className="text-xs text-muted-foreground font-mono hidden lg:block">
                last candle {momentumData.lastCandleTimeIST} IST
              </span>
            )}
            <div className="ml-auto flex items-center gap-3">
              {momentumData?.isLiveSession && updatedIST && !isLoadingMomentum && (
                <span className="text-xs text-muted-foreground hidden xl:block">refreshed {updatedIST}</span>
              )}
              <AlertBtn />
              <RefreshBtn />
            </div>
          </div>
          {/* Stale data strip — desktop */}
          {sessionDateFull && !isLoadingMomentum && (
            <div className="px-4 pb-2.5 flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80 animate-pulse" />
                <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wider">Previous Session</span>
              </div>
              <span className="text-border/60">·</span>
              <span className="text-[11px] text-amber-300/90 font-semibold">
                {sessionDateFull.dayOfWeek}, {sessionDateFull.long}
              </span>
              <span className="text-[11px] text-muted-foreground/50 font-mono">({sessionDateFull.daysAgo})</span>
              {momentumData?.lastCandleTimeIST && (
                <>
                  <span className="text-border/60">·</span>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    Last candle <span className="text-foreground/70 font-semibold">{momentumData.lastCandleTimeIST} IST</span>
                  </span>
                </>
              )}
              {updatedIST && (
                <>
                  <span className="text-border/60">·</span>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    Refreshed <span className="text-foreground/60">{updatedIST}</span>
                  </span>
                </>
              )}
              <span className="text-border/60">·</span>
              <span className="text-[11px] text-muted-foreground/50 italic">Signals are from last trading session</span>
            </div>
          )}
        </div>

        {/* Top 5 Intraday Picks */}
        <div className="border-b border-border/30 bg-gradient-to-r from-emerald-950/20 via-background to-background">
          <div className="px-4 pt-4 pb-1 flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-400">Top 5 Intraday Picks</h2>
          </div>
          {isLoadingMomentum ? (
            <div className="flex gap-3 px-4 pb-4">
              {[1,2,3,4,5].map((i) => (
                <Skeleton key={i} className="flex-1 min-w-[180px] h-[220px] rounded-xl" />
              ))}
            </div>
          ) : hasTopPicks ? (
            <div className="flex gap-3 px-4 pb-4">
              {topPicks.map((pick, i) => (
                <TopPickCard key={pick.symbol} pick={pick} rank={i + 1} />
              ))}
            </div>
          ) : (
            <div className="px-4 pb-4">
              <div className="rounded-xl border border-border/30 bg-card/30 p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {momentumData?.isLiveSession
                    ? "No entry signals yet — VWAP+EMA20 both need to align above the close. EMA20 requires 20 candles (~11:00 AM IST)."
                    : "Showing last session's signals. Top picks appear once VWAP and EMA20 align."}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Main content: sectors + sidebar */}
        <div className="px-4 py-6">
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Sectors + stocks */}
            <div className="flex-1 min-w-0 space-y-6">
              {isLoadingMomentum ? (
                <div className="space-y-6">
                  {[1, 2].map((i) => (
                    <div key={i} className="space-y-3">
                      <Skeleton className="h-7 w-40" />
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                        {[1, 2, 3, 4].map((j) => <Skeleton key={j} className="h-32 w-full rounded-xl" />)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : momentumData?.sectors.length === 0 ? (
                <div className="p-12 text-center border border-border/30 rounded-xl bg-card/30 text-muted-foreground">
                  No momentum stocks found in the current market window.
                </div>
              ) : (
                <div className="space-y-8">
                  {momentumData?.sectors.map((sector) => {
                    const entryStocks = sector.stocks.filter((s) => s.entrySignal === true);
                    return (
                      <div key={sector.sectorKeyword}>
                        <div className="flex items-center gap-3 mb-3 pb-2 border-b border-border/30">
                          <div className={`w-1 h-5 rounded-full ${sector.sectorChangePct >= 0 ? "bg-emerald-500" : "bg-rose-500"}`} />
                          <h3 className="font-bold text-foreground">{cleanSectorName(sector.sectorName)}</h3>
                          <span className={`text-sm font-mono font-semibold ${getColorClass(sector.sectorChangePct)}`}>
                            {formatPercent(sector.sectorChangePct)}
                          </span>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {entryStocks.length} signal{entryStocks.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        {entryStocks.length > 0 ? (
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                            {entryStocks.map((stock) => (
                              <StockCard key={stock.symbol} stock={stock} />
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">
                            No entry signals in this sector yet.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="w-full lg:w-72 shrink-0 space-y-4">
              <div className="rounded-xl border border-border/40 bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border/30 bg-muted/20 flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Sector Performance</h3>
                </div>
                <div className="divide-y divide-border/20">
                  {isLoadingSectors ? (
                    <div className="space-y-2 p-3">
                      {[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                    </div>
                  ) : (
                    sectorsData
                      ?.filter((s, i, arr) => arr.findIndex((x) => x.keyword === s.keyword) === i)
                      .map((sector) => (
                        <div key={sector.keyword} className="flex items-center justify-between px-4 py-2.5 hover:bg-accent/20 transition-colors">
                          <span className="text-sm text-foreground/80">{cleanSectorName(sector.name)}</span>
                          <span className={`text-sm font-mono font-semibold ${getColorClass(sector.changePct)}`}>
                            {formatPercent(sector.changePct)}
                          </span>
                        </div>
                      ))
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Smart Exit Rules</span>
                </div>
                <div className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
                  <p>• Exit if any 5-min candle closes <span className="text-foreground/70 font-medium">below VWAP</span></p>
                  <p>• At T1, move SL to <span className="text-foreground/70 font-medium">breakeven</span> (entry price)</p>
                  <p>• Book full at T2 or exit by <span className="text-foreground/70 font-medium">15:15 IST</span></p>
                  <p>• SL is set <span className="text-foreground/70 font-medium">0.4% below VWAP</span> support</p>
                </div>
              </div>

              <div className="rounded-xl border border-border/30 bg-card p-4 space-y-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Signal Key</span>
                <div className="space-y-1.5 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/25 font-mono">VWAP ↑</span>
                    <span>Close above VWAP</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/25 font-mono">EMA ↑</span>
                    <span>Close above EMA20</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-[9px] px-2">ENTRY</span>
                    <span>Both aligned — trade setup</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
