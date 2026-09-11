import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config/env";

/**
 * The asset universe: what the engine can price, and therefore what a wallet
 * can be scored on. Anything else a wallet holds is invisible to the model,
 * and the dashboard says so through the coverage figure.
 *
 * One row per asset so the CoinGecko id, the mainnet mint and the stable flag
 * cannot drift apart. `mint` is null for native SOL. Ids and mints were
 * checked against CoinGecko's own `platforms.solana` field.
 *
 * Every asset costs one history request an hour, so this is a curated list of
 * the tokens most Solana books actually hold, not a registry. Adding one is a
 * line here — nothing else in the engine enumerates assets by name.
 */
export const ASSETS = [
  { symbol: "SOL", coingeckoId: "solana", mint: null, stable: false },
  {
    symbol: "JITOSOL",
    coingeckoId: "jito-staked-sol",
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    stable: false,
  },
  {
    symbol: "USDC",
    coingeckoId: "usd-coin",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    stable: true,
  },
  {
    symbol: "USDT",
    coingeckoId: "tether",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    stable: true,
  },
  {
    symbol: "JUP",
    coingeckoId: "jupiter-exchange-solana",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    stable: false,
  },
  {
    symbol: "BONK",
    coingeckoId: "bonk",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    stable: false,
  },
  {
    symbol: "WIF",
    coingeckoId: "dogwifcoin",
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    stable: false,
  },
  {
    symbol: "JTO",
    coingeckoId: "jito-governance-token",
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    stable: false,
  },
  {
    symbol: "PYTH",
    coingeckoId: "pyth-network",
    mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    stable: false,
  },
  {
    symbol: "RAY",
    coingeckoId: "raydium",
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    stable: false,
  },
] as const;

export type AssetSymbol = (typeof ASSETS)[number]["symbol"];
export type PriceMap = Record<AssetSymbol, number>;

export const ASSET_SYMBOLS = ASSETS.map((a) => a.symbol) as AssetSymbol[];

/** Symbol → CoinGecko id. */
export const TRACKED_ASSETS = Object.fromEntries(
  ASSETS.map((a) => [a.symbol, a.coingeckoId])
) as Record<AssetSymbol, string>;

// Stablecoins are excluded from volatility/shock signals — a 3% "move" on
// USDC is a feed glitch, not a market event.
export const STABLE_ASSETS = new Set<AssetSymbol>(
  ASSETS.filter((a) => a.stable).map((a) => a.symbol)
);

export function isAssetSymbol(value: string): value is AssetSymbol {
  return (ASSET_SYMBOLS as string[]).includes(value);
}

const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_HISTORY = "https://api.coingecko.com/api/v3/coins";

type SimplePriceResponse = Record<string, { usd: number }>;
type MarketChartResponse = { prices: [number, number][] };

/** A price observation with its timestamp, so the sampling interval can be
 *  measured rather than assumed. */
export interface PricePoint {
  t: number;
  price: number;
}

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
  points: PricePoint[];
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
      // Entries written before timestamps were recorded are discarded rather
      // than guessed at — the sampling interval is not recoverable from them.
      if (Array.isArray(e?.points) && e.points.length > 2) {
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

export async function fetchHistory(coinId: string): Promise<PricePoint[]> {
  const data = await requestWithRetry<MarketChartResponse>(
    `${COINGECKO_HISTORY}/${coinId}/market_chart`,
    { vs_currency: "usd", days: CONFIG.HISTORY_DAYS }
  );

  const points = (data?.prices ?? [])
    .filter(
      ([t, price]) =>
        Number.isFinite(t) && Number.isFinite(price) && price > 0
    )
    .map(([t, price]) => ({ t, price }));

  if (points.length > 2) {
    historyCache.set(coinId, { points, fetchedAt: Date.now() });
    saveHistoryCacheToDisk();
  }

  return points;
}

/**
 * Median spacing between observations, in milliseconds.
 *
 * CoinGecko changes granularity with the requested window — hourly for a
 * 30-day range, daily beyond 90 — so the horizon a volatility figure refers to
 * silently depends on config. Measuring it here is what lets the risk model
 * scale returns to an actual one-day horizon instead of quietly reporting a
 * one-hour number as if it were daily.
 */
export function inferIntervalMs(points: PricePoint[]): number | null {
  if (points.length < 3) return null;

  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    if (gap > 0) gaps.push(gap);
  }

  if (gaps.length === 0) return null;

  // Median, not mean: feeds occasionally drop a sample, and one long gap
  // would drag an average badly.
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0
    ? (gaps[mid - 1] + gaps[mid]) / 2
    : gaps[mid];
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
  spacingMs = 2000,
  maxAgeMs = CONFIG.HISTORY_REFRESH_INTERVAL
): Promise<{ returnsSource: Record<string, PricePoint[]>; failed: string[] }> {
  const returnsSource: Record<string, PricePoint[]> = {};
  const failed: string[] = [];
  let requests = 0;

  for (const symbol of ASSET_SYMBOLS) {
    const coinId = TRACKED_ASSETS[symbol];

    // A cached series younger than the refresh interval is what a refresh
    // would return anyway. Using it directly makes a restart score on its
    // first tick instead of re-earning a rate limit for ten identical
    // answers.
    const cached = historyCache.get(coinId);
    if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
      returnsSource[symbol] = cached.points;
      continue;
    }

    // Space requests out rather than sleeping i*spacing (which made the last
    // asset wait for the sum of all previous delays). Only real requests
    // count — a cache hit costs the feed nothing.
    if (requests > 0) await sleep(spacingMs);
    requests++;

    try {
      const points = await fetchHistory(coinId);
      if (points.length > 2) {
        returnsSource[symbol] = points;
        continue;
      }
      throw new Error("history too short");
    } catch (err) {
      const cached = historyCache.get(coinId);
      if (cached) {
        returnsSource[symbol] = cached.points;
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
