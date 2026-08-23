import dotenv from "dotenv";
import path from "path";
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

/** Same as num() but refuses values outside [min, max] instead of letting a
 *  typo like MONITOR_INTERVAL=15 (15ms) hammer every upstream API. */
function clampedNum(key: string, fallback: number, min: number, max: number) {
  const parsed = num(key, fallback);
  if (parsed < min || parsed > max) {
    console.warn(
      `⚠️  ${key}=${parsed} is outside [${min}, ${max}] — using ${fallback}`
    );
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
  // Requests per minute per IP before the API starts returning 429
  RATE_LIMIT_PER_MIN: num("RATE_LIMIT_PER_MIN", 120),

  // Chrome blocks requests from a public page to a loopback/private address
  // unless the server opts in via Access-Control-Allow-Private-Network. That
  // opt-in is what lets the hosted dashboard talk to a locally run engine.
  // Turn it off if this engine is deployed publicly and never driven from a
  // page on another origin.
  ALLOW_PRIVATE_NETWORK: bool("ALLOW_PRIVATE_NETWORK", true),

  // Where the wallet registry and price-history cache are persisted.
  DATA_DIR: process.env.DATA_DIR || path.join(process.cwd(), ".data"),

  // ── Wallet / signing ─────────────────────────────────────
  // Either an inline secret key (base58 or JSON array) or a path to a keypair
  SOLANA_SECRET_KEY: process.env.SOLANA_SECRET_KEY || "",
  SOLANA_KEYPAIR_PATH: process.env.SOLANA_KEYPAIR_PATH || "",

  // ── Engine tuning ────────────────────────────────────────
  // Floor of 10s: CoinGecko's free tier rate-limits below that, and the
  // engine's own tick cannot finish faster anyway.
  MONITOR_INTERVAL: clampedNum("MONITOR_INTERVAL", 30_000, 10_000, 3_600_000),
  HISTORY_REFRESH_INTERVAL: clampedNum(
    "HISTORY_REFRESH_INTERVAL",
    60 * 60 * 1000,
    5 * 60 * 1000,
    24 * 60 * 60 * 1000
  ),
  // Days of price history behind the covariance matrix.
  // NOTE: the feed changes granularity with this window (hourly up to ~90
  // days, daily beyond), which is why the engine measures the sampling
  // interval from the data rather than assuming one.
  HISTORY_DAYS: clampedNum("HISTORY_DAYS", 30, 2, 365),

  // Reporting horizon for VaR and Expected Shortfall, in days.
  VAR_HORIZON_DAYS: clampedNum("VAR_HORIZON_DAYS", 1, 1, 30),
  // Confidence level. 0.95 = the loss exceeded on about one day in twenty.
  VAR_CONFIDENCE: clampedNum("VAR_CONFIDENCE", 0.95, 0.5, 0.9999),
  // EWMA decay for the covariance estimate. 0.94 is the RiskMetrics default;
  // lower reacts faster and is noisier.
  VAR_LAMBDA: clampedNum("VAR_LAMBDA", 0.94, 0.5, 0.999),
  SHOCK_THRESHOLD: num("SHOCK_THRESHOLD", 5),
  RISK_ALERT_THRESHOLD: num("RISK_ALERT_THRESHOLD", 25),
  ALERT_COOLDOWN: num("ALERT_COOLDOWN", 5 * 60 * 1000),
  // Points of risk history kept in memory per wallet (drives the UI chart)
  HISTORY_POINTS: clampedNum("HISTORY_POINTS", 240, 10, 5_000),
  // Ceiling on monitored wallets — each one costs an RPC call per tick
  MAX_WALLETS: clampedNum("MAX_WALLETS", 25, 1, 500),

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
