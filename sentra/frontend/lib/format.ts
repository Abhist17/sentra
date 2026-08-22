/** Compact USD for headline figures: $1.05B, $12.4M, $8,240. */
export function usd(value: number, opts?: { compact?: boolean }): string {
  if (!Number.isFinite(value)) return "—";

  const compact = opts?.compact ?? Math.abs(value) >= 1_000_000;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : value < 1000 ? 2 : 0,
  }).format(value);
}

/** Prices here span eight orders of magnitude (BONK ~$0.000003, SOL ~$200). */
export function price(value: number): string {
  if (!Number.isFinite(value)) return "—";

  if (value === 0) return "$0.00";
  if (value < 0.001) {
    return `$${value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function tokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value >= 1_000_000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function pct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function signedPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function shortAddress(address: string, size = 4): string {
  if (address.length <= size * 2 + 1) return address;
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}

export function timeAgo(timestamp: number): string {
  if (!timestamp) return "never";

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Risk ramp ────────────────────────────────────────────────────
// One source of truth for every band label and colour in the app. Each entry
// resolves to a CSS custom property so the ramp re-themes with the page.

export type BandKey = "calm" | "watch" | "elevated" | "severe";

export interface RiskBand {
  key: BandKey;
  label: string;
  /** CSS colour reference, valid in both themes. */
  color: string;
  description: string;
}

const BANDS: Record<BandKey, RiskBand> = {
  calm: {
    key: "calm",
    label: "Calm",
    color: "var(--calm)",
    description: "Loss potential within normal range",
  },
  watch: {
    key: "watch",
    label: "Watch",
    color: "var(--watch)",
    description: "Above baseline — worth checking",
  },
  elevated: {
    key: "elevated",
    label: "Elevated",
    color: "var(--elevated)",
    description: "Meaningful downside concentration",
  },
  severe: {
    key: "severe",
    label: "Severe",
    color: "var(--severe)",
    description: "Large modelled loss at 95% confidence",
  },
};

export function riskBand(score: number): RiskBand {
  if (score >= 70) return BANDS.severe;
  if (score >= 45) return BANDS.elevated;
  if (score >= 25) return BANDS.watch;
  return BANDS.calm;
}

export const BAND_THRESHOLDS: { at: number; band: RiskBand }[] = [
  { at: 0, band: BANDS.calm },
  { at: 25, band: BANDS.watch },
  { at: 45, band: BANDS.elevated },
  { at: 70, band: BANDS.severe },
];

/** Stress level shares the risk ramp so the two read on the same scale. */
export function stressColor(level: string): string {
  switch (level) {
    case "CRITICAL":
      return "var(--severe)";
    case "HIGH":
      return "var(--elevated)";
    case "MODERATE":
      return "var(--watch)";
    default:
      return "var(--calm)";
  }
}

// ── Allocation ───────────────────────────────────────────────────
const ASSET_SLOTS: Record<string, string> = {
  SOL: "var(--asset-1)",
  BONK: "var(--asset-2)",
  JUP: "var(--asset-3)",
  USDC: "var(--asset-4)",
};

export function assetColor(symbol: string): string {
  return ASSET_SLOTS[symbol] ?? "var(--asset-other)";
}
