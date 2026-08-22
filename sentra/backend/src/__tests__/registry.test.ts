/**
 * Wallet registry + metrics store. Both hold process state that the API and
 * the engine share, so their edge cases are worth pinning down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The registry persists to CONFIG.DATA_DIR at import time — point it at a
// scratch directory before anything loads the config.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sentra-test-"));

import {
  addWallet,
  removeWallet,
  getWallets,
  hasWallet,
  getWalletCount,
} from "../services/wallet.registry";
import {
  updateMetrics,
  getLatestMetrics,
  getRiskHistory,
  forgetWallet,
  type WalletMetrics,
} from "../store/metrics.store";

const VALID_A = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const VALID_B = "So11111111111111111111111111111111111111112";

test("rejects addresses that are not canonical base58 pubkeys", () => {
  assert.throws(() => addWallet("nonsense"), /Invalid Solana address/);
  assert.throws(() => addWallet(""), /address is required/);
  assert.throws(() => addWallet("   "), /address is required/);

  // Right alphabet, wrong length — decodes to something other than 32 bytes.
  assert.throws(
    () => addWallet("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j11"),
    /Invalid Solana address/
  );

  // Characters outside the base58 alphabet (0, O, I, l).
  assert.throws(() => addWallet("0OIl"), /Invalid Solana address/);

  // A leading "1" encodes an extra zero byte, so this is not canonical.
  assert.throws(
    () => addWallet("1So11111111111111111111111111111111111111112"),
    /Invalid Solana address/
  );
});

test("adds, labels and removes a wallet", () => {
  const before = getWalletCount();

  const entry = addWallet(VALID_A, "  Test Wallet  ");
  assert.equal(entry.label, "Test Wallet");
  assert.equal(entry.isDemo, false);
  assert.equal(hasWallet(VALID_A), true);
  assert.equal(getWalletCount(), before + 1);

  // Duplicates are refused rather than silently replacing the label.
  assert.throws(() => addWallet(VALID_A), /already being monitored/);

  assert.equal(removeWallet(VALID_A), true);
  assert.equal(removeWallet(VALID_A), false);
  assert.equal(getWalletCount(), before);
});

test("derives a short label when none is supplied", () => {
  const entry = addWallet(VALID_B);
  assert.match(entry.label, /^So11…1112$/);
  removeWallet(VALID_B);
});

test("refuses to remove the built-in demo wallet", () => {
  const demo = getWallets().find((w) => w.isDemo);
  assert.ok(demo, "a demo wallet should be seeded");
  assert.throws(() => removeWallet(demo!.address), /Cannot remove demo wallet/);
});

// ── metrics store ────────────────────────────────────────────────

function metrics(address: string, risk: number, portfolio: number): WalletMetrics {
  return {
    address,
    label: address.slice(0, 4),
    risk,
    portfolio,
    breakdown: { var: risk, concentration: 0, stress: 0, trend: 0 },
    varUsd: portfolio * (risk / 100),
    maxWeight: 1,
    coverage: 1,
    holdings: [],
    updatedAt: Date.now(),
  };
}

test("aggregate risk is value-weighted across wallets", () => {
  forgetWallet("A");
  forgetWallet("B");

  // A tiny wallet at 90% risk must not drag a huge calm wallet's aggregate.
  updateMetrics(metrics("A", 10, 1_000_000));
  updateMetrics(metrics("B", 90, 1_000));

  const totals = getLatestMetrics();
  assert.equal(totals.wallets, 2);
  assert.equal(totals.portfolio, 1_001_000);

  const expected = 10 * (1_000_000 / 1_001_000) + 90 * (1_000 / 1_001_000);
  assert.ok(
    Math.abs(totals.risk - expected) < 1e-9,
    `expected ~${expected}, got ${totals.risk}`
  );
  // The old store just kept whichever wallet was written last.
  assert.ok(totals.risk < 11, "aggregate should sit near the dominant wallet");

  forgetWallet("A");
  forgetWallet("B");
});

test("forgetting a wallet removes it from the aggregate", () => {
  forgetWallet("D");
  forgetWallet("E");

  updateMetrics(metrics("D", 20, 100_000));
  updateMetrics(metrics("E", 80, 100_000));
  assert.equal(getLatestMetrics().wallets, 2);

  // A removed wallet must stop contributing to total exposure and VaR —
  // a stale entry here silently inflates every headline figure.
  forgetWallet("E");

  const totals = getLatestMetrics();
  assert.equal(totals.wallets, 1);
  assert.equal(totals.portfolio, 100_000);
  assert.equal(totals.risk, 20);

  forgetWallet("D");
});

test("risk history accumulates per wallet and clears on removal", () => {
  forgetWallet("C");

  updateMetrics(metrics("C", 12, 500));
  updateMetrics(metrics("C", 14, 520));

  const points = getRiskHistory("C");
  assert.equal(points.length, 2);
  assert.equal(points[1].risk, 14);

  forgetWallet("C");
  assert.equal(getRiskHistory("C").length, 0);
});
