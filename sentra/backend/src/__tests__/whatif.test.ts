/**
 * What-if scoring.
 *
 * The answer to "what if I sold half of this" is only worth showing if it is
 * the same arithmetic as the live score on a different shape. These pin the
 * invariants that make it trustworthy: value is preserved, the live path and
 * the hypothetical path agree on an unchanged book, and moving a volatile
 * position into a stablecoin lowers the loss estimate rather than merely
 * relabelling it.
 */
import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sentra-whatif-"));

import {
  scoreBook,
  whatIf,
  setHistoryForTests,
  resetPriceWindow,
} from "../engine/risk.engine";
import { addWallet } from "../services/wallet.registry";
import {
  updateMetrics,
  updateMarket,
  forgetWallet,
  type AssetHolding,
  type WalletMetrics,
} from "../store/metrics.store";

// Deterministic pseudo-random normal returns, as in risk.test.ts.
function synthetic(n: number, sigma: number, seed: number): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    out.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma);
  }
  return out;
}

const WALLET = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

function book(spec: { symbol: string; value: number; price: number }[]): {
  holdings: AssetHolding[];
  total: number;
} {
  const total = spec.reduce((sum, s) => sum + s.value, 0);
  const holdings = spec.map((s) => ({
    symbol: s.symbol,
    amount: s.value / s.price,
    price: s.price,
    value: s.value,
    weight: s.value / total,
  }));
  return { holdings, total };
}

function seedWallet(holdings: AssetHolding[], total: number) {
  const scored = scoreBook(holdings, total, 0);
  const metrics: WalletMetrics = {
    address: WALLET,
    label: "test",
    risk: scored.hybridRisk,
    portfolio: total,
    breakdown: scored.breakdown,
    varUsd: scored.risk.headlineVarUsd,
    esUsd: scored.risk.headlineEsUsd,
    model: {
      headline: scored.risk.headlineModel,
      horizonDays: 1,
      confidence: 0.95,
      periodsPerDay: 24,
      observations: scored.risk.observations,
      independentObservations: scored.risk.independentObservations,
      lambdaApplied: scored.risk.lambdaApplied,
      parametric: { varUsd: scored.risk.varUsd, esUsd: scored.risk.esUsd },
      historical: { varUsd: scored.risk.histVarUsd, esUsd: scored.risk.histEsUsd },
      contributions: [],
      diversificationRatio: scored.risk.diversificationRatio,
    },
    maxWeight: scored.concentration.maxWeight,
    coverage: scored.risk.coverage,
    holdings,
    updatedAt: Date.now(),
  };
  updateMetrics(metrics);
  return scored;
}

before(() => {
  // Hourly series: a calm SOL, a wild BONK, a flat USDC.
  setHistoryForTests(
    {
      SOL: synthetic(720, 0.006, 11),
      BONK: synthetic(720, 0.02, 12),
      USDC: synthetic(720, 0.00005, 13),
    },
    24
  );
  updateMarket({
    prices: {
      SOL: 100,
      JITOSOL: 130,
      USDC: 1,
      USDT: 1,
      JUP: 0.25,
      BONK: 0.000003,
      WIF: 0.2,
      JTO: 0.4,
      PYTH: 0.05,
      RAY: 1.7,
    },
    stress: { score: 0, level: "LOW", signals: [] },
  });
  try {
    addWallet(WALLET, "test");
  } catch {
    // Already registered by an earlier file in the same process.
  }
});

beforeEach(() => resetPriceWindow());

test("an unchanged book scores the same through both paths", () => {
  const { holdings, total } = book([
    { symbol: "SOL", value: 60_000, price: 100 },
    { symbol: "BONK", value: 30_000, price: 0.000003 },
    { symbol: "USDC", value: 10_000, price: 1 },
  ]);
  const live = seedWallet(holdings, total);

  // Moving nothing is the identity.
  const r = whatIf(WALLET, "BONK", 0);
  assert.ok(r);
  assert.ok(Math.abs(r.before.risk - live.hybridRisk) < 1e-9);
  assert.ok(Math.abs(r.after.risk - live.hybridRisk) < 1e-9);
  assert.equal(r.movedUsd, 0);
  forgetWallet(WALLET);
});

test("selling into a stablecoin preserves value and lowers the loss estimate", () => {
  const { holdings, total } = book([
    { symbol: "SOL", value: 60_000, price: 100 },
    { symbol: "BONK", value: 30_000, price: 0.000003 },
    { symbol: "USDC", value: 10_000, price: 1 },
  ]);
  seedWallet(holdings, total);

  const r = whatIf(WALLET, "BONK", 0.5, "USDC");
  assert.ok(r);
  assert.equal(r.movedUsd, 15_000);

  const valueBefore = r.before.holdings.reduce((s, h) => s + h.value, 0);
  const valueAfter = r.after.holdings.reduce((s, h) => s + h.value, 0);
  assert.ok(Math.abs(valueBefore - valueAfter) < 1e-6, "value is preserved");

  const usdc = r.after.holdings.find((h) => h.symbol === "USDC")!;
  const bonk = r.after.holdings.find((h) => h.symbol === "BONK")!;
  assert.equal(usdc.value, 25_000);
  assert.equal(bonk.value, 15_000);

  assert.ok(r.after.varUsd < r.before.varUsd, "VaR falls");
  assert.ok(r.after.risk < r.before.risk, "the blended score falls");
  assert.ok(r.after.breakdown.var < r.before.breakdown.var);
  forgetWallet(WALLET);
});

test("moving everything out of an asset removes it from the book", () => {
  const { holdings, total } = book([
    { symbol: "SOL", value: 70_000, price: 100 },
    { symbol: "BONK", value: 30_000, price: 0.000003 },
  ]);
  seedWallet(holdings, total);

  const r = whatIf(WALLET, "BONK", 1, "USDC");
  assert.ok(r);
  assert.ok(!r.after.holdings.some((h) => h.symbol === "BONK"));
  // USDC did not exist in the book; the proceeds create the position.
  assert.equal(r.after.holdings.find((h) => h.symbol === "USDC")?.value, 30_000);
  forgetWallet(WALLET);
});

test("concentrating into one asset raises the concentration penalty", () => {
  const { holdings, total } = book([
    { symbol: "SOL", value: 50_000, price: 100 },
    { symbol: "BONK", value: 25_000, price: 0.000003 },
    { symbol: "USDC", value: 25_000, price: 1 },
  ]);
  seedWallet(holdings, total);

  // Sell all the USDC for SOL: the largest position goes from 50% to 75%.
  const r = whatIf(WALLET, "USDC", 1, "SOL");
  assert.ok(r);
  assert.ok(r.after.maxWeight > r.before.maxWeight);
  assert.ok(r.after.breakdown.concentration > r.before.breakdown.concentration);
  assert.ok(r.after.effectiveAssets < r.before.effectiveAssets);
  forgetWallet(WALLET);
});

test("nonsense is refused rather than scored", () => {
  const { holdings, total } = book([
    { symbol: "SOL", value: 100_000, price: 100 },
  ]);
  seedWallet(holdings, total);

  assert.equal(whatIf(WALLET, "DOGE", 0.5), null, "unknown asset");
  assert.equal(whatIf(WALLET, "BONK", 0.5), null, "not held");
  assert.equal(whatIf(WALLET, "SOL", 1.5), null, "fraction above one");
  assert.equal(whatIf(WALLET, "SOL", -0.1), null, "negative fraction");
  assert.equal(whatIf(WALLET, "SOL", 0.5, "SOL"), null, "same asset both sides");
  assert.equal(whatIf("unknown-wallet", "SOL", 0.5), null, "unscored wallet");
  forgetWallet(WALLET);
});
