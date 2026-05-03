import type { Logger } from "pino";

const IST_OFFSET_MS = 19800 * 1000;

function isMarketHours(): boolean {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

// In-memory set of symbols already notified this session (resets on server restart)
const notifiedToday = new Set<string>();
let notifiedDate = "";

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

function buildMessage(pick: TopPickForNotify): string {
  const volLine =
    pick.volumeRatio != null
      ? `\n📦 Volume: ${pick.volumeRatio.toFixed(1)}× avg${pick.volumeOk ? " ✅" : ""}`
      : "";

  return (
    `🚨 *SENTINEL SIGNAL*\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `*${pick.symbol}* · ${pick.sectorName}\n\n` +
    `📈 *Entry:* ₹${pick.entry.toFixed(2)}\n` +
    `🛡 *SL:* ₹${pick.sl.toFixed(2)} \\(-${pick.riskPct.toFixed(1)}%\\)\n` +
    `🎯 *T1:* ₹${pick.target1.toFixed(2)}\n` +
    `🎯 *T2:* ₹${pick.target2.toFixed(2)}\n` +
    `📊 *Change:* +${pick.changePct.toFixed(2)}%\n` +
    `〰 *VWAP:* ₹${pick.vwap.toFixed(2)}` +
    volLine +
    `\n\n[📉 Open Chart](https://www.tradingview.com/chart/?symbol=NSE%3A${pick.symbol})`
  );
}

export async function sendTelegramAlerts(
  picks: TopPickForNotify[],
  logger: Logger,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;
  if (!isMarketHours()) return;

  resetIfNewDay();

  const newPicks = picks.filter((p) => !notifiedToday.has(p.symbol));
  if (newPicks.length === 0) return;

  for (const pick of newPicks) {
    notifiedToday.add(pick.symbol);
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: buildMessage(pick),
            parse_mode: "MarkdownV2",
            disable_web_page_preview: false,
          }),
        },
      );
      if (!resp.ok) {
        const body = await resp.text();
        logger.warn({ symbol: pick.symbol, status: resp.status, body }, "Telegram send failed");
      } else {
        logger.info({ symbol: pick.symbol }, "Telegram alert sent");
      }
    } catch (err) {
      logger.error({ err, symbol: pick.symbol }, "Telegram alert error");
    }
  }
}
