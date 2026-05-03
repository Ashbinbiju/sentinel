import { ReactNode } from "react";
import { Link, useLocation } from "wouter";

function SentinelLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Shield body */}
      <path
        d="M16 2L4 7v9c0 6.5 5.1 12.5 12 14 6.9-1.5 12-7.5 12-14V7L16 2z"
        fill="url(#shield-gradient)"
        stroke="url(#border-gradient)"
        strokeWidth="0.75"
      />
      {/* Scan line 1 */}
      <line x1="9" y1="13" x2="23" y2="13" stroke="#34d399" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round" />
      {/* Scan line 2 */}
      <line x1="9" y1="16" x2="23" y2="16" stroke="#34d399" strokeWidth="1.5" strokeOpacity="0.9" strokeLinecap="round" />
      {/* Scan line 3 */}
      <line x1="9" y1="19" x2="23" y2="19" stroke="#34d399" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round" />
      {/* Center eye dot */}
      <circle cx="16" cy="16" r="2.5" fill="#34d399" fillOpacity="0.95" />
      <circle cx="16" cy="16" r="1.2" fill="#ecfdf5" />
      <defs>
        <linearGradient id="shield-gradient" x1="16" y1="2" x2="16" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#064e3b" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#022c22" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="border-gradient" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <Link href="/" className="font-bold text-lg tracking-tight flex items-center gap-2.5 text-foreground group">
              <SentinelLogo className="h-7 w-7 drop-shadow-[0_0_6px_rgba(52,211,153,0.5)] group-hover:drop-shadow-[0_0_10px_rgba(52,211,153,0.7)] transition-all duration-200" />
              <span className="tracking-[0.12em] font-extrabold bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                SENTINEL
              </span>
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
