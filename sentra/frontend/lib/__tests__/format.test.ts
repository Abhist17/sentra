/**
 * Formatting and risk-band tests.
 *
 * These are user-facing correctness: a band boundary that disagrees with the
 * documented table, or a price rendered as $0.00 because it is below four
 * decimals, is a bug the user sees before anyone sees a stack trace.
 */
import { describe, expect, test } from "vitest";
import {
  usd,
  price,
  tokenAmount,
  pct,
  signedPct,
  shortAddress,
  timeAgo,
  riskBand,
  stressColor,
  assetColor,
  BAND_THRESHOLDS,
} from "../format";

describe("usd", () => {
  test("compacts large figures and keeps small ones exact", () => {
    expect(usd(1_050_000_000)).toBe("$1.05B");
    expect(usd(12_400_000)).toBe("$12.4M");
    expect(usd(8_240)).toBe("$8,240");
    expect(usd(51.25)).toBe("$51.25");
  });

  test("handles zero, negatives and non-numbers", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(NaN)).toBe("—");
    expect(usd(Infinity)).toBe("—");
    expect(usd(-1_000_000)).toContain("-");
  });

  test("compact can be forced either way", () => {
    expect(usd(500, { compact: true })).toBe("$500");
    expect(usd(2_000_000, { compact: false })).toBe("$2,000,000");
  });
});

describe("price", () => {
  test("keeps precision across eight orders of magnitude", () => {
    // BONK trades near $0.000003 — four decimals would render it as $0.0000.
    expect(price(0.00000312)).toBe("$0.00000312");
    expect(price(0.2014)).toBe("$0.2014");
    expect(price(93.62)).toBe("$93.62");
    expect(price(1234.5)).toBe("$1,234.5");
  });

  test("trims trailing zeros on sub-cent prices", () => {
    expect(price(0.0000031)).toBe("$0.0000031");
    expect(price(0.00001)).toBe("$0.00001");
  });

  test("degenerate values", () => {
    expect(price(0)).toBe("$0.00");
    expect(price(NaN)).toBe("—");
  });
});

describe("tokenAmount", () => {
  test("compacts big balances and keeps small ones readable", () => {
    expect(tokenAmount(6_760_000_000_000)).toBe("6.76T");
    expect(tokenAmount(10_908_663)).toBe("10.91M");
    expect(tokenAmount(1093.7434)).toBe("1,093.7434");
    expect(tokenAmount(0)).toBe("0");
    expect(tokenAmount(NaN)).toBe("—");
  });
});

describe("percentages", () => {
  test("pct and signedPct", () => {
    expect(pct(20.851)).toBe("20.85%");
    expect(pct(20.851, 1)).toBe("20.9%");
    expect(signedPct(1.5)).toBe("+1.50%");
    expect(signedPct(-1.5)).toBe("-1.50%");
    expect(signedPct(0)).toBe("+0.00%");
    expect(pct(NaN)).toBe("—");
  });
});

describe("shortAddress", () => {
  test("elides the middle but never a short string", () => {
    expect(shortAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(
      "9WzD…AWWM"
    );
    expect(shortAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", 6)).toBe(
      "9WzDXw…YtAWWM"
    );
    expect(shortAddress("short")).toBe("short");
  });
});

describe("timeAgo", () => {
  test("reads naturally across scales", () => {
    const now = Date.now();
    expect(timeAgo(0)).toBe("never");
    expect(timeAgo(now)).toBe("just now");
    expect(timeAgo(now - 30_000)).toBe("30s ago");
    expect(timeAgo(now - 5 * 60_000)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000)).toBe("3h ago");
    expect(timeAgo(now - 2 * 86_400_000)).toBe("2d ago");
  });

  test("never reports a negative age from clock skew", () => {
    expect(timeAgo(Date.now() + 60_000)).toBe("just now");
  });
});

describe("risk bands", () => {
  test("boundaries match the documented table exactly", () => {
    // README: Calm 0-24, Watch 25-44, Elevated 45-69, Severe 70-100.
    expect(riskBand(0).label).toBe("Calm");
    expect(riskBand(24.99).label).toBe("Calm");
    expect(riskBand(25).label).toBe("Watch");
    expect(riskBand(44.99).label).toBe("Watch");
    expect(riskBand(45).label).toBe("Elevated");
    expect(riskBand(69.99).label).toBe("Elevated");
    expect(riskBand(70).label).toBe("Severe");
    expect(riskBand(100).label).toBe("Severe");
  });

  test("every band carries a colour and an explanation", () => {
    for (const score of [10, 30, 50, 80]) {
      const band = riskBand(score);
      expect(band.color).toMatch(/^var\(--/);
      expect(band.description.length).toBeGreaterThan(10);
    }
  });

  test("the exported threshold list agrees with the function", () => {
    for (const { at, band } of BAND_THRESHOLDS) {
      expect(riskBand(at).key).toBe(band.key);
    }
  });
});

describe("colour mapping", () => {
  test("stress levels map onto the same ramp as risk", () => {
    expect(stressColor("LOW")).toBe("var(--calm)");
    expect(stressColor("MODERATE")).toBe("var(--watch)");
    expect(stressColor("HIGH")).toBe("var(--elevated)");
    expect(stressColor("CRITICAL")).toBe("var(--severe)");
    expect(stressColor("nonsense")).toBe("var(--calm)");
  });

  test("known assets are distinct and unknown ones fall back", () => {
    const known = ["SOL", "BONK", "JUP", "USDC"].map(assetColor);
    expect(new Set(known).size).toBe(4);
    expect(assetColor("WIF")).toBe("var(--asset-other)");
  });
});
