import axios from "axios";

export const TRACKED_ASSETS = {
  SOL: "solana",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
  USDC: "usd-coin",
};

const COINGECKO_SIMPLE =
  "https://api.coingecko.com/api/v3/simple/price";

const COINGECKO_HISTORY =
  "https://api.coingecko.com/api/v3/coins";

export async function fetchLivePrices() {
  const ids = Object.values(TRACKED_ASSETS).join(",");

  const res = await axios.get(COINGECKO_SIMPLE, {
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
  const res = await axios.get(
    `${COINGECKO_HISTORY}/${coinId}/market_chart`,
    {
      params: {
        vs_currency: "usd",
        days: 30,
      },
    }
  );

  if (!res.data?.prices) return [];

  return res.data.prices.map((p: any) => p[1]);
}