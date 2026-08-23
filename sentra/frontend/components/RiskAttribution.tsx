"use client";

import type { WalletMetrics } from "@/lib/types";
import { usd, assetColor } from "@/lib/format";
import { EmptyState } from "./ui";

/**
 * Weight is not risk.
 *
 * A balance readout says "97% SOL". This says "99% of what you stand to lose".
 * The two diverge whenever an asset's volatility differs from its size, and
 * the gap is the only part actionable by selling something. Component VaRs
 * sum exactly to portfolio VaR (Euler allocation), so the split is an
 * attribution rather than a heuristic.
 */
export function RiskAttribution({ metrics }: { metrics: WalletMetrics }) {
  const contributions = metrics.model.contributions ?? [];

  if (contributions.length === 0) {
    return (
      <EmptyState
        title="No attribution yet"
        body="Risk is split across assets once the engine has return data for the book."
        compact
      />
    );
  }

  const dr = metrics.model.diversificationRatio;
  const top = contributions[0];
  // Anything under ~1.1 means the assets are moving as one and the spread
  // across tickers is buying almost nothing.
  const diversified = dr >= 1.15;

  return (
    <div className="px-4 py-3.5">
      <div className="space-y-3">
        {contributions.map((c) => {
          const color = assetColor(c.symbol);
          const overweight = c.riskShare - c.weight;

          return (
            <div key={c.symbol}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] text-text">
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: color }}
                  />
                  {c.symbol}
                </span>
                <span className="numeric text-[13px] font-medium text-text">
                  {(c.riskShare * 100).toFixed(1)}%
                  <span className="ml-1.5 text-[11px] font-normal text-tertiary">
                    of risk
                  </span>
                </span>
              </div>

              {/* Two bars on one baseline: value above, risk below. Where they
                  disagree is the whole point of the panel. */}
              <div className="mt-1.5 space-y-1">
                <Bar
                  label="value"
                  fraction={c.weight}
                  color="var(--border-strong)"
                />
                <Bar label="risk" fraction={c.riskShare} color={color} />
              </div>

              <p className="mt-1 text-[10px] leading-snug text-tertiary">
                {(c.weight * 100).toFixed(1)}% of value ·{" "}
                {usd(c.componentVarUsd)} of the VaR
                {Math.abs(overweight) > 0.03 && (
                  <>
                    {" · "}
                    <span
                      style={{
                        color:
                          overweight > 0 ? "var(--elevated)" : "var(--calm)",
                      }}
                    >
                      {overweight > 0 ? "carries" : "carries"}{" "}
                      {Math.abs(overweight * 100).toFixed(0)}pp{" "}
                      {overweight > 0 ? "more" : "less"} risk than weight
                    </span>
                  </>
                )}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 space-y-1.5 border-t border-border pt-3">
        <div className="flex items-baseline justify-between">
          <span className="label">Diversification</span>
          <span
            className="numeric text-[13px] font-medium"
            style={{ color: diversified ? "var(--calm)" : "var(--watch)" }}
          >
            {dr.toFixed(2)}×
          </span>
        </div>
        <p className="text-[11px] leading-snug text-tertiary">
          {diversified
            ? `Holdings move independently enough to cut volatility by ${(
                (1 - 1 / dr) *
                100
              ).toFixed(0)}% versus holding them in isolation.`
            : `Holdings move almost as one — spreading across ${contributions.length} tickers is buying little. ${top.symbol} drives ${(
                top.riskShare * 100
              ).toFixed(0)}% of the risk.`}
        </p>
      </div>
    </div>
  );
}

function Bar({
  label,
  fraction,
  color,
}: {
  label: string;
  fraction: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[9px] uppercase tracking-wide text-tertiary">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.max(fraction * 100, 0.5)}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}
