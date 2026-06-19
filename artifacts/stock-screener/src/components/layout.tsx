import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, ChevronDown, History as HistoryIcon, LineChart } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function SentinelLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="sentGreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981"/>
          <stop offset="100%" stopColor="#34d399"/>
        </linearGradient>
        <linearGradient id="sentRed" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f87171"/>
          <stop offset="100%" stopColor="#ef4444"/>
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="1.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* ── Baseline grid lines ── */}
      <line x1="2" y1="34" x2="46" y2="34" stroke="#1e293b" strokeWidth="0.5"/>
      <line x1="2" y1="24" x2="46" y2="24" stroke="#1e293b" strokeWidth="0.4" strokeDasharray="2 3"/>
      <line x1="2" y1="14" x2="46" y2="14" stroke="#1e293b" strokeWidth="0.4" strokeDasharray="2 3"/>

      {/* ── Candle 1 — Bear (red), c1 centre x=7 ── */}
      <line x1="7" y1="20" x2="7" y2="22" stroke="url(#sentRed)" strokeWidth="1" strokeLinecap="round"/>
      <rect x="4.5" y="22" width="5" height="7" rx="0.7" fill="url(#sentRed)" fillOpacity="0.85"/>
      <line x1="7" y1="29" x2="7" y2="32" stroke="url(#sentRed)" strokeWidth="1" strokeLinecap="round"/>

      {/* ── Candle 2 — Bull (green), c2 centre x=16 ── */}
      <line x1="16" y1="16" x2="16" y2="18" stroke="url(#sentGreen)" strokeWidth="1" strokeLinecap="round"/>
      <rect x="13.5" y="18" width="5" height="9" rx="0.7" fill="url(#sentGreen)" fillOpacity="0.85"/>
      <line x1="16" y1="27" x2="16" y2="30" stroke="url(#sentGreen)" strokeWidth="1" strokeLinecap="round"/>

      {/* ── Candle 3 — Bull (green), c3 centre x=25 ── */}
      <line x1="25" y1="10" x2="25" y2="13" stroke="url(#sentGreen)" strokeWidth="1" strokeLinecap="round"/>
      <rect x="22.5" y="13" width="5" height="12" rx="0.7" fill="url(#sentGreen)" fillOpacity="0.9"/>
      <line x1="25" y1="25" x2="25" y2="28" stroke="url(#sentGreen)" strokeWidth="1" strokeLinecap="round"/>

      {/* ── Candle 4 — Bull (green), tallest, c4 centre x=34 — ENTRY candle ── */}
      <line x1="34" y1="5" x2="34" y2="8" stroke="url(#sentGreen)" strokeWidth="1.1" strokeLinecap="round"/>
      <rect x="31.5" y="8" width="5" height="16" rx="0.7" fill="url(#sentGreen)" fillOpacity="0.95"/>
      <line x1="34" y1="24" x2="34" y2="27" stroke="url(#sentGreen)" strokeWidth="1.1" strokeLinecap="round"/>

      {/* ── EMA curve (smooth arc over candle tops) ── */}
      <path
        d="M 7,21 C 10,21 12,17 16,17 C 20,17 22,12 25,11 C 28,10 31,7 34,6"
        stroke="#34d399"
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
        strokeOpacity="0.55"
        strokeDasharray="2.5 2"
      />

      {/* ── VWAP line (slightly below EMA) ── */}
      <path
        d="M 7,24 C 10,23 13,21 16,20 C 20,19 22,15 25,14 C 29,13 31,10 34,9"
        stroke="#60a5fa"
        strokeWidth="0.9"
        strokeLinecap="round"
        fill="none"
        strokeOpacity="0.45"
        strokeDasharray="1.5 2.5"
      />

      {/* ── Signal burst at entry candle top ── */}
      <circle cx="34" cy="5" r="4" stroke="#34d399" strokeWidth="1" fill="#34d399" fillOpacity="0.12" filter="url(#glow)" strokeOpacity="0.9"/>
      <circle cx="34" cy="5" r="1.5" fill="#34d399" fillOpacity="1" filter="url(#glow)"/>

      {/* ── UP arrow above signal ── */}
      <polyline
        points="34,2.5 36,4.5 34,4.5 34,2.5 32,4.5 34,4.5"
        stroke="#34d399"
        strokeWidth="0.7"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
        strokeOpacity="0.0"
      />
      <path d="M 33,1.5 L 34,-0.2 L 35,1.5" stroke="#34d399" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" fill="none" strokeOpacity="0.85"/>
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const scannerActive = location === "/" || location === "/swing";
  const scannerLabel = location === "/swing" ? "Swing Scanner" : "Intraday Scanner";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="px-4 h-14 flex items-center justify-between">
          <Link href="/" className="font-bold text-lg tracking-tight flex items-center gap-2.5 text-foreground group">
            <SentinelLogo className="h-8 w-10 drop-shadow-[0_0_10px_rgba(52,211,153,0.55)] group-hover:drop-shadow-[0_0_18px_rgba(52,211,153,0.85)] transition-all duration-200" />
            <span className="tracking-[0.12em] font-extrabold bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-300 bg-clip-text text-transparent">
              SENTINEL
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold rounded-md transition-colors outline-none ${
                  scannerActive
                    ? "bg-emerald-500/10 text-emerald-400"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                <BarChart3 className="h-4 w-4" />
                <span className="hidden sm:inline">{scannerLabel}</span>
                <span className="sm:hidden">Scanner</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem asChild>
                  <Link href="/" className="flex items-center gap-2 cursor-pointer">
                    <BarChart3 className="h-4 w-4" />
                    Intraday Scanner
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/swing" className="flex items-center gap-2 cursor-pointer">
                    <LineChart className="h-4 w-4" />
                    Swing Scanner
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link
              href="/history"
              className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${
                location === "/history"
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              <HistoryIcon className="h-4 w-4" />
              <span className="hidden sm:inline">History</span>
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
