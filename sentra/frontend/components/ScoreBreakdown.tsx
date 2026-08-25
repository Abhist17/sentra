"use client";

import type { WalletMetrics } from "@/lib/types";
import { pct, usd } from "@/lib/format";
import { Notice } from "./ui";

/**
 * Below roughly this many non-overlapping horizon observations the empirical
 * tail rests on one or two data points and should not be read as an estimate.
 */
const THIN_SAMPLE = 60;

/**
 * Tone per factor, strongest first.
 *
 * These were one colour at four opacity steps, which over a dark surface
 * compressed into four greys nobody could tell apart — so the composition bar
 * had segments that could not be matched to the rows they belonged to, which
 * is the only job a legend has. Mixing toward the hairline colour instead
 * spreads the ramp across the full range the theme actually has, and it
 * inverts correctly in the light theme without a second table.
 */
function tone(index: number): string {
  return `color-mix(in srgb, var(--text) ${100 - index * 22}%, var(--border-strong))`;
}

const FACTORS = [
  {
    key: "var" as const,
    label: "Value at Risk",
    // Filled in from the model metadata — hardcoding "95% one-day" here meant
    // the caption stayed wrong whenever the horizon or confidence changed.
    note: null,
  },
  {
    key: "concentration" as const,
    label: "Concentration",
    note:
      "Rises with the largest position, and with how few assets the book " +
      "effectively holds",
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
  const model = metrics.model;

  return (
    <div className="px-4 py-3.5">
      {/* Contribution bar — how the final score was assembled. The 2px gaps
          matter: without them adjacent segments of similar tone read as one
          wider segment and the count comes out wrong. */}
      <div className="mb-4 flex h-2 gap-[2px] overflow-hidden rounded-full bg-surface-hover">
        {FACTORS.map((factor, i) => {
          const value = metrics.breakdown[factor.key];
          if (value <= 0 || total <= 0) return null;
          return (
            <div
              key={factor.key}
              className="first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${(value / total) * 100}%`,
                backgroundColor: tone(i),
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
                          : tone(i),
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
                  {inactive ? (
                    "—"
                  ) : (
                    <>
                      +{value.toFixed(1)}
                      <span className="ml-1.5 text-[11px] font-normal text-tertiary">
                        {((value / total) * 100).toFixed(0)}%
                      </span>
                    </>
                  )}
                </dd>
              </div>
              <p className="mt-0.5 pl-4 text-[11px] leading-snug text-tertiary">
                {factor.note ??
                  `${(model.confidence * 100).toFixed(0)}% ${
                    model.horizonDays
                  }-day loss, ${model.headline} model`}
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
      </div>

      <ModelDetail metrics={metrics} />

      {model.independentObservations > 0 &&
        model.independentObservations < THIN_SAMPLE && (
          <div className="mt-3">
            <Notice tone="info">
              The historical tail rests on {model.independentObservations}{" "}
              independent {model.horizonDays}-day observations — too few to be
              read as a precise estimate.
            </Notice>
          </div>
        )}

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

/**
 * Shows the loss estimate under both models rather than a single number.
 * They can disagree by multiples — the parametric one reacts to the current
 * volatility regime, the historical one carries the realised tail — and
 * hiding that disagreement would overstate how precise any of this is.
 */
function ModelDetail({ metrics }: { metrics: WalletMetrics }) {
  const { model, varUsd, esUsd } = metrics;
  const horizon = `${model.horizonDays}d`;
  const conf = `${(model.confidence * 100).toFixed(0)}%`;

  const rows = [
    {
      name: "Parametric",
      note: "EWMA covariance, normal tail",
      ...model.parametric,
      active: model.headline === "parametric",
    },
    {
      name: "Historical",
      note: `${model.independentObservations} independent windows`,
      ...model.historical,
      active: model.headline === "historical",
    },
  ];

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-baseline justify-between">
        <span className="label">Loss estimate</span>
        <span className="numeric text-[10px] text-tertiary">
          {horizon} · {conf}
        </span>
      </div>

      <table className="mt-2 w-full text-[11px]">
        <thead>
          <tr className="text-tertiary">
            <th className="pb-1 text-left font-medium">Model</th>
            <th className="pb-1 text-right font-medium">VaR</th>
            <th className="pb-1 text-right font-medium">ES</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              className={row.active ? "text-text" : "text-tertiary"}
            >
              <td className="py-0.5">
                <span className="flex items-center gap-1.5">
                  {row.active && (
                    <span
                      className="h-1 w-1 rounded-full bg-text"
                      aria-label="used for the headline figure"
                    />
                  )}
                  <span className={row.active ? "font-medium" : "pl-2.5"}>
                    {row.name}
                  </span>
                </span>
              </td>
              <td className="numeric py-0.5 text-right">
                {row.varUsd > 0 ? usd(row.varUsd) : "—"}
              </td>
              <td className="numeric py-0.5 text-right">
                {row.esUsd > 0 ? usd(row.esUsd) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-[10px] leading-snug text-tertiary">
        Headline takes the more conservative of the two: {usd(varUsd)} VaR,{" "}
        {usd(esUsd)} expected shortfall. Sampled {model.periodsPerDay.toFixed(0)}×
        daily.
      </p>
    </div>
  );
}
