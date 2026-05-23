import type { Logger } from "pino";

const IST_OFFSET_MS = 19800 * 1000;

function getNowISTParts(): { h: number; m: number; day: number } {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return {
    h: now.getUTCHours(),
    m: now.getUTCMinutes(),
    day: now.getUTCDay(),
  };
}

function isMarketHours(): boolean {
  const { h, m, day } = getNowISTParts();
  if (day === 0 || day === 6) return false;

  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

// In-memory set of symbols already notified this session (resets on server restart)
const notifiedToday = new Set<string>();
let notifiedDate = "";
let missingConfigWarned = false;

function getTodayISTDate(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = getTodayISTDate();
  if (today !== notifiedDate) {
    notifiedToday.clear();
    notifiedDate = today;
  }
}

interface TopPickForNotify {
  symbol: string;
  sectorName: string;
  entry: number;
  sl: number;
  target1: number;
  target2: number;
  riskPct: number;
  changePct: number;
  vwap: number;
  volumeRatio: number | null;
  volumeOk: boolean | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSignedPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function buildMessage(pick: TopPickForNotify): string {
  const symbol = escapeHtml(pick.symbol);
  const sectorName = escapeHtml(pick.sectorName);
  const chartUrl = `https://www.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(pick.symbol)}`;
  const volLine =
    pick.volumeRatio != null
      ? `\nVolume: ${pick.volumeRatio.toFixed(1)}x avg${pick.volumeOk ? " OK" : ""}`
      : "";

  return (
    `<b>SENTINEL SIGNAL</b>\n` +
    `----------------\n` +
    `<b>${symbol}</b> - ${sectorName}\n\n` +
    `<b>Entry:</b> Rs ${pick.entry.toFixed(2)}\n` +
    `<b>SL:</b> Rs ${pick.sl.toFixed(2)} (-${pick.riskPct.toFixed(1)}%)\n` +
    `<b>T1:</b> Rs ${pick.target1.toFixed(2)}\n` +
    `<b>T2:</b> Rs ${pick.target2.toFixed(2)}\n` +
    `<b>Change:</b> ${formatSignedPct(pick.changePct)}\n` +
    `<b>VWAP:</b> Rs ${pick.vwap.toFixed(2)}` +
    volLine +
    `\n\n<a href="${chartUrl}">Open Chart</a>`
  );
}

export async function sendTelegramAlerts(
  picks: TopPickForNotify[],
  logger: Logger,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    if (!missingConfigWarned) {
      logger.warn("Telegram alerts disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
      missingConfigWarned = true;
    }
    return;
  }
  if (!isMarketHours()) return;

  resetIfNewDay();

  const newPicks = picks.filter((p) => !notifiedToday.has(p.symbol));
  if (newPicks.length === 0) return;

  for (const pick of newPicks) {
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: buildMessage(pick),
            parse_mode: "HTML",
            disable_web_page_preview: false,
          }),
        },
      );

      if (!resp.ok) {
        const body = await resp.text();
        logger.warn({ symbol: pick.symbol, status: resp.status, body }, "Telegram send failed");
      } else {
        notifiedToday.add(pick.symbol);
        logger.info({ symbol: pick.symbol }, "Telegram alert sent");
      }
    } catch (err) {
      logger.error({ err, symbol: pick.symbol }, "Telegram alert error");
    }
  }
}
