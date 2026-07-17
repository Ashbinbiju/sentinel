import { OpenWAClient } from "@rmyndharis/openwa";

export class Notifier {
  private client: OpenWAClient;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    this.enabled = process.env.ENABLE_WHATSAPP === "true";
    const phone = process.env.WHATSAPP_PHONE || "";
    
    // Convert local number to international if missing country code
    let formattedPhone = phone;
    if (formattedPhone && !formattedPhone.startsWith("91") && formattedPhone.length === 10) {
      formattedPhone = "91" + formattedPhone;
    }
    
    this.chatId = `${formattedPhone}@c.us`;

    this.client = new OpenWAClient({
      baseUrl: process.env.OPENWA_URL || "http://localhost:2785",
      // apiKey is optional for local unauthenticated instances
      ...(process.env.OPENWA_API_KEY && { apiKey: process.env.OPENWA_API_KEY })
    });
  }

  private async send(text: string) {
    if (!this.enabled || !this.chatId || this.chatId === "@c.us") return;
    try {
      await this.client.messages.sendText("default", {
        chatId: this.chatId,
        text,
      });
    } catch (err: any) {
      console.error("[NOTIFIER] Failed to send WhatsApp message:", err.message || err);
    }
  }

  public async sendTradeEntry(symbol: string, direction: string, entryPrice: number, target: number, sl: number) {
    const icon = direction === "BUY" ? "🟢" : "🔴";
    const text = `🚨 *NEW ENTRY* 🚨\n\n${icon} *${symbol}* ${direction}\n\n*Entry:* ₹${entryPrice}\n*Target:* ₹${target}\n*SL:* ₹${sl}`;
    await this.send(text);
  }

  public async sendTradeExit(symbol: string, direction: string, pnl: number, exitPrice: number) {
    const icon = pnl > 0 ? "✅" : pnl < 0 ? "❌" : "➖";
    const pnlSign = pnl > 0 ? "+" : "";
    const text = `${icon} *SQUARED OFF* ${icon}\n\n*${symbol}* ${direction}\n*Exit Price:* ₹${exitPrice.toFixed(2)}\n*PnL:* ${pnlSign}${(pnl * 100).toFixed(2)}%`;
    await this.send(text);
  }

  public async sendTrailApplied(symbol: string, newSl: number) {
    const text = `🛡️ *SL TRAILED*\n\n*${symbol}* has reached 1.5R.\n*New SL (Breakeven):* ₹${newSl.toFixed(2)}`;
    await this.send(text);
  }

  public async sendKillSwitch(pnl: number, lossCount: number) {
    const text = `🛑 *KILL SWITCH ENGAGED* 🛑\n\nMax loss limit or consecutive losses reached.\n*Realized PnL:* ₹${pnl.toFixed(2)}\n*Consecutive Losses:* ${lossCount}\n\nAll trading halted.`;
    await this.send(text);
  }

  public async sendSystemAlert(message: string) {
    const text = `⚠️ *SYSTEM ALERT* ⚠️\n\n${message}`;
    await this.send(text);
  }
}
