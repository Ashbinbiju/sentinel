import { ReactNode } from "react";
import { Link } from "wouter";

function SentinelLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Radar arcs from bottom-left origin */}
      <circle cx="4" cy="28" r="7"  stroke="#34d399" strokeWidth="1.4" strokeOpacity="0.25" fill="none" strokeDasharray="11 100" strokeLinecap="round"/>
      <circle cx="4" cy="28" r="13" stroke="#34d399" strokeWidth="1.4" strokeOpacity="0.45" fill="none" strokeDasharray="20 100" strokeLinecap="round"/>
      <circle cx="4" cy="28" r="20" stroke="#34d399" strokeWidth="1.4" strokeOpacity="0.65" fill="none" strokeDasharray="31.4 100" strokeLinecap="round"/>
      <circle cx="4" cy="28" r="27" stroke="#34d399" strokeWidth="1.4" strokeOpacity="0.85" fill="none" strokeDasharray="42.5 100" strokeLinecap="round"/>
      {/* Sweep line */}
      <line x1="4" y1="28" x2="27" y2="5" stroke="#34d399" strokeWidth="1.2" strokeOpacity="0.9" strokeLinecap="round"/>
      {/* Blip dot on sweep */}
      <circle cx="20" cy="12" r="1.8" fill="#34d399" fillOpacity="0.95"/>
      <circle cx="20" cy="12" r="3" stroke="#34d399" strokeWidth="0.8" strokeOpacity="0.3" fill="none"/>
      {/* Origin dot */}
      <circle cx="4" cy="28" r="1.2" fill="#34d399" fillOpacity="0.7"/>
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="px-4 h-14 flex items-center">
          <Link href="/" className="font-bold text-lg tracking-tight flex items-center gap-2.5 text-foreground group">
            <SentinelLogo className="h-7 w-7 drop-shadow-[0_0_8px_rgba(52,211,153,0.6)] group-hover:drop-shadow-[0_0_14px_rgba(52,211,153,0.8)] transition-all duration-200" />
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
