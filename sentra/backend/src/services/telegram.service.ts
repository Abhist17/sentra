import axios from "axios";
import { CONFIG } from "../config/env";

type TelegramResponse = { ok: boolean; description?: string };

let warnedMissingCredentials = false;

export function telegramConfigured(): boolean {
  return Boolean(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID);
}

export async function sendTelegramAlert(message: string): Promise<boolean> {
  if (!telegramConfigured()) {
    // The engine calls this on a timer — logging every miss buries the log.
    if (!warnedMissingCredentials) {
      console.warn(
        "⚠️  Telegram credentials missing — alerts disabled " +
          "(set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)"
      );
      warnedMissingCredentials = true;
    }
    return false;
  }

  try {
    const res = await axios.post<TelegramResponse>(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        // Kept as a string: Number() breaks @channel usernames and loses
        // precision on chat ids beyond Number.MAX_SAFE_INTEGER.
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true,
      },
      { timeout: 10_000 }
    );

    if (res.data.ok) {
      console.log("📩 Telegram alert sent");
      return true;
    }

    console.error("❌ Telegram rejected:", res.data.description);
    return false;
  } catch (err: any) {
    console.error(
      "❌ Telegram error:",
      err?.response?.data ?? err?.message ?? err
    );
    return false;
  }
}
