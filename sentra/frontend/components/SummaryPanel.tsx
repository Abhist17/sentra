"use client";

import type { ReactNode } from "react";
import { RiskDial } from "./RiskDial";
import { riskBand } from "@/lib/format";

/**
 * The dial and the headline figures read as one instrument, so they live in
 * one bordered panel separated by hairlines rather than in five floating
 * cards. Fewer borders, one alignment grid, less page furniture.
 *
 * Layout note: the figures only go four-across once there is genuinely room
 * for them. Beside the dial on a 1280px screen four columns leave ~46px of
 * content each, which is narrower than "$763,669" renders — the values used
 * to spill over their dividers and the last label clipped off the panel.
 * Two-up until `xl` costs nothing and never truncates a number.
 */
export function SummaryPanel({
  score,
  metrics,
}: {
  score: number;
  metrics: { label: string; value: ReactNode; detail?: ReactNode }[];
}) {
  const band = riskBand(score);

  return (
    <section className="card enter overflow-hidden">
      <div className="flex flex-col lg:flex-row">
        <div className="flex shrink-0 items-center gap-5 border-b border-border px-6 py-5 lg:border-b-0 lg:border-r">
          <RiskDial score={score} size={124} showLabel={false} />
          <div className="min-w-0">
            <p className="label">Blended risk</p>
            <p
              className="mt-1 text-[13px] font-semibold"
              style={{ color: band.color }}
            >
              {band.label}
            </p>
            <p className="mt-1 max-w-[20ch] text-[11px] leading-snug text-tertiary">
              {band.description}
            </p>
          </div>
        </div>

        {/* Hairlines come from a 1px gap over a border-coloured backdrop, so
            they stay correct at every column count instead of needing a
            different border rule per breakpoint. */}
        <dl className="grid flex-1 grid-cols-2 gap-px bg-border xl:grid-cols-4">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="min-w-0 bg-surface px-5 py-4"
            >
              <dt className="label">{metric.label}</dt>
              <dd className="numeric mt-1.5 truncate text-lg font-medium leading-none text-text xl:text-xl">
                {metric.value}
              </dd>
              {metric.detail && (
                <p className="mt-1.5 text-[11px] leading-snug text-tertiary">
                  {metric.detail}
                </p>
              )}
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
