import fs from "fs";
import path from "path";
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
  /** Per-asset attribution, largest risk contributor first. */
  contributions: RiskContributionView[];
  /** 1.0 = the book moves as one asset; higher means real diversification. */
  diversificationRatio: number;
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

// ── Persistence ──────────────────────────────────────────────────
// The wallet registry and the price-history cache both survive a restart;
// the risk series did not. Hosts like Render restart containers routinely, so
// in practice a user's chart reset to "not enough history yet" on someone
// else's schedule — and unlike prices, this series cannot be re-fetched from
// anywhere. It only exists if we kept it.

const HISTORY_FILE = path.join(CONFIG.DATA_DIR, "risk-history.json");

/**
 * Ticks arrive every 30s per wallet; writing the whole series each time is
 * pointless churn. Batch instead, and flush on shutdown so at most one
 * interval of history is ever at risk.
 */
const PERSIST_INTERVAL = 30_000;

// Tests must not inherit — or scribble into — a developer's .data directory,
// for the same reason config/env.ts refuses to load their .env.
const persistenceEnabled = process.env.NODE_ENV !== "test";

let persistTimer: NodeJS.Timeout | null = null;
let dirty = false;

/** True for a point that can be drawn without corrupting the chart's scale. */
function isRiskPoint(value: unknown): value is RiskPoint {
  const point = value as RiskPoint;
  return (
    !!point &&
    typeof point === "object" &&
    Number.isFinite(point.t) &&
    point.t > 0 &&
    Number.isFinite(point.risk) &&
    point.risk >= 0 &&
    point.risk <= 100 &&
    Number.isFinite(point.portfolio) &&
    point.portfolio >= 0
  );
}

/**
 * Validates a parsed history file into usable series.
 *
 * Exported because this is the part that can go wrong: the file is edited by
 * nothing but this process, but a half-written file from a killed container,
 * a hand-edit, or a downgrade can all produce shapes that would otherwise
 * reach the chart and blow up its axis.
 */
export function parseRiskHistory(raw: unknown): Map<string, RiskPoint[]> {
  const out = new Map<string, RiskPoint[]>();

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  for (const [address, points] of Object.entries(raw)) {
    if (typeof address !== "string" || !address || !Array.isArray(points)) {
      continue;
    }

    const clean = points
      .filter(isRiskPoint)
      // A file written by a build with a larger HISTORY_POINTS must not
      // reinstate a longer buffer than this process is willing to hold.
      .sort((a, b) => a.t - b.t)
      .slice(-CONFIG.HISTORY_POINTS);

    if (clean.length > 0) out.set(address, clean);
  }

  return out;
}

export function serialiseRiskHistory(): Record<string, RiskPoint[]> {
  return Object.fromEntries(riskHistory);
}

/** Writes the series to disk now. Called on shutdown and on wallet removal. */
export function flushRiskHistory(): void {
  if (!persistenceEnabled) return;

  dirty = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  try {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    // Write-then-rename: a container killed mid-write would otherwise leave a
    // truncated file, and the next boot would drop the history it was meant
    // to protect.
    const temporary = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(serialiseRiskHistory()));
    fs.renameSync(temporary, HISTORY_FILE);
  } catch (err) {
    console.warn(
      "⚠️  Could not persist risk history:",
      err instanceof Error ? err.message : err
    );
  }
}

function schedulePersist() {
  if (!persistenceEnabled) return;

  dirty = true;
  if (persistTimer) return;

  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (dirty) flushRiskHistory();
  }, PERSIST_INTERVAL);

  // Never hold the process open for a pending write.
  persistTimer.unref?.();
}

function restoreRiskHistory() {
  if (!persistenceEnabled) return;

  try {
    if (!fs.existsSync(HISTORY_FILE)) return;

    const restored = parseRiskHistory(
      JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"))
    );

    for (const [address, points] of restored) riskHistory.set(address, points);

    if (restored.size > 0) {
      const points = Array.from(restored.values()).reduce(
        (sum, series) => sum + series.length,
        0
      );
      console.log(
        `💾 Restored ${points} risk point(s) across ${restored.size} wallet(s)`
      );
    }
  } catch (err) {
    console.warn(
      "⚠️  Could not restore risk history:",
      err instanceof Error ? err.message : err
    );
  }
}

restoreRiskHistory();

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
  schedulePersist();
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
  // Flush rather than schedule: removal is rare, user-initiated, and a
  // process killed before the batched write would resurrect the series the
  // user just asked to be rid of.
  flushRiskHistory();
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
