import { CONFIG } from "../config/env";
import type { AssetSymbol, PriceMap } from "../services/price.service";

export interface AssetHolding {
  symbol: string;
  amount: number;
  price: number;
  value: number;
  /** Share of portfolio value, 0–1 */
  weight: number;
}

export interface RiskModelMeta {
  /** Which model produced the headline figure. */
  headline: "parametric" | "historical";
  horizonDays: number;
  confidence: number;
  /** Observations per day in the source series (measured, not assumed). */
  periodsPerDay: number;
  /** Overlapping horizon-return samples behind the historical figures. */
  observations: number;
  /** Non-overlapping equivalents — what the historical tail can actually
   *  support. Overlapping windows inflate the count without adding info. */
  independentObservations: number;
  /** EWMA decay after rescaling to the sampling frequency. */
  lambdaApplied: number;
  parametric: { varUsd: number; esUsd: number };
  historical: { varUsd: number; esUsd: number };
}

export interface WalletMetrics {
  address: string;
  label: string;
  /** Final blended score, 0–100 */
  risk: number;
  /** Total portfolio value in USD */
  portfolio: number;
  breakdown: {
    /** Value at Risk component (% of portfolio at the confidence level) */
    var: number;
    /** Penalty for over-concentration in a single asset */
    concentration: number;
    /** Penalty carried in from market-wide stress */
    stress: number;
    /** Penalty for a negative short-term trend */
    trend: number;
  };
  /** Headline VaR in USD at the configured horizon and confidence. */
  varUsd: number;
  /** Expected Shortfall: the average loss GIVEN a breach of VaR. */
  esUsd: number;
  /** How the figures above were produced, so the UI can show its working. */
  model: RiskModelMeta;
  /** Largest single-asset weight, 0–1 */
  maxWeight: number;
  /** Share of portfolio value with return data behind it, 0–1 */
  coverage: number;
  holdings: AssetHolding[];
  updatedAt: number;
}

export interface RiskPoint {
  t: number;
  risk: number;
  portfolio: number;
}

export interface MarketState {
  prices: PriceMap | null;
  /** Percent change per asset since the previous tick */
  changes: Partial<Record<AssetSymbol, number>>;
  pricesStale: boolean;
  pricesFetchedAt: number;
  stress: {
    score: number;
    level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
    signals: string[];
  };
  /** Annualised-ish volatility per asset from the live tick window */
  volatility: Record<string, number>;
  lastTickAt: number;
  lastTickError: string | null;
  historyAssets: number;
}

export const walletMetrics: Map<string, WalletMetrics> = new Map();

const riskHistory: Map<string, RiskPoint[]> = new Map();

const market: MarketState = {
  prices: null,
  changes: {},
  pricesStale: false,
  pricesFetchedAt: 0,
  stress: { score: 0, level: "LOW", signals: [] },
  volatility: {},
  lastTickAt: 0,
  lastTickError: null,
  historyAssets: 0,
};

export function updateMetrics(metrics: WalletMetrics) {
  walletMetrics.set(metrics.address, metrics);

  const series = riskHistory.get(metrics.address) ?? [];
  series.push({
    t: metrics.updatedAt,
    risk: Number(metrics.risk.toFixed(2)),
    portfolio: Number(metrics.portfolio.toFixed(2)),
  });

  // Ring buffer — the UI only ever draws the tail, and an unbounded array is
  // a slow memory leak in a process meant to run for weeks.
  if (series.length > CONFIG.HISTORY_POINTS) {
    series.splice(0, series.length - CONFIG.HISTORY_POINTS);
  }

  riskHistory.set(metrics.address, series);
}

export function getWalletMetrics(address: string): WalletMetrics | null {
  return walletMetrics.get(address) ?? null;
}

export function getRiskHistory(address: string): RiskPoint[] {
  return riskHistory.get(address) ?? [];
}

export function forgetWallet(address: string) {
  walletMetrics.delete(address);
  riskHistory.delete(address);
}

/**
 * Portfolio-weighted aggregate across every monitored wallet.
 *
 * The previous implementation kept a single `latestRisk` variable that each
 * wallet overwrote in turn, so `/risk` reported whichever wallet happened to
 * be processed last rather than anything about the whole book.
 */
export function getLatestMetrics() {
  const all = Array.from(walletMetrics.values());

  if (all.length === 0) {
    return {
      risk: 0,
      portfolio: 0,
      wallets: 0,
      updatedAt: 0,
      varUsd: 0,
      esUsd: 0,
    };
  }

  const portfolio = all.reduce((sum, m) => sum + m.portfolio, 0);
  // Summing per-wallet VaR assumes the wallets move together. That is the
  // conservative reading, and correct when they hold the same few assets.
  const varUsd = all.reduce((sum, m) => sum + m.varUsd, 0);
  const esUsd = all.reduce((sum, m) => sum + m.esUsd, 0);

  // Weight each wallet's score by its size; an empty book falls back to a
  // plain mean so the number is still meaningful.
  const risk =
    portfolio > 0
      ? all.reduce((sum, m) => sum + m.risk * (m.portfolio / portfolio), 0)
      : all.reduce((sum, m) => sum + m.risk, 0) / all.length;

  return {
    risk,
    portfolio,
    varUsd,
    esUsd,
    wallets: all.length,
    updatedAt: Math.max(...all.map((m) => m.updatedAt)),
  };
}

export function updateMarket(patch: Partial<MarketState>) {
  Object.assign(market, patch);
}

export function getMarket(): MarketState {
  return market;
}
