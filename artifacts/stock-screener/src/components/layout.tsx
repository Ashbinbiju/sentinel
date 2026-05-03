import { ReactNode } from "react";
import { Link } from "wouter";

function SentinelLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 36 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Candle 1 — bear (red), leftmost, mid height */}
      <line x1="6" y1="14" x2="6" y2="16" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="3.5" y="16" width="5" height="8" rx="0.8" fill="#f87171" fillOpacity="0.9"/>
      <line x1="6" y1="24" x2="6" y2="27" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round"/>

      {/* Candle 2 — bull (green), taller */}
      <line x1="17" y1="8" x2="17" y2="11" stroke="#34d399" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="14.5" y="11" width="5" height="12" rx="0.8" fill="#34d399" fillOpacity="0.9"/>
      <line x1="17" y1="23" x2="17" y2="26" stroke="#34d399" strokeWidth="1.2" strokeLinecap="round"/>

      {/* Candle 3 — bull (green), tallest */}
      <line x1="28" y1="3" x2="28" y2="6" stroke="#34d399" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="25.5" y="6" width="5" height="14" rx="0.8" fill="#34d399" fillOpacity="0.95"/>
      <line x1="28" y1="20" x2="28" y2="24" stroke="#34d399" strokeWidth="1.2" strokeLinecap="round"/>

      {/* Trend line connecting candle tops */}
      <polyline
        points="6,14 17,8 28,3"
        stroke="#34d399"
        strokeWidth="1"
        strokeOpacity="0.35"
        strokeDasharray="2 2"
        strokeLinecap="round"
      />

      {/* Signal crosshair on candle 3 top */}
      <circle cx="28" cy="3" r="2.5" stroke="#34d399" strokeWidth="1.1" strokeOpacity="0.9" fill="none"/>
      <circle cx="28" cy="3" r="0.9" fill="#34d399" fillOpacity="0.95"/>
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="px-4 h-14 flex items-center">
          <Link href="/" className="font-bold text-lg tracking-tight flex items-center gap-2.5 text-foreground group">
            <SentinelLogo className="h-7 w-9 drop-shadow-[0_0_8px_rgba(52,211,153,0.5)] group-hover:drop-shadow-[0_0_14px_rgba(52,211,153,0.75)] transition-all duration-200" />
            <span className="tracking-[0.12em] font-extrabold bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-300 bg-clip-text text-transparent">
              SENTINEL
            </span>
          </Link>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
