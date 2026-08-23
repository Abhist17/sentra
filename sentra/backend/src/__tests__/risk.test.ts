/**
 * Unit tests for the quant core. Run with `npm test`.
 *
 * These pin the failure modes that were silently corrupting scores: a
 * one-sample covariance dividing by zero, weights paired with the wrong
 * asset's returns, and — the big one — per-period volatility reported as if
 * it were daily.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  mean,
  computeReturns,
  covariance,
  ewmaCovariance,
  stdDev,
  portfolioVariance,
  normalPdf,
  normalQuantile,
  quantile,
  aggregateReturns,
  scaleLambdaToFrequency,
  calculatePortfolioRisk,
  MIN_HISTORICAL_OBSERVATIONS,
} from "../services/risk.service";

// A deterministic pseudo-random normal series, so tests do not flake.
function syntheticReturns(n: number, sigma: number, seed = 1): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Box-Muller
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    out.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma);
  }
  return out;
}

// ── Basic statistics ─────────────────────────────────────────────

test("mean of an empty series is 0, not NaN", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([2, 4, 6]), 4);
});

test("computeReturns skips samples with a zero or non-finite base", () => {
  assert.deepEqual(computeReturns([100, 110]), [0.1]);
  assert.ok(computeReturns([100, 0, 50]).every(Number.isFinite));
  assert.deepEqual(computeReturns([100]), []);
  assert.deepEqual(computeReturns([]), []);
});

test("covariance needs two paired samples", () => {
  // len - 1 === 0 used to return Infinity/NaN here.
  assert.equal(covariance([0.1], [0.2]), 0);
  assert.equal(covariance([], []), 0);

  const a = [0.1, -0.2, 0.3, -0.1];
  assert.ok(Number.isFinite(covariance(a, a)));
  assert.ok(covariance(a, a) > 0, "self-covariance is variance, so positive");
});

test("covariance aligns series on their most recent samples", () => {
  const long = [9, 9, 9, 9, 0.1, -0.1];
  const short = [0.1, -0.1];
  assert.equal(covariance(long, short), covariance([0.1, -0.1], short));
});

test("stdDev is 0 below two samples and positive otherwise", () => {
  assert.equal(stdDev([0.5]), 0);
  assert.ok(stdDev([0.1, -0.1, 0.2, -0.2]) > 0);
});

// ── EWMA ─────────────────────────────────────────────────────────

test("EWMA weights recent observations more heavily", () => {
  // Calm for a long time, then a volatility burst at the end.
  const series = [...new Array(200).fill(0.001), ...syntheticReturns(20, 0.05)];

  const equal = covariance(series, series);
  const ewma = ewmaCovariance(series, series, 0.94);

  assert.ok(
    ewma > equal,
    `EWMA (${ewma}) should exceed equally-weighted (${equal}) after a burst`
  );
});

test("EWMA is stable and falls back to sample covariance for a bad lambda", () => {
  const a = syntheticReturns(100, 0.02, 7);
  assert.ok(Number.isFinite(ewmaCovariance(a, a)));
  assert.ok(ewmaCovariance(a, a) > 0);
  assert.equal(ewmaCovariance(a, a, 1.5), covariance(a, a));
  assert.equal(ewmaCovariance([0.1], [0.1]), 0);
});

test("portfolioVariance of a single asset equals its variance", () => {
  const returns = [0.02, -0.01, 0.03, -0.02, 0.01];
  const variance = portfolioVariance([1], [returns]);
  assert.ok(Math.abs(variance - covariance(returns, returns)) < 1e-12);
});

// ── Distribution helpers ─────────────────────────────────────────

test("normalQuantile matches known z-scores", () => {
  assert.ok(Math.abs(normalQuantile(0.95) - 1.6449) < 1e-3);
  assert.ok(Math.abs(normalQuantile(0.99) - 2.3263) < 1e-3);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-6);
  assert.equal(normalQuantile(0), 0);
  assert.equal(normalQuantile(1), 0);
});

test("normalPdf matches known densities", () => {
  assert.ok(Math.abs(normalPdf(0) - 0.39894) < 1e-4);
  assert.ok(Math.abs(normalPdf(1.6449) - 0.10314) < 1e-4);
});

test("quantile interpolates on the sorted sample", () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 1), 5);
  assert.equal(quantile(sorted, 0.5), 3);
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([7], 0.5), 7);
});

// ── Horizon aggregation ──────────────────────────────────────────

test("aggregateReturns compounds over the window", () => {
  // Two periods of +10% compound to +21%, not +20%.
  const agg = aggregateReturns([0.1, 0.1], 2);
  assert.equal(agg.length, 1);
  assert.ok(Math.abs(agg[0] - 0.21) < 1e-12);

  assert.deepEqual(aggregateReturns([0.1, 0.2], 1), [0.1, 0.2]);
  assert.deepEqual(aggregateReturns([0.1], 5), []);
  // Overlapping windows: n - k + 1 samples.
  assert.equal(aggregateReturns(new Array(100).fill(0.001), 24).length, 77);
});

test("lambda is rescaled so EWMA memory is fixed in days, not samples", () => {
  // RiskMetrics 0.94 on daily data means ~17 days of memory. Applied raw to
  // hourly data it means ~17 hours, which measures intraday noise — on real
  // SOL data that doubled the reported one-day VaR.
  assert.equal(scaleLambdaToFrequency(0.94, 1), 0.94);
  assert.ok(Math.abs(scaleLambdaToFrequency(0.94, 24) - 0.9975) < 1e-9);

  // Effective memory in days is preserved across frequencies.
  const dailyMemory = 1 / (1 - 0.94);
  const hourly = scaleLambdaToFrequency(0.94, 24);
  assert.ok(Math.abs(1 / (1 - hourly) / 24 - dailyMemory) < 1e-6);

  // Degenerate inputs pass through untouched.
  assert.equal(scaleLambdaToFrequency(0.94, 0), 0.94);
  assert.equal(scaleLambdaToFrequency(1.5, 24), 1.5);
});

test("frequency rescaling keeps VaR stable across sampling rates", () => {
  // The same 30 days of volatility, sampled hourly vs daily, should give
  // comparable one-day VaR. Without rescaling the hourly figure runs ~2x hot.
  const daily = syntheticReturns(30, 0.029, 101);
  const hourly = syntheticReturns(720, 0.029 / Math.sqrt(24), 101);

  const fromDaily = calculatePortfolioRisk({
    portfolioValue: 1_000_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: daily },
    periodsPerDay: 1,
  });
  const fromHourly = calculatePortfolioRisk({
    portfolioValue: 1_000_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: hourly },
    periodsPerDay: 24,
  });

  const ratio = fromHourly.varPct / fromDaily.varPct;
  assert.ok(
    ratio > 0.6 && ratio < 1.6,
    `hourly and daily VaR should agree within tolerance, got ratio ${ratio}`
  );
});

test("overlapping samples are reported separately from independent ones", () => {
  const r = calculatePortfolioRisk({
    portfolioValue: 100_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: syntheticReturns(720, 0.006, 103) },
    periodsPerDay: 24,
  });

  // 720 hourly returns -> 697 overlapping daily windows, but only ~29 days.
  assert.ok(r.observations > 600);
  assert.ok(r.independentObservations <= 30);
  assert.equal(
    r.independentObservations,
    Math.floor(r.observations / 24)
  );
});

// ── The horizon bug ──────────────────────────────────────────────

test("volatility is scaled from the sampling period to the horizon", () => {
  // The bug this pins: sigma computed from hourly returns was reported as a
  // one-day figure, understating VaR by sqrt(24). The scaling law is the
  // invariant — sigmaHorizon = sigmaPeriod * sqrt(periods in the horizon).
  const returns = syntheticReturns(400, 0.01, 3);

  for (const [periodsPerDay, horizonDays] of [
    [24, 1],
    [24, 7],
    [1, 1],
    [288, 1],
  ] as const) {
    const r = calculatePortfolioRisk({
      portfolioValue: 1_000_000,
      weightsBySymbol: { SOL: 1 },
      returnsBySymbol: { SOL: returns },
      periodsPerDay,
      horizonDays,
    });

    const expected = Math.sqrt(periodsPerDay * horizonDays);
    assert.ok(
      Math.abs(r.sigmaHorizon / r.sigmaPeriod - expected) < 1e-9,
      `${periodsPerDay}/day over ${horizonDays}d: expected ${expected}x, got ${
        r.sigmaHorizon / r.sigmaPeriod
      }`
    );
  }
});

test("ignoring the sampling frequency understates VaR by sqrt(24)", () => {
  // Reproduces the original defect end to end: hourly returns treated as if
  // they were daily.
  const returns = syntheticReturns(400, 0.01, 3);
  const base = {
    portfolioValue: 1_000_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: returns },
  };

  const correct = calculatePortfolioRisk({ ...base, periodsPerDay: 24 });
  const buggy = calculatePortfolioRisk({ ...base, periodsPerDay: 1 });

  assert.ok(
    correct.varPct > buggy.varPct * 2,
    `correct ${correct.varPct} should far exceed the unscaled ${buggy.varPct}`
  );
});

test("a longer horizon produces a larger loss estimate", () => {
  const returns = syntheticReturns(400, 0.01, 11);
  const base = { portfolioValue: 1_000_000, weightsBySymbol: { SOL: 1 }, returnsBySymbol: { SOL: returns }, periodsPerDay: 24 };

  const oneDay = calculatePortfolioRisk({ ...base, horizonDays: 1 });
  const tenDay = calculatePortfolioRisk({ ...base, horizonDays: 10 });

  assert.ok(tenDay.varPct > oneDay.varPct);
  assert.ok(
    Math.abs(tenDay.varPct / oneDay.varPct - Math.sqrt(10)) < 1e-6,
    "parametric VaR scales with sqrt(horizon)"
  );
});

// ── Expected Shortfall ───────────────────────────────────────────

test("Expected Shortfall always exceeds VaR at the same confidence", () => {
  const returns = syntheticReturns(500, 0.015, 5);
  const r = calculatePortfolioRisk({
    portfolioValue: 500_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: returns },
    periodsPerDay: 24,
  });

  assert.ok(r.esPct > r.varPct, "ES is the mean beyond VaR, so strictly worse");
  // For a normal at 95%: ES/VaR = phi(z)/((1-c) * z) ~= 1.2536
  assert.ok(Math.abs(r.esPct / r.varPct - 1.2536) < 1e-3);
  assert.ok(r.esUsd > r.varUsd);
});

test("higher confidence produces a larger VaR", () => {
  const returns = syntheticReturns(400, 0.01, 13);
  const base = { portfolioValue: 100_000, weightsBySymbol: { SOL: 1 }, returnsBySymbol: { SOL: returns }, periodsPerDay: 24 };

  const p95 = calculatePortfolioRisk({ ...base, confidence: 0.95 });
  const p99 = calculatePortfolioRisk({ ...base, confidence: 0.99 });

  assert.ok(p99.varPct > p95.varPct);
});

// ── Historical simulation ────────────────────────────────────────

test("historical simulation runs once there are enough horizon samples", () => {
  const returns = syntheticReturns(600, 0.01, 17);
  const r = calculatePortfolioRisk({
    portfolioValue: 250_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: returns },
    periodsPerDay: 24,
  });

  assert.ok(r.observations >= MIN_HISTORICAL_OBSERVATIONS);
  assert.ok(r.histVarPct > 0);
  assert.ok(r.histEsPct >= r.histVarPct, "historical ES cannot be below VaR");
});

test("historical figures are withheld when the sample is too thin", () => {
  // 40 hourly points cannot produce 30 independent daily observations.
  const r = calculatePortfolioRisk({
    portfolioValue: 100_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: syntheticReturns(40, 0.01, 19) },
    periodsPerDay: 24,
  });

  assert.ok(r.observations < MIN_HISTORICAL_OBSERVATIONS);
  assert.equal(r.histVarPct, 0);
  assert.ok(r.varPct > 0, "parametric still reports");
  assert.equal(r.headlineModel, "parametric");
});

test("the headline takes the more conservative of the two models", () => {
  const returns = syntheticReturns(600, 0.012, 23);
  const r = calculatePortfolioRisk({
    portfolioValue: 100_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: returns },
    periodsPerDay: 24,
  });

  assert.equal(r.headlineVarPct, Math.max(r.varPct, r.histVarPct));
  assert.equal(
    r.headlineModel,
    r.histVarPct > r.varPct ? "historical" : "parametric"
  );
  assert.ok(Math.abs(r.headlineVarUsd - (r.headlineVarPct / 100) * 100_000) < 1e-9);
});

// ── Alignment ────────────────────────────────────────────────────

test("risk is aligned by symbol, not by position", () => {
  // SOL calm and dominant, BONK wild and tiny. Pairing by position after a
  // dropped row would score the 97% position with the wild series.
  const calm = syntheticReturns(300, 0.002, 29);
  const wild = syntheticReturns(300, 0.08, 31);
  const weights = { SOL: 0.97, BONK: 0.03 };

  const correct = calculatePortfolioRisk({
    portfolioValue: 1_000_000,
    weightsBySymbol: weights,
    returnsBySymbol: { SOL: calm, BONK: wild },
    periodsPerDay: 24,
  });
  const swapped = calculatePortfolioRisk({
    portfolioValue: 1_000_000,
    weightsBySymbol: weights,
    returnsBySymbol: { SOL: wild, BONK: calm },
    periodsPerDay: 24,
  });

  assert.ok(correct.varPct < swapped.varPct);
  assert.equal(correct.coverage, 1);
  assert.deepEqual(correct.uncovered, []);
});

test("uncovered weight is reported rather than misaligned", () => {
  const r = calculatePortfolioRisk({
    portfolioValue: 100_000,
    weightsBySymbol: { SOL: 0.6, JUP: 0.4 },
    returnsBySymbol: { SOL: syntheticReturns(200, 0.01, 37) }, // JUP missing
    periodsPerDay: 24,
  });

  assert.deepEqual(r.uncovered, ["JUP"]);
  assert.ok(Math.abs(r.coverage - 0.6) < 1e-12);
  assert.ok(r.varPct > 0);
});

test("degenerate inputs return zeros rather than NaN", () => {
  const noValue = calculatePortfolioRisk({
    portfolioValue: 0,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: [0.1, 0.2] },
    periodsPerDay: 24,
  });
  assert.equal(noValue.varPct, 0);
  assert.equal(noValue.headlineVarUsd, 0);

  // periodsPerDay of 0 means the interval could not be measured — the model
  // must refuse rather than invent a horizon.
  const noInterval = calculatePortfolioRisk({
    portfolioValue: 100_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: { SOL: [0.1, 0.2] },
    periodsPerDay: 0,
  });
  assert.equal(noInterval.varPct, 0);

  const noSeries = calculatePortfolioRisk({
    portfolioValue: 100_000,
    weightsBySymbol: { SOL: 1 },
    returnsBySymbol: {},
    periodsPerDay: 24,
  });
  assert.deepEqual(noSeries.uncovered, ["SOL"]);
  assert.equal(noSeries.varPct, 0);
});

test("zero and negative weights are ignored", () => {
  const series = syntheticReturns(200, 0.01, 41);
  const r = calculatePortfolioRisk({
    portfolioValue: 50_000,
    weightsBySymbol: { SOL: 1, USDC: 0 },
    returnsBySymbol: { SOL: series, USDC: series },
    periodsPerDay: 24,
  });

  assert.deepEqual(r.uncovered, []);
  assert.equal(r.coverage, 1);
});
