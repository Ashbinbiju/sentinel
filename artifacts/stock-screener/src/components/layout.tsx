import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, Clock } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <Link href="/" className="font-bold text-lg tracking-tight flex items-center space-x-2 text-foreground">
              <Activity className="h-5 w-5 text-primary" />
              <span>TERMINAL</span>
            </Link>
            <nav className="flex space-x-1">
              <Link
                href="/"
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  location === "/" 
                    ? "bg-primary/10 text-primary" 
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                Dashboard
              </Link>
              <Link
                href="/history"
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  location === "/history" 
                    ? "bg-primary/10 text-primary" 
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                History
              </Link>
            </nav>
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
