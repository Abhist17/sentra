import type { Overview, WalletRow, RiskPoint, Holding } from "./types";

/**
 * Synthetic dataset for when no engine is reachable.
 *
 * Without this the hosted dashboard's first impression is an error card, which
 * tells a visitor nothing about what the product does. Demo data is always
 * labelled as such in the UI — the point is to show the interface working, not
 * to pass synthetic numbers off as real.
 *
 * The two wallets are chosen to make the product's argument in one screen:
 * they hold similar value but carry very different risk, which a balance
 * readout cannot distinguish.
 */

const PRICES = { SOL: 94.2, BONK: 0.00000318, JUP: 0.2043, USDC: 0.9999 };

/** Realistic one-day volatilities, used to split risk across the book. */
const VOL = { SOL: 0.026, BONK: 0.071, JUP: 0.043, USDC: 0.0003 };

/** Deterministic PRNG so a reload does not reshuffle the whole story. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Smooth wander around a base value — recognisably a price series. */
function walk(base: number, vol: number, steps: number, seed: number): number[] {
  const rand = seeded(seed);
  const out: number[] = [];
  let level = 0;
  for (let i = 0; i < steps; i++) {
    level = level * 0.86 + (rand() - 0.5) * vol;
    out.push(base * (1 + level));
  }
  return out;
}

function holdings(
  spec: { symbol: keyof typeof PRICES; amount: number }[]
): { holdings: Holding[]; total: number } {
  const priced = spec.map((s) => ({
    symbol: s.symbol,
    amount: s.amount,
    price: PRICES[s.symbol],
    value: s.amount * PRICES[s.symbol],
    weight: 0,
  }));
  const total = priced.reduce((sum, h) => sum + h.value, 0);
  for (const h of priced) h.weight = h.value / total;
  return { holdings: priced, total };
}

function history(
  base: number,
  vol: number,
  portfolio: number,
  seed: number,
  points = 96
): RiskPoint[] {
  const series = walk(base, vol, points, seed);
  const now = Date.now();
  return series.map((risk, i) => ({
    t: now - (points - 1 - i) * 30_000,
    risk: Math.max(1, Math.min(100, risk)),
    portfolio: portfolio * (1 + (risk / base - 1) * 0.4),
  }));
}

function wallet(opts: {
  address: string;
  label: string;
  spec: { symbol: keyof typeof PRICES; amount: number }[];
  riskBase: number;
  riskVol: number;
  seed: number;
  /** Fraction of risk carried by the heaviest asset, 0-1. */
  topRiskShare: number;
}): WalletRow {
  const { holdings: held, total } = holdings(opts.spec);
  const points = history(opts.riskBase, opts.riskVol, total, opts.seed);
  const risk = points[points.length - 1].risk;

  const sorted = [...held].sort((a, b) => b.value - a.value);
  const varPct = risk * 0.28;
  const varUsd = (varPct / 100) * total;
  const esUsd = varUsd * 1.26;

  // Risk share is weight scaled by each asset's volatility — the divergence
  // between the two is exactly what the attribution panel exists to show. A
  // stablecoin holds real value and almost no risk; a small volatile position
  // is the reverse.
  const scaled = sorted.map((h) => h.weight * VOL[h.symbol as keyof typeof VOL]);
  const scaledTotal = scaled.reduce((a, b) => a + b, 0);

  const contributions = sorted
    .map((h, i) => ({
      symbol: h.symbol,
      weight: h.weight,
      riskShare: scaled[i] / scaledTotal,
      componentVarUsd: (scaled[i] / scaledTotal) * varUsd,
      volHorizon: VOL[h.symbol as keyof typeof VOL],
    }))
    .sort((a, b) => b.riskShare - a.riskShare);

  const concentration =
    sorted[0].weight > 0.5 ? 20 : sorted[0].weight > 0.3 ? 10 : 0;

  return {
    address: opts.address,
    label: opts.label,
    addedAt: Date.now() - 86_400_000,
    isDemo: true,
    isOwned: false,
    history: points,
    metrics: {
      address: opts.address,
      label: opts.label,
      risk,
      portfolio: total,
      breakdown: {
        var: varPct,
        concentration,
        stress: Math.max(0, risk - varPct - concentration),
        trend: 0,
      },
      varUsd,
      esUsd,
      maxWeight: sorted[0].weight,
      coverage: 1,
      holdings: held,
      updatedAt: Date.now(),
      model: {
        headline: "parametric",
        horizonDays: 1,
        confidence: 0.95,
        periodsPerDay: 24,
        observations: 697,
        independentObservations: 29,
        lambdaApplied: 0.9975,
        parametric: { varUsd, esUsd },
        historical: { varUsd: varUsd * 0.42, esUsd: esUsd * 0.5 },
        contributions,
        diversificationRatio: opts.topRiskShare > 0.9 ? 1.02 : 1.61,
      },
    },
  };
}

export function buildDemoOverview(): Overview {
  const concentrated = wallet({
    address: "DemoCon1entratedWa11etAddressForShowcase111",
    label: "Concentrated book",
    spec: [
      { symbol: "SOL", amount: 3_050 },
      { symbol: "BONK", amount: 13_500_000_000 },
      { symbol: "USDC", amount: 46_000 },
    ],
    riskBase: 47,
    riskVol: 0.16,
    seed: 20260823,
    topRiskShare: 0.94,
  });

  const diversified = wallet({
    address: "DemoDiversifiedWa11etAddressForShowcase222",
    label: "Diversified book",
    spec: [
      { symbol: "SOL", amount: 1_180 },
      { symbol: "JUP", amount: 620_000 },
      { symbol: "BONK", amount: 6_800_000_000 },
      { symbol: "USDC", amount: 128_000 },
    ],
    riskBase: 19,
    riskVol: 0.1,
    seed: 771,
    topRiskShare: 0.61,
  });

  const wallets = [concentrated, diversified];
  const portfolio = wallets.reduce((s, w) => s + w.metrics!.portfolio, 0);
  const varUsd = wallets.reduce((s, w) => s + w.metrics!.varUsd, 0);
  const esUsd = wallets.reduce((s, w) => s + w.metrics!.esUsd, 0);
  const risk = wallets.reduce(
    (s, w) => s + w.metrics!.risk * (w.metrics!.portfolio / portfolio),
    0
  );

  const rand = seeded(Math.floor(Date.now() / 30_000));
  const drift = () => (rand() - 0.5) * 1.4;

  return {
    demo: true,
    totals: { risk, portfolio, varUsd, esUsd, wallets: 2, updatedAt: Date.now() },
    market: {
      prices: PRICES,
      changes: {
        SOL: drift(),
        BONK: drift(),
        JUP: drift(),
        USDC: drift() * 0.02,
      },
      pricesStale: false,
      pricesFetchedAt: Date.now(),
      stress: {
        score: 30,
        level: "MODERATE",
        signals: ["⚡ Volatility spike: SOL, BONK"],
      },
      volatility: { SOL: 0.034, BONK: 0.041, JUP: 0.019, USDC: 0.0003 },
      lastTickAt: Date.now(),
      lastTickError: null,
      historyAssets: 4,
    },
    wallets,
    config: {
      monitorInterval: 30_000,
      riskAlertThreshold: 25,
      varHorizonDays: 1,
      varConfidence: 0.95,
      varLambda: 0.94,
      historyDays: 30,
      onchainWrites: false,
      telegram: false,
      trackedAssets: ["SOL", "BONK", "JUP", "USDC"],
      requiresApiKey: false,
    },
    timestamp: Date.now(),
  };
}
