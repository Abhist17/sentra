export type AssetSymbol = "SOL" | "BONK" | "JUP" | "USDC";

export type StressLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export interface Holding {
  symbol: string;
  amount: number;
  price: number;
  value: number;
  weight: number;
}

export interface WalletMetrics {
  address: string;
  label: string;
  risk: number;
  portfolio: number;
  breakdown: {
    var: number;
    concentration: number;
    stress: number;
    trend: number;
  };
  varUsd: number;
  maxWeight: number;
  coverage: number;
  holdings: Holding[];
  updatedAt: number;
}

export interface RiskPoint {
  t: number;
  risk: number;
  portfolio: number;
}

export interface WalletRow {
  address: string;
  label: string;
  addedAt: number;
  isDemo: boolean;
  isOwned: boolean;
  metrics: WalletMetrics | null;
  history: RiskPoint[];
}

export interface Overview {
  totals: {
    risk: number;
    portfolio: number;
    varUsd: number;
    wallets: number;
    updatedAt: number;
  };
  market: {
    prices: Record<AssetSymbol, number> | null;
    changes: Partial<Record<AssetSymbol, number>>;
    pricesStale: boolean;
    pricesFetchedAt: number;
    stress: { score: number; level: StressLevel; signals: string[] };
    volatility: Record<string, number>;
    lastTickAt: number;
    lastTickError: string | null;
    historyAssets: number;
  };
  wallets: WalletRow[];
  config: {
    monitorInterval: number;
    riskAlertThreshold: number;
    onchainWrites: boolean;
    telegram: boolean;
    trackedAssets: string[];
    requiresApiKey: boolean;
  };
  timestamp: number;
}

export interface Snapshot {
  publicKey: string;
  riskScore: number;
  timestamp: number;
}
