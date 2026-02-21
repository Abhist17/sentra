import axios from "axios";
import { CONFIG } from "../config/env";

export async function sendTelegramAlert(message: string) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
      }
    );

    console.log("📩 Alert sent");
  } catch {
    console.log("Telegram error (ignored)");
  }
}