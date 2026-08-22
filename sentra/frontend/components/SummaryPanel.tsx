"use client";

import type { ReactNode } from "react";
import { RiskDial } from "./RiskDial";
import { riskBand } from "@/lib/format";

/**
 * The dial and the headline figures read as one instrument, so they live in
 * one bordered panel separated by hairlines rather than in five floating
 * cards. Fewer borders, one alignment grid, less page furniture.
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
    <section className="card enter">
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

        <dl className="grid flex-1 grid-cols-2 md:grid-cols-4">
          {metrics.map((metric, i) => (
            <div
              key={metric.label}
              className={`px-5 py-4 ${
                i % 2 === 1 ? "" : "border-r border-border"
              } ${i < 2 ? "border-b border-border md:border-b-0" : ""} ${
                i === 3 ? "md:border-r-0" : ""
              } ${i === 1 ? "md:border-r" : ""}`}
            >
              <dt className="label">{metric.label}</dt>
              <dd className="numeric mt-1.5 text-xl font-medium leading-none text-text">
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
