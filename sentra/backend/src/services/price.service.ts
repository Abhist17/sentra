import axios from "axios";
import { CONFIG } from "../config/env";

export const TRACKED_ASSETS = {
  SOL: "solana",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
  USDC: "usd-coin",
};

const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_HISTORY = "https://api.coingecko.com/api/v3/coins";

type SimplePriceResponse = Record<string, { usd: number }>;
type MarketChartResponse = { prices: [number, number][] };

// The free CoinGecko tier rate-limits aggressively at our polling rate.
// A demo key raises the ceiling and is passed as a header.
const authHeaders: Record<string, string> = CONFIG.COINGECKO_API_KEY
  ? { "x-cg-demo-api-key": CONFIG.COINGECKO_API_KEY }
  : {};

export async function fetchLivePrices() {
  const ids = Object.values(TRACKED_ASSETS).join(",");

  const res = await axios.get<SimplePriceResponse>(COINGECKO_SIMPLE, {
    headers: authHeaders,
    params: {
      ids,
      vs_currencies: "usd",
    },
  });

  const data = res.data;

  return {
    SOL: data["solana"]?.usd || 0,
    BONK: data["bonk"]?.usd || 0,
    JUP: data["jupiter-exchange-solana"]?.usd || 0,
    USDC: data["usd-coin"]?.usd || 1,
  };
}

export async function fetchHistory(coinId: string) {
  const res = await axios.get<MarketChartResponse>(
    `${COINGECKO_HISTORY}/${coinId}/market_chart`,
    {
      headers: authHeaders,
      params: {
        vs_currency: "usd",
        days: 30,
      },
    }
  );

  if (!res.data?.prices) return [];

  return res.data.prices.map((p) => p[1]);
}