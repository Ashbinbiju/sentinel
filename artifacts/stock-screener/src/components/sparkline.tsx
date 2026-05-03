interface SparklineProps {
  closes: number[];
  vwap?: number | null;
  height?: number;
  id: string;
}

export function Sparkline({ closes, vwap, height = 38, id }: SparklineProps) {
  if (!closes || closes.length < 3) return null;

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || max * 0.002 || 1;
  const pad = range * 0.1;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo;

  const W = 100;
  const H = height;

  const toX = (i: number) => (i / (closes.length - 1)) * W;
  const toY = (v: number) => H - ((v - lo) / span) * H;

  const pts = closes.map((c, i) => `${toX(i).toFixed(2)},${toY(c).toFixed(2)}`).join(" ");

  const firstClose = closes[0];
  const lastClose = closes[closes.length - 1];
  const isUp = lastClose >= firstClose;
  const color = isUp ? "#34d399" : "#f87171";
  const gradId = `sl-${id}`;

  const firstPt = `${toX(0).toFixed(2)},${toY(firstClose).toFixed(2)}`;
  const lastPt = `${toX(closes.length - 1).toFixed(2)},${toY(lastClose).toFixed(2)}`;
  const fillD = `M${firstPt} ${closes.slice(1).map((c, i) => `L${toX(i + 1).toFixed(2)},${toY(c).toFixed(2)}`).join(" ")} L${W},${H} L0,${H} Z`;

  const vwapY = vwap != null ? toY(vwap) : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height, display: "block" }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={fillD} fill={`url(#${gradId})`} />

      {vwapY != null && vwapY >= 0 && vwapY <= H && (
        <line
          x1="0" y1={vwapY.toFixed(2)}
          x2={W} y2={vwapY.toFixed(2)}
          stroke="#60a5fa"
          strokeWidth="0.8"
          strokeDasharray="3 2"
          strokeOpacity="0.55"
        />
      )}

      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeOpacity="0.9"
      />

      <circle
        cx={lastPt.split(",")[0]}
        cy={lastPt.split(",")[1]}
        r="1.8"
        fill={color}
        fillOpacity="1"
      />
    </svg>
  );
}
