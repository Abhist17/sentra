import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config/env";

export const TRACKED_ASSETS = {
  SOL: "solana",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
  USDC: "usd-coin",
} as const;

export type AssetSymbol = keyof typeof TRACKED_ASSETS;
export type PriceMap = Record<AssetSymbol, number>;

export const ASSET_SYMBOLS = Object.keys(TRACKED_ASSETS) as AssetSymbol[];

// Stablecoins are excluded from volatility/shock signals — a 3% "move" on
// USDC is a feed glitch, not a market event.
export const STABLE_ASSETS = new Set<AssetSymbol>(["USDC"]);

const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_HISTORY = "https://api.coingecko.com/api/v3/coins";

type SimplePriceResponse = Record<string, { usd: number }>;
type MarketChartResponse = { prices: [number, number][] };

// The free CoinGecko tier rate-limits aggressively at our polling rate.
// A demo key raises the ceiling and is passed as a header.
const authHeaders: Record<string, string> = CONFIG.COINGECKO_API_KEY
  ? { "x-cg-demo-api-key": CONFIG.COINGECKO_API_KEY }
  : {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * CoinGecko's free tier answers a burst of requests with 429s. Every call goes
 * through here so a rate limit becomes a short wait instead of a failed tick.
 * `Retry-After` is honoured when present, otherwise we back off exponentially.
 */
async function requestWithRetry<T>(
  url: string,
  params: Record<string, unknown>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await axios.get<T>(url, {
        headers: authHeaders,
        params,
        timeout: 15_000,
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = (err as AxiosError)?.response?.status;

      // 4xx other than 429 will never succeed on retry — fail fast.
      if (status && status !== 429 && status < 500) throw err;
      if (attempt === attempts - 1) break;

      const retryAfter = Number(
        (err as AxiosError)?.response?.headers?.["retry-after"]
      );
      const backoff = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 1500 * 2 ** attempt;

      await sleep(Math.min(backoff, 30_000));
    }
  }

  throw lastErr;
}

// ── Live prices ──────────────────────────────────────────────────
export interface PriceSnapshot {
  prices: PriceMap;
  fetchedAt: number;
  /** True when the upstream call failed and these are cached values. */
  stale: boolean;
}

let lastGoodPrices: PriceMap | null = null;
let lastGoodAt = 0;

function isUsablePriceMap(prices: PriceMap): boolean {
  // A zero price silently corrupts every downstream weight and VaR figure,
  // so a partial response is treated as no response at all.
  return ASSET_SYMBOLS.every((s) => Number.isFinite(prices[s]) && prices[s] > 0);
}

export async function fetchLivePrices(): Promise<PriceSnapshot> {
  const ids = Object.values(TRACKED_ASSETS).join(",");

  try {
    const data = await requestWithRetry<SimplePriceResponse>(COINGECKO_SIMPLE, {
      ids,
      vs_currencies: "usd",
    });

    const prices = ASSET_SYMBOLS.reduce((acc, symbol) => {
      acc[symbol] = data[TRACKED_ASSETS[symbol]]?.usd ?? 0;
      return acc;
    }, {} as PriceMap);

    if (!isUsablePriceMap(prices)) {
      throw new Error(
        `Incomplete price response: ${JSON.stringify(prices)}`
      );
    }

    lastGoodPrices = prices;
    lastGoodAt = Date.now();
    return { prices, fetchedAt: lastGoodAt, stale: false };
  } catch (err) {
    if (lastGoodPrices) {
      console.warn(
        `⚠️  Price fetch failed (${
          err instanceof Error ? err.message : err
        }) — reusing prices from ${Math.round((Date.now() - lastGoodAt) / 1000)}s ago`
      );
      return { prices: lastGoodPrices, fetchedAt: lastGoodAt, stale: true };
    }
    throw err;
  }
}

export function getCachedPrices(): PriceSnapshot | null {
  if (!lastGoodPrices) return null;
  return {
    prices: lastGoodPrices,
    fetchedAt: lastGoodAt,
    stale: Date.now() - lastGoodAt > CONFIG.MONITOR_INTERVAL * 3,
  };
}

// ── Historical prices ────────────────────────────────────────────
// History is the expensive call (one request per asset) and it is what the
// whole VaR model rests on. It is cached in memory and mirrored to disk so a
// restart does not have to re-earn a rate limit before it can score anything.

interface HistoryCacheEntry {
  prices: number[];
  fetchedAt: number;
}

const historyCache = new Map<string, HistoryCacheEntry>();
const HISTORY_CACHE_FILE = path.join(CONFIG.DATA_DIR, "history-cache.json");

function loadHistoryCacheFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, "utf-8"));
    for (const [coinId, entry] of Object.entries(raw)) {
      const e = entry as HistoryCacheEntry;
      if (Array.isArray(e?.prices) && e.prices.length > 2) {
        historyCache.set(coinId, e);
      }
    }
    if (historyCache.size) {
      console.log(`💾 Loaded cached history for ${historyCache.size} asset(s)`);
    }
  } catch (err) {
    console.warn(
      "⚠️  Could not read history cache:",
      err instanceof Error ? err.message : err
    );
  }
}

function saveHistoryCacheToDisk() {
  try {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    fs.writeFileSync(
      HISTORY_CACHE_FILE,
      JSON.stringify(Object.fromEntries(historyCache), null, 2)
    );
  } catch (err) {
    console.warn(
      "⚠️  Could not write history cache:",
      err instanceof Error ? err.message : err
    );
  }
}

loadHistoryCacheFromDisk();

export async function fetchHistory(coinId: string): Promise<number[]> {
  const data = await requestWithRetry<MarketChartResponse>(
    `${COINGECKO_HISTORY}/${coinId}/market_chart`,
    { vs_currency: "usd", days: CONFIG.HISTORY_DAYS }
  );

  const prices = (data?.prices ?? [])
    .map((p) => p[1])
    .filter((p) => Number.isFinite(p) && p > 0);

  if (prices.length > 2) {
    historyCache.set(coinId, { prices, fetchedAt: Date.now() });
    saveHistoryCacheToDisk();
  }

  return prices;
}

/**
 * Fetches history for every tracked asset, keyed by SYMBOL rather than by
 * position. Position-keyed matrices were the source of a silent correctness
 * bug: when one asset's request failed the rows shifted and every remaining
 * asset's returns were scored against a different asset's weight.
 *
 * Assets whose request fails fall back to their cached series when one exists,
 * so a single rate limit degrades precision instead of corrupting the model.
 */
export async function fetchAllHistories(
  spacingMs = 2500
): Promise<{ returnsSource: Record<string, number[]>; failed: string[] }> {
  const returnsSource: Record<string, number[]> = {};
  const failed: string[] = [];

  for (let i = 0; i < ASSET_SYMBOLS.length; i++) {
    const symbol = ASSET_SYMBOLS[i];
    const coinId = TRACKED_ASSETS[symbol];

    // Space requests out rather than sleeping i*spacing (which made the last
    // asset wait for the sum of all previous delays).
    if (i > 0) await sleep(spacingMs);

    try {
      const prices = await fetchHistory(coinId);
      if (prices.length > 2) {
        returnsSource[symbol] = prices;
        continue;
      }
      throw new Error("history too short");
    } catch (err) {
      const cached = historyCache.get(coinId);
      if (cached) {
        returnsSource[symbol] = cached.prices;
        console.warn(
          `⚠️  History failed for ${symbol} — using cache from ` +
            `${new Date(cached.fetchedAt).toISOString()}`
        );
      } else {
        failed.push(symbol);
        console.warn(
          `⚠️  History failed for ${symbol} and no cache available:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return { returnsSource, failed };
}
