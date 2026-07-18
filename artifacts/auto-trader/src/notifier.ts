/**
 * Notifier — WhatsApp integration removed.
 * All methods are no-ops; the public interface is preserved so callers
 * (ExecutionEngine, etc.) compile without changes.
 */
export class Notifier {
  private enabled: boolean = false;

  constructor() {
    // WhatsApp gateway removed. Set ENABLE_WHATSAPP="true" in a future
    // integration to re-enable; for now notifications are silently disabled.
    if (process.env.ENABLE_WHATSAPP === "true") {
      console.warn("[NOTIFIER] ENABLE_WHATSAPP is set but no notification backend is configured. Notifications disabled.");
    }
  }

  private async send(_text: string): Promise<void> {
    // no-op
  }

  public async sendTradeEntry(symbol: string, direction: string, entryPrice: number, target: number, sl: number): Promise<void> {
    const icon = direction === "BUY" ? "🟢" : "🔴";
    console.log(`[NOTIFIER] ${icon} NEW ENTRY: ${symbol} ${direction} | Entry: ₹${entryPrice} | Target: ₹${target} | SL: ₹${sl}`);
  }

  public async sendTradeExit(symbol: string, direction: string, pnl: number, exitPrice: number): Promise<void> {
    const icon = pnl > 0 ? "✅" : pnl < 0 ? "❌" : "➖";
    const pnlSign = pnl > 0 ? "+" : "";
    console.log(`[NOTIFIER] ${icon} SQUARED OFF: ${symbol} ${direction} | Exit: ₹${exitPrice.toFixed(2)} | PnL: ${pnlSign}${(pnl * 100).toFixed(2)}%`);
  }

  public async sendTrailApplied(symbol: string, newSl: number): Promise<void> {
    console.log(`[NOTIFIER] 🛡️ SL TRAILED: ${symbol} | New SL (Breakeven): ₹${newSl.toFixed(2)}`);
  }

  public async sendKillSwitch(pnl: number, lossCount: number): Promise<void> {
    console.log(`[NOTIFIER] 🛑 KILL SWITCH ENGAGED | PnL: ₹${pnl.toFixed(2)} | Consecutive Losses: ${lossCount}`);
  }

  public async sendSystemAlert(message: string): Promise<void> {
    console.log(`[NOTIFIER] ⚠️ SYSTEM ALERT: ${message}`);
  }
}
