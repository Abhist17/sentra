export type AssetSymbol = "SOL" | "BONK" | "JUP" | "USDC";

export type StressLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export interface Holding {
  symbol: string;
  amount: number;
  price: number;
  value: number;
  weight: number;
}

export interface RiskContributionView {
  symbol: string;
  /** Share of portfolio VALUE, 0-1. */
  weight: number;
  /** Share of portfolio RISK, 0-1. Sums to 1. */
  riskShare: number;
  componentVarUsd: number;
  volHorizon: number;
}

export interface RiskModelMeta {
  headline: "parametric" | "historical";
  horizonDays: number;
  confidence: number;
  /** Observations per day in the source series (measured, not assumed). */
  periodsPerDay: number;
  observations: number;
  /** Non-overlapping equivalents — what the historical tail can support. */
  independentObservations: number;
  lambdaApplied: number;
  parametric: { varUsd: number; esUsd: number };
  historical: { varUsd: number; esUsd: number };
  contributions: RiskContributionView[];
  /** 1.0 = the book moves as one asset; higher means real diversification. */
  diversificationRatio: number;
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
  /** Expected Shortfall: average loss GIVEN a breach of VaR. */
  esUsd: number;
  model: RiskModelMeta;
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
  /** True when the payload is synthetic, not from a live engine. */
  demo?: boolean;
  totals: {
    risk: number;
    portfolio: number;
    varUsd: number;
    esUsd: number;
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
    varHorizonDays: number;
    varConfidence: number;
    varLambda: number;
    historyDays: number;
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
