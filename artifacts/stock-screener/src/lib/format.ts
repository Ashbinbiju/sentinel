export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function parseUtcTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  let normalized = String(value).trim();
  if (!normalized) return null;
  if (!normalized.includes("T")) normalized = normalized.replace(" ", "T");

  const timezoneMatch = normalized.match(/([+-]\d{2})(?::?(\d{2}))?$/);
  if (timezoneMatch) {
    const [, hours, minutes] = timezoneMatch;
    normalized = normalized.replace(/([+-]\d{2})(?::?(\d{2}))?$/, `${hours}:${minutes ?? "00"}`);
  } else if (!normalized.endsWith("Z")) {
    normalized += "Z";
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toISTTime(value: string | null | undefined): string {
  const date = parseUtcTimestamp(value);
  if (!date) return "-";

  const ist = new Date(date.getTime() + 19800000);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

export function toISTDisplay(value: string | null | undefined): string {
  const time = toISTTime(value);
  return time === "-" ? "" : `${time} IST`;
}

export function getColorClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-muted-foreground";
}

export function getBgColorClass(value: number): string {
  if (value > 0) return "bg-emerald-500/10 text-emerald-400";
  if (value < 0) return "bg-rose-500/10 text-rose-400";
  return "bg-muted text-muted-foreground";
}
