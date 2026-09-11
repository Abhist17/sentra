/**
 * The demo dataset is the first thing a visitor sees, so it has to be
 * internally consistent in every way the live data would be: weights that
 * sum to one, anchors that sit on the drawn series, a correlation matrix
 * that is symmetric with a unit diagonal, and nothing that pretends to be a
 * real transaction.
 */
import { describe, expect, it } from "vitest";
import { buildDemoOverview } from "../demo";

const overview = buildDemoOverview();

describe("demo overview", () => {
  it("is labelled as synthetic everywhere it matters", () => {
    expect(overview.demo).toBe(true);
    for (const w of overview.wallets) {
      expect(w.isDemo).toBe(true);
      for (const a of w.anchors) {
        // No signature and no account: nothing links to an explorer page
        // for a transaction that never happened.
        expect(a.signature).toBe("");
        expect(a.pda).toBe("");
      }
    }
  });

  it("prices every asset the engine tracks", () => {
    const priced = Object.keys(overview.market.prices ?? {});
    for (const symbol of overview.config.trackedAssets) {
      expect(priced).toContain(symbol);
    }
    expect(overview.market.historyAssets).toBe(overview.config.trackedAssets.length);
  });

  it("has books whose weights sum to one and totals that add up", () => {
    let portfolio = 0;
    for (const w of overview.wallets) {
      const m = w.metrics!;
      const weight = m.holdings.reduce((s, h) => s + h.weight, 0);
      const value = m.holdings.reduce((s, h) => s + h.value, 0);
      expect(Math.abs(weight - 1)).toBeLessThan(1e-9);
      expect(Math.abs(value - m.portfolio)).toBeLessThan(1e-6);
      portfolio += m.portfolio;

      const riskShare = m.model.contributions.reduce((s, c) => s + c.riskShare, 0);
      expect(Math.abs(riskShare - 1)).toBeLessThan(1e-9);
    }
    expect(Math.abs(portfolio - overview.totals.portfolio)).toBeLessThan(1e-6);
    expect(overview.totals.wallets).toBe(overview.wallets.length);
  });

  it("makes the argument: similar value, very different risk", () => {
    const [a, b] = overview.wallets.map((w) => w.metrics!);
    const valueGap = Math.abs(a.portfolio - b.portfolio) / Math.max(a.portfolio, b.portfolio);
    expect(valueGap).toBeLessThan(0.15);
    expect(Math.abs(a.risk - b.risk)).toBeGreaterThan(15);
  });

  it("anchors readings that lie on the drawn series", () => {
    for (const w of overview.wallets) {
      expect(w.anchors.length).toBeGreaterThan(0);
      const byTime = new Map(w.history.map((p) => [Math.floor(p.t / 1000), p.risk]));
      for (const a of w.anchors) {
        const drawn = byTime.get(a.timestamp);
        expect(drawn).toBeDefined();
        expect(a.riskScore).toBe(Math.round(drawn!));
        expect(a.valueUsd).toBe(w.metrics!.portfolio);
      }
      // Newest last, like the engine's ring buffer.
      for (let i = 1; i < w.anchors.length; i++) {
        expect(w.anchors[i].timestamp).toBeGreaterThan(w.anchors[i - 1].timestamp);
      }
    }
  });

  it("carries a correlation matrix a model could have produced", () => {
    const c = overview.market.correlation!;
    expect(c.symbols.length).toBe(c.matrix.length);
    for (let i = 0; i < c.symbols.length; i++) {
      expect(c.matrix[i].length).toBe(c.symbols.length);
      expect(c.matrix[i][i]).toBe(1);
      for (let j = 0; j < c.symbols.length; j++) {
        expect(c.matrix[i][j]).toBe(c.matrix[j][i]);
        expect(c.matrix[i][j]).toBeGreaterThanOrEqual(-1);
        expect(c.matrix[i][j]).toBeLessThanOrEqual(1);
        if (i !== j) expect(c.matrix[i][j]).not.toBe(0);
      }
    }
    // No stablecoins: their correlation with anything is feed noise.
    expect(c.symbols).not.toContain("USDC");
    expect(c.symbols).not.toContain("USDT");
    // The liquid-staking token is SOL in another wrapper.
    const sol = c.symbols.indexOf("SOL");
    const jito = c.symbols.indexOf("JITOSOL");
    expect(c.matrix[sol][jito]).toBeGreaterThan(0.95);
  });

  it("names the real program and says it is not anchoring", () => {
    expect(overview.config.onchain.programId).toBe(
      "6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj"
    );
    expect(overview.config.onchain.cluster).toBe("devnet");
    expect(overview.config.onchain.reporter).toBeNull();
  });
});
