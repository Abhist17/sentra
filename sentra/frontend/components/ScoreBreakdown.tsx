"use client";

import type { WalletMetrics } from "@/lib/types";
import { pct, usd } from "@/lib/format";
import { Notice } from "./ui";

const FACTORS = [
  {
    key: "var" as const,
    label: "Value at Risk",
    note: "95% one-day loss from the 30-day covariance matrix",
  },
  {
    key: "concentration" as const,
    label: "Concentration",
    note: "Applied when one asset exceeds 30% or 50% of the book",
  },
  {
    key: "stress" as const,
    label: "Market stress",
    note: "Systemic signals scaled into the score",
  },
  {
    key: "trend" as const,
    label: "Trend",
    note: "Applied when the heaviest holding is falling",
  },
];

export function ScoreBreakdown({ metrics }: { metrics: WalletMetrics }) {
  const total = FACTORS.reduce((sum, f) => sum + metrics.breakdown[f.key], 0);

  return (
    <div className="px-4 py-3.5">
      {/* Contribution bar — how the final score was assembled */}
      <div className="mb-4 flex h-1.5 overflow-hidden rounded-full bg-surface-hover">
        {FACTORS.map((factor, i) => {
          const value = metrics.breakdown[factor.key];
          if (value <= 0 || total <= 0) return null;
          return (
            <div
              key={factor.key}
              style={{
                width: `${(value / total) * 100}%`,
                backgroundColor: "var(--text-secondary)",
                opacity: 1 - i * 0.2,
              }}
            />
          );
        })}
      </div>

      <dl className="space-y-3">
        {FACTORS.map((factor, i) => {
          const value = metrics.breakdown[factor.key];
          const inactive = value <= 0;

          return (
            <div key={factor.key}>
              <div className="flex items-baseline justify-between gap-3">
                <dt
                  className={`text-[13px] ${
                    inactive ? "text-tertiary" : "text-text"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{
                        backgroundColor: inactive
                          ? "var(--border-strong)"
                          : "var(--text-secondary)",
                        opacity: inactive ? 1 : 1 - i * 0.2,
                      }}
                    />
                    {factor.label}
                  </span>
                </dt>
                <dd
                  className={`numeric shrink-0 text-[13px] font-medium ${
                    inactive ? "text-tertiary" : "text-text"
                  }`}
                >
                  {inactive ? "—" : `+${value.toFixed(1)}`}
                </dd>
              </div>
              <p className="mt-0.5 pl-4 text-[11px] leading-snug text-tertiary">
                {factor.note}
              </p>
            </div>
          );
        })}
      </dl>

      <div className="mt-4 space-y-1.5 border-t border-border pt-3">
        <div className="flex items-baseline justify-between">
          <span className="label">Blended score</span>
          <span className="numeric text-[13px] font-medium text-text">
            {pct(metrics.risk)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-tertiary">Modelled 1-day loss</span>
          <span className="numeric text-xs text-secondary">
            {usd(metrics.varUsd)}
          </span>
        </div>
      </div>

      {metrics.coverage < 0.999 && (
        <div className="mt-3">
          <Notice tone="warn">
            Only {(metrics.coverage * 100).toFixed(1)}% of portfolio value has a
            return series behind it, so the VaR component understates this book.
          </Notice>
        </div>
      )}
    </div>
  );
}
