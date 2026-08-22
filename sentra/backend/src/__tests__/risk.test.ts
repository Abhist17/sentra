/**
 * Unit tests for the quant core. Run with `npm test`.
 *
 * These cover the failure modes that were silently corrupting scores:
 * a one-sample covariance dividing by zero, and weights being paired with
 * the wrong asset's returns when a history fetch failed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  mean,
  computeReturns,
  covariance,
  stdDev,
  portfolioVariance,
  calculateVaR,
  calculatePortfolioRisk,
} from "../services/risk.service";

test("mean of an empty series is 0, not NaN", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([2, 4, 6]), 4);
});

test("computeReturns skips samples with a zero or non-finite base", () => {
  assert.deepEqual(computeReturns([100, 110]), [0.1]);

  // A zero price would make the return Infinity and poison every variance.
  const withZero = computeReturns([100, 0, 50]);
  assert.ok(withZero.every(Number.isFinite));

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

  // Pairing from the start would compare `long`'s 9s against `short`'s tail.
  assert.equal(covariance(long, short), covariance([0.1, -0.1], short));
});

test("stdDev is 0 below two samples and positive otherwise", () => {
  assert.equal(stdDev([0.5]), 0);
  assert.ok(stdDev([0.1, -0.1, 0.2, -0.2]) > 0);
});

test("portfolioVariance of a single asset equals its variance", () => {
  const returns = [0.02, -0.01, 0.03, -0.02, 0.01];
  const variance = portfolioVariance([1], [returns]);
  assert.ok(Math.abs(variance - covariance(returns, returns)) < 1e-12);
});

test("calculateVaR returns zeros for degenerate inputs", () => {
  assert.deepEqual(calculateVaR(0, [1], [[0.1, 0.2]]), {
    variance: 0,
    sigma: 0,
    VaR: 0,
    riskScore: 0,
  });
  assert.deepEqual(calculateVaR(1000, [], []), {
    variance: 0,
    sigma: 0,
    VaR: 0,
    riskScore: 0,
  });
});

test("calculateVaR scales linearly with portfolio value", () => {
  const returns = [[0.02, -0.03, 0.01, -0.015, 0.025]];
  const small = calculateVaR(1_000, [1], returns);
  const large = calculateVaR(10_000, [1], returns);

  assert.ok(Math.abs(large.VaR - small.VaR * 10) < 1e-9);
  // riskScore is VaR as a share of value, so it is scale-invariant.
  assert.ok(Math.abs(large.riskScore - small.riskScore) < 1e-9);
});

test("riskScore is capped at 100", () => {
  const wild = [[5, -5, 5, -5, 5, -5]];
  assert.equal(calculateVaR(1000, [1], wild).riskScore, 100);
});

test("calculatePortfolioRisk aligns returns by symbol, not by position", () => {
  // SOL is calm, BONK is wild. If the two were paired by position after a
  // dropped row, the calm 97% weight would be scored with wild returns.
  const calm = [0.001, -0.001, 0.002, -0.002, 0.001];
  const wild = [0.4, -0.35, 0.5, -0.45, 0.38];

  const weights = { SOL: 0.97, BONK: 0.03 };

  const correct = calculatePortfolioRisk(1_000_000, weights, {
    SOL: calm,
    BONK: wild,
  });
  const swapped = calculatePortfolioRisk(1_000_000, weights, {
    SOL: wild,
    BONK: calm,
  });

  assert.ok(
    correct.riskScore < swapped.riskScore,
    "a calm-dominated book must score below a wild-dominated one"
  );
  assert.equal(correct.coverage, 1);
  assert.deepEqual(correct.uncovered, []);
});

test("calculatePortfolioRisk reports uncovered weight instead of misaligning", () => {
  const series = [0.01, -0.02, 0.015, -0.01, 0.02];

  const result = calculatePortfolioRisk(
    100_000,
    { SOL: 0.6, JUP: 0.4 },
    { SOL: series } // JUP's history failed
  );

  assert.deepEqual(result.uncovered, ["JUP"]);
  assert.ok(Math.abs(result.coverage - 0.6) < 1e-12);
  assert.ok(result.riskScore > 0);
});

test("calculatePortfolioRisk ignores zero and negative weights", () => {
  const series = [0.01, -0.02, 0.015, -0.01, 0.02];

  const result = calculatePortfolioRisk(
    50_000,
    { SOL: 1, USDC: 0 },
    { SOL: series, USDC: series }
  );

  assert.deepEqual(result.uncovered, []);
  assert.equal(result.coverage, 1);
});

test("calculatePortfolioRisk returns zeros when nothing is priced", () => {
  const result = calculatePortfolioRisk(0, { SOL: 1 }, { SOL: [0.1, 0.2] });
  assert.equal(result.riskScore, 0);
  assert.equal(result.VaR, 0);
});
