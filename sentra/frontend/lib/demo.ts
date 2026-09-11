import type {
  Overview,
  WalletRow,
  RiskPoint,
  Holding,
  AnchorRecord,
} from "./types";

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

const PRICES = {
  SOL: 94.2,
  JITOSOL: 122.6,
  USDC: 0.9999,
  USDT: 0.9998,
  JUP: 0.2043,
  BONK: 0.00000318,
  WIF: 0.187,
  JTO: 0.412,
  PYTH: 0.0498,
  RAY: 1.63,
};

/** Realistic one-day volatilities, used to split risk across the book. */
const VOL = {
  SOL: 0.026,
  JITOSOL: 0.026,
  USDC: 0.0003,
  USDT: 0.0003,
  JUP: 0.043,
  BONK: 0.071,
  WIF: 0.078,
  JTO: 0.049,
  PYTH: 0.046,
  RAY: 0.044,
};

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

/**
 * What the on-chain record would hold: a snapshot on the hour plus one at
 * each band change, taken from the same synthetic series the chart draws so
 * the markers sit on the line. No signatures or account addresses — the rows
 * render without explorer links, since there is nothing real to open.
 */
function demoAnchors(
  wallet: string,
  points: RiskPoint[],
  portfolio: number
): AnchorRecord[] {
  const out: AnchorRecord[] = [];
  const BANDS = [0, 25, 45, 70];
  const bandOf = (r: number) => BANDS.filter((b) => r >= b).length - 1;
  // Same rule as the engine: a crossing counts once it has cleared the
  // boundary by two points, so a score twitching at 44.9 / 45.1 is not
  // anchored on every tick.
  const crossed = (from: number, to: number) => {
    const a = bandOf(from);
    const b = bandOf(to);
    if (a === b) return false;
    return b > a ? to >= BANDS[b] + 2 : to <= BANDS[a] - 2;
  };
  let last: RiskPoint | null = null;

  for (const p of points) {
    const due =
      last === null ||
      p.t - last.t >= 60 * 60 * 1000 ||
      crossed(last.risk, p.risk);
    if (!due) continue;

    // The demo series spans 48 minutes at 30s; the hourly rule alone would
    // yield one row, so band changes are what populate it.
    last = p;
    out.push({
      wallet,
      reporter: "",
      riskScore: Math.round(p.risk),
      timestamp: Math.floor(p.t / 1000),
      valueUsd: portfolio,
      varUsd: (Math.round(p.risk) * 0.28 * portfolio) / 100,
      pda: "",
      signature: "",
      breached: false,
    });
  }

  return out;
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
  const anchors = demoAnchors(opts.address, points, total);

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
    history: points,
    anchors,
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

/**
 * A plausible 30-day picture of the Solana majors: the liquid-staking token
 * is SOL in another wrapper, the DeFi tokens track SOL closely, and the meme
 * pair moves together more than either moves with anything else.
 */
const DEMO_CORRELATION = (() => {
  const symbols = ["SOL", "JITOSOL", "JUP", "BONK", "WIF", "JTO", "PYTH", "RAY"];
  const upper: Record<string, number> = {
    "SOL|JITOSOL": 0.99,
    "SOL|JUP": 0.78,
    "SOL|BONK": 0.71,
    "SOL|WIF": 0.66,
    "SOL|JTO": 0.74,
    "SOL|PYTH": 0.69,
    "SOL|RAY": 0.76,
    "JITOSOL|JUP": 0.77,
    "JITOSOL|BONK": 0.7,
    "JITOSOL|WIF": 0.65,
    "JITOSOL|JTO": 0.73,
    "JITOSOL|PYTH": 0.68,
    "JITOSOL|RAY": 0.75,
    "JUP|BONK": 0.62,
    "JUP|WIF": 0.58,
    "JUP|JTO": 0.71,
    "JUP|PYTH": 0.66,
    "JUP|RAY": 0.7,
    "BONK|WIF": 0.84,
    "BONK|JTO": 0.57,
    "BONK|PYTH": 0.55,
    "BONK|RAY": 0.6,
    "WIF|JTO": 0.53,
    "WIF|PYTH": 0.51,
    "WIF|RAY": 0.56,
    "JTO|PYTH": 0.72,
    "JTO|RAY": 0.68,
    "PYTH|RAY": 0.64,
  };
  const matrix = symbols.map((a, i) =>
    symbols.map((b, j) =>
      i === j ? 1 : upper[`${a}|${b}`] ?? upper[`${b}|${a}`] ?? 0
    )
  );
  return {
    symbols,
    matrix,
    asOf: Date.now() - 22 * 60_000,
    windowDays: 30,
  };
})();

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
      { symbol: "SOL", amount: 980 },
      { symbol: "JUP", amount: 420_000 },
      { symbol: "PYTH", amount: 900_000 },
      { symbol: "JTO", amount: 110_000 },
      { symbol: "BONK", amount: 5_200_000_000 },
      { symbol: "USDC", amount: 118_000 },
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
      changes: Object.fromEntries(
        Object.keys(PRICES).map((symbol) => [
          symbol,
          drift() * (symbol === "USDC" || symbol === "USDT" ? 0.02 : 1),
        ])
      ),
      pricesStale: false,
      pricesFetchedAt: Date.now(),
      stress: {
        score: 30,
        level: "MODERATE",
        signals: ["⚡ Volatility spike: SOL, BONK"],
      },
      volatility: {
        SOL: 0.034,
        JITOSOL: 0.033,
        USDC: 0.0003,
        USDT: 0.0003,
        JUP: 0.019,
        BONK: 0.041,
        WIF: 0.038,
        JTO: 0.021,
        PYTH: 0.018,
        RAY: 0.02,
      },
      correlation: DEMO_CORRELATION,
      lastTickAt: Date.now(),
      lastTickError: null,
      historyAssets: 10,
    },
    wallets,
    config: {
      monitorInterval: 30_000,
      riskAlertThreshold: 25,
      varHorizonDays: 1,
      varConfidence: 0.95,
      varLambda: 0.94,
      historyDays: 30,
      // Shown as anchoring so the panel demonstrates the record. Rows are
      // synthetic and carry no signatures, so nothing links anywhere; the
      // program id is the real one, deployed on devnet.
      onchain: {
        enabled: true,
        programId: "6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj",
        cluster: "devnet",
        reporter: null,
        anchorInterval: 3_600_000,
        lastAnchoredAt: 0,
        lastError: null,
      },
      telegram: false,
      trackedAssets: [
        "SOL",
        "JITOSOL",
        "USDC",
        "USDT",
        "JUP",
        "BONK",
        "WIF",
        "JTO",
        "PYTH",
        "RAY",
      ],
      requiresApiKey: false,
    },
    timestamp: Date.now(),
  };
}
