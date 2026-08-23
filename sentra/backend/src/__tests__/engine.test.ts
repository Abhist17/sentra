/**
 * Market-signal tests.
 *
 * These cover the path that turns raw prices into the stress score and the
 * alerts — previously the largest untested surface in the engine, and the one
 * that decides whether a user's phone buzzes.
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  detectRapidDrops,
  computeMarketStressScore,
  detectVolatilitySpike,
  detectCorrelationBreakdown,
  computeVolatility,
  updatePriceWindow,
  resetPriceWindow,
} from "../engine/risk.engine";
import type { PriceMap } from "../services/price.service";

const prices = (p: Partial<PriceMap>): PriceMap => ({
  SOL: 100,
  BONK: 0.00001,
  JUP: 1,
  USDC: 1,
  ...p,
});

beforeEach(() => resetPriceWindow());

// ── Rapid drops ──────────────────────────────────────────────────

test("a drop past the threshold is detected with its magnitude", () => {
  const r = detectRapidDrops(prices({ SOL: 95 }), { SOL: 100 }, -3);

  assert.equal(r.detected, true);
  assert.equal(r.drops.length, 1);
  assert.equal(r.drops[0].symbol, "SOL");
  assert.ok(Math.abs(r.drops[0].changePercent - -5) < 1e-9);
});

test("a move inside the threshold is recorded but not flagged", () => {
  const r = detectRapidDrops(prices({ SOL: 98 }), { SOL: 100 }, -3);

  assert.equal(r.detected, false);
  assert.deepEqual(r.drops, []);
  // The change is still reported — the UI shows it even when it is not an event.
  assert.ok(Math.abs(r.changes.SOL! - -2) < 1e-9);
});

test("stablecoins are excluded from drop signals", () => {
  // A 5% "move" on USDC is a feed glitch far more often than a depeg, and
  // treating it as a market event produced noise alerts.
  const r = detectRapidDrops(prices({ USDC: 0.94 }), { USDC: 1 }, -3);

  assert.equal(r.detected, false);
  assert.ok(r.changes.USDC !== undefined, "still reported as a price change");
});

test("a missing or zero previous price yields no signal", () => {
  assert.equal(detectRapidDrops(prices({}), {}, -3).detected, false);
  assert.equal(detectRapidDrops(prices({}), { SOL: 0 }, -3).detected, false);
  // No previous price means no change to report, rather than a fake 0%.
  assert.equal(detectRapidDrops(prices({}), {}, -3).changes.SOL, undefined);
});

test("gains are never reported as drops", () => {
  const r = detectRapidDrops(prices({ SOL: 130 }), { SOL: 100 }, -3);
  assert.equal(r.detected, false);
  assert.ok(r.changes.SOL! > 0);
});

// ── Volatility window ────────────────────────────────────────────

test("volatility needs several observations before it means anything", () => {
  updatePriceWindow("SOL", 100);
  assert.equal(computeVolatility("SOL"), 0);

  updatePriceWindow("SOL", 101);
  assert.equal(computeVolatility("SOL"), 0, "one return is not a dispersion");

  updatePriceWindow("SOL", 99);
  updatePriceWindow("SOL", 103);
  assert.ok(computeVolatility("SOL") > 0);
});

test("a steady price has zero volatility", () => {
  for (let i = 0; i < 6; i++) updatePriceWindow("SOL", 100);
  assert.equal(computeVolatility("SOL"), 0);
});

test("volatility spikes flag the moving asset and skip stablecoins", () => {
  // SOL swinging hard, USDC drifting by the same relative amount.
  for (const p of [100, 110, 95, 112, 92]) updatePriceWindow("SOL", p);
  for (const p of [1, 1.1, 0.95, 1.12, 0.92]) updatePriceWindow("USDC", p);

  const r = detectVolatilitySpike(0.03);

  assert.ok(r.spiking);
  assert.ok(r.spikingAssets.includes("SOL"));
  assert.ok(
    !r.spikingAssets.includes("USDC"),
    "a stablecoin swinging is a feed problem, not a market signal"
  );
  // Volatility is still measured for every asset, spiking or not.
  assert.ok(r.volatility.USDC > 0);
});

test("a calm market produces no spike", () => {
  for (const p of [100, 100.1, 99.9, 100.05, 100]) updatePriceWindow("SOL", p);
  assert.equal(detectVolatilitySpike(0.03).spiking, false);
});

// ── Correlation breakdown ────────────────────────────────────────

test("correlation breakdown fires when the risk assets fall together", () => {
  // Three non-stable assets all trending down: the systemic case.
  for (const p of [100, 98, 96, 94]) updatePriceWindow("SOL", p);
  for (const p of [1, 0.98, 0.96, 0.94]) updatePriceWindow("BONK", p);
  for (const p of [1, 0.97, 0.95, 0.93]) updatePriceWindow("JUP", p);

  const r = detectCorrelationBreakdown(3, 3);

  assert.equal(r.breakdown, true);
  assert.equal(r.fallingCount, 3);
});

test("one asset falling alone is not systemic", () => {
  for (const p of [100, 98, 96, 94]) updatePriceWindow("SOL", p);
  for (const p of [1, 1.02, 1.04, 1.06]) updatePriceWindow("BONK", p);
  for (const p of [1, 1.01, 1.03, 1.04]) updatePriceWindow("JUP", p);

  const r = detectCorrelationBreakdown(3, 3);

  assert.equal(r.breakdown, false);
  assert.deepEqual(r.fallingAssets, ["SOL"]);
});

test("correlation breakdown needs enough history to judge", () => {
  updatePriceWindow("SOL", 100);
  updatePriceWindow("SOL", 99);
  // Two prices give one return, short of the lookback.
  assert.equal(detectCorrelationBreakdown(3, 3).fallingCount, 0);
});

// ── Stress score ─────────────────────────────────────────────────

test("stress score is zero and LOW when nothing is firing", () => {
  const s = computeMarketStressScore(false, [], false, [], false, []);
  assert.equal(s.score, 0);
  assert.equal(s.level, "LOW");
  assert.deepEqual(s.signals, []);
});

test("each signal contributes its documented weight", () => {
  const vol = computeMarketStressScore(true, ["SOL"], false, [], false, []);
  assert.equal(vol.score, 30);
  assert.equal(vol.level, "MODERATE");

  const corr = computeMarketStressScore(false, [], true, ["SOL", "JUP"], false, []);
  assert.equal(corr.score, 30);

  const drop = computeMarketStressScore(false, [], false, [], true, [
    { symbol: "SOL", changePercent: -6 },
  ]);
  assert.equal(drop.score, 40);
  assert.equal(drop.level, "HIGH");
});

test("stress score saturates at 100 and escalates to CRITICAL", () => {
  const s = computeMarketStressScore(
    true,
    ["SOL", "BONK"],
    true,
    ["SOL", "BONK", "JUP"],
    true,
    [{ symbol: "SOL", changePercent: -8 }]
  );

  assert.equal(s.score, 100, "30 + 30 + 40 caps at 100");
  assert.equal(s.level, "CRITICAL");
  assert.equal(s.signals.length, 3, "every active signal is explained");
});

test("stress signals name the assets involved", () => {
  const s = computeMarketStressScore(
    true,
    ["SOL"],
    false,
    [],
    true,
    [{ symbol: "BONK", changePercent: -7.5 }]
  );

  assert.ok(s.signals.some((sig) => sig.includes("SOL")));
  assert.ok(s.signals.some((sig) => sig.includes("BONK")));
  assert.ok(
    s.signals.some((sig) => sig.includes("-7.50")),
    "the magnitude is in the message, not just the fact of a drop"
  );
});

test("band boundaries land on the documented levels", () => {
  const at = (score: number) =>
    computeMarketStressScore(
      score >= 30,
      [],
      score >= 60,
      [],
      score >= 40 && score !== 60,
      []
    ).level;

  assert.equal(computeMarketStressScore(false, [], false, [], false, []).level, "LOW");
  assert.equal(computeMarketStressScore(true, [], false, [], false, []).level, "MODERATE");
  assert.equal(computeMarketStressScore(false, [], false, [], true, []).level, "HIGH");
  assert.equal(computeMarketStressScore(true, [], true, [], true, []).level, "CRITICAL");
  void at;
});
