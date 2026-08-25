/**
 * Risk-history store tests.
 *
 * The series here is the one piece of state the engine cannot re-fetch from
 * anywhere — prices and balances come back on the next tick, but a wallet's
 * risk over time only exists because this process kept it. So the two things
 * that can lose or corrupt it are what these cover: the ring buffer that
 * bounds it, and the validation that decides what a restart is allowed to
 * reinstate.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRiskHistory,
  updateMetrics,
  getRiskHistory,
  forgetWallet,
  serialiseRiskHistory,
  type WalletMetrics,
} from "../store/metrics.store";
import { CONFIG } from "../config/env";

function metrics(address: string, risk: number, at: number): WalletMetrics {
  return {
    address,
    label: address,
    risk,
    portfolio: 1000,
    breakdown: { var: risk, concentration: 0, stress: 0, trend: 0 },
    varUsd: 10,
    esUsd: 12,
    model: {
      headline: "parametric",
      horizonDays: 1,
      confidence: 0.95,
      periodsPerDay: 24,
      observations: 100,
      independentObservations: 4,
      lambdaApplied: 0.9975,
      parametric: { varUsd: 10, esUsd: 12 },
      historical: { varUsd: 8, esUsd: 9 },
      contributions: [],
      diversificationRatio: 1,
    },
    maxWeight: 1,
    coverage: 1,
    holdings: [],
    updatedAt: at,
  };
}

// ── Ring buffer ──────────────────────────────────────────────────

test("history is bounded, keeping the newest points", () => {
  const address = "ring-buffer-wallet";
  const overflow = CONFIG.HISTORY_POINTS + 50;

  for (let i = 0; i < overflow; i++) {
    updateMetrics(metrics(address, i % 100, 1_000_000 + i));
  }

  const series = getRiskHistory(address);
  assert.equal(series.length, CONFIG.HISTORY_POINTS);
  // The tail is what the chart draws, so it is the tail that must survive.
  assert.equal(series[series.length - 1].t, 1_000_000 + overflow - 1);

  forgetWallet(address);
});

test("forgetting a wallet drops its series from the persisted shape too", () => {
  const address = "forgotten-wallet";
  updateMetrics(metrics(address, 40, 2_000_000));

  assert.equal(getRiskHistory(address).length, 1);
  forgetWallet(address);

  assert.equal(getRiskHistory(address).length, 0);
  assert.ok(!(address in serialiseRiskHistory()));
});

// ── Restore validation ───────────────────────────────────────────

test("a well-formed file round-trips", () => {
  const restored = parseRiskHistory({
    wallet: [
      { t: 1, risk: 10, portfolio: 100 },
      { t: 2, risk: 20, portfolio: 200 },
    ],
  });

  assert.equal(restored.get("wallet")?.length, 2);
});

test("points that would break the chart's scale are dropped", () => {
  const restored = parseRiskHistory({
    wallet: [
      { t: 1, risk: 10, portfolio: 100 },
      { t: 2, risk: NaN, portfolio: 100 },
      { t: 3, risk: 150, portfolio: 100 },
      { t: 4, risk: -5, portfolio: 100 },
      { t: 0, risk: 10, portfolio: 100 },
      { t: 5, risk: 10, portfolio: -1 },
      { t: 6, risk: 10, portfolio: Infinity },
      null,
      "nonsense",
      { t: 7, risk: 30, portfolio: 300 },
    ],
  });

  const series = restored.get("wallet");
  assert.equal(series?.length, 2);
  assert.deepEqual(
    series?.map((p) => p.t),
    [1, 7]
  );
});

test("restored points are ordered by time", () => {
  const restored = parseRiskHistory({
    wallet: [
      { t: 30, risk: 3, portfolio: 3 },
      { t: 10, risk: 1, portfolio: 1 },
      { t: 20, risk: 2, portfolio: 2 },
    ],
  });

  assert.deepEqual(
    restored.get("wallet")?.map((p) => p.t),
    [10, 20, 30]
  );
});

test("a longer file cannot reinstate a bigger buffer than this build holds", () => {
  const points = Array.from({ length: CONFIG.HISTORY_POINTS + 100 }, (_, i) => ({
    t: i + 1,
    risk: 50,
    portfolio: 100,
  }));

  const series = parseRiskHistory({ wallet: points }).get("wallet");
  assert.equal(series?.length, CONFIG.HISTORY_POINTS);
  // Truncating from the wrong end would silently discard the recent history
  // and restore only the oldest points.
  assert.equal(series?.[series.length - 1].t, CONFIG.HISTORY_POINTS + 100);
});

test("garbage files restore nothing rather than throwing", () => {
  for (const raw of [null, undefined, 42, "text", [], { wallet: "no" }, { wallet: [] }]) {
    const restored = parseRiskHistory(raw);
    assert.equal(restored.size, 0);
  }
});

test("a wallet whose points are all invalid is omitted entirely", () => {
  const restored = parseRiskHistory({
    good: [{ t: 1, risk: 10, portfolio: 100 }],
    bad: [{ t: 1, risk: NaN, portfolio: 100 }],
  });

  assert.ok(restored.has("good"));
  assert.ok(!restored.has("bad"));
});
