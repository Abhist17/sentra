import axios from "axios";
import { CONFIG } from "../config/env";

type TelegramResponse = { ok: boolean; description?: string };

export async function sendTelegramAlert(message: string) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.error("❌ Telegram credentials missing in .env");
    return;
  }

  try {
    const res = await axios.post<TelegramResponse>(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: Number(CONFIG.TELEGRAM_CHAT_ID),
        text: message,
      }
    );

    if (res.data.ok) {
      console.log("📩 Telegram alert sent");
    } else {
      console.error("❌ Telegram rejected:", res.data.description);
    }
  } catch (err: any) {
    console.error(
      "❌ Telegram error:",
      err?.response?.data ?? err?.message ?? err
    );
  }
}