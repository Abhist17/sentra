import dotenv from "dotenv";
dotenv.config();

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`⚠️  ${key}="${raw}" is not a number — using ${fallback}`);
    return fallback;
  }

  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const CONFIG = {
  // ── Network ──────────────────────────────────────────────
  // RPC_URL         → cluster we WRITE risk snapshots to (devnet/localnet)
  // MAINNET_RPC_URL → cluster we READ real wallet balances from
  RPC_URL: process.env.RPC_URL || "http://127.0.0.1:8899",
  MAINNET_RPC_URL:
    process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",

  // ── Server ───────────────────────────────────────────────
  PORT: num("PORT", 4000),
  // Comma-separated list of allowed origins, or "*" for any
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  // When set, mutating routes require header `x-api-key: <this>`
  API_KEY: process.env.API_KEY || "",

  // ── Wallet / signing ─────────────────────────────────────
  // Either an inline secret key (base58 or JSON array) or a path to a keypair
  SOLANA_SECRET_KEY: process.env.SOLANA_SECRET_KEY || "",
  SOLANA_KEYPAIR_PATH: process.env.SOLANA_KEYPAIR_PATH || "",

  // ── Engine tuning ────────────────────────────────────────
  MONITOR_INTERVAL: num("MONITOR_INTERVAL", 30 * 1000),
  HISTORY_REFRESH_INTERVAL: num("HISTORY_REFRESH_INTERVAL", 60 * 60 * 1000),
  SHOCK_THRESHOLD: num("SHOCK_THRESHOLD", 5),
  RISK_ALERT_THRESHOLD: num("RISK_ALERT_THRESHOLD", 25),
  ALERT_COOLDOWN: num("ALERT_COOLDOWN", 5 * 60 * 1000),

  // Fall back to a synthetic portfolio when a monitored wallet is empty.
  // Useful for demos — must be off for real reporting.
  SIMULATION_MODE: bool("SIMULATION_MODE", false),
  // Write risk scores on-chain. Each write rents a new snapshot account,
  // so it stays off unless explicitly enabled.
  ENABLE_ONCHAIN_WRITES: bool("ENABLE_ONCHAIN_WRITES", false),

  // ── Alerts ───────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",

  // ── Price feed ───────────────────────────────────────────
  // Optional CoinGecko demo/pro key — the free tier rate-limits hard
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || "",
};
