import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  RPC_URL: process.env.RPC_URL || "http://127.0.0.1:8899",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  MONITOR_INTERVAL: 60 * 1000,
  HISTORY_REFRESH_INTERVAL: 60 * 60 * 1000,
  SHOCK_THRESHOLD: 5,
  RISK_ALERT_THRESHOLD: 25,
  ALERT_COOLDOWN: 5 * 60 * 1000,
};