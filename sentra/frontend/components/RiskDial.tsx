"use client";

import { useCountUp } from "@/lib/hooks";
import { riskBand, BAND_THRESHOLDS } from "@/lib/format";

/**
 * A 240° dial. Deliberately thin and single-coloured: the arc shows position
 * on a bounded scale, the colour shows which band that position falls in.
 * Band boundaries are drawn as small ticks so the reading is interpretable
 * without a legend.
 */
const SWEEP = 240;
const START = 90 + (360 - SWEEP) / 2;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${
    Math.abs(to - from) > 180 ? 1 : 0
  } 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function RiskDial({
  score,
  size = 176,
  showLabel = true,
}: {
  score: number;
  size?: number;
  /** Hide when the band name is already shown alongside the dial. */
  showLabel?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const value = useCountUp(clamped, 600);
  const band = riskBand(clamped);

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;
  const track = arc(cx, cy, r, START, START + SWEEP);
  const length = (SWEEP / 360) * 2 * Math.PI * r;

  return (
    <div
      className="relative inline-flex flex-col items-center"
      role="img"
      aria-label={`Risk score ${clamped.toFixed(1)} of 100 — ${band.label}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path
          d={track}
          fill="none"
          stroke="var(--border)"
          strokeWidth={5}
          strokeLinecap="round"
        />

        {/* Band boundary ticks — 25 / 45 / 70 */}
        {BAND_THRESHOLDS.filter((t) => t.at > 0).map(({ at }) => {
          const angle = START + (at / 100) * SWEEP;
          const inner = polar(cx, cy, r - 6, angle);
          const outer = polar(cx, cy, r + 6, angle);
          return (
            <line
              key={at}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--border-strong)"
              strokeWidth={1}
            />
          );
        })}

        <path
          d={track}
          fill="none"
          stroke={band.color}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${length} ${length}`}
          strokeDashoffset={length - (value / 100) * length}
          style={{ transition: "stroke 300ms ease" }}
        />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {/* Typography scales with the dial so the reading never crowds the
            arc at smaller sizes. */}
        <span
          className="numeric font-medium leading-none tracking-tight text-text"
          style={{ fontSize: Math.round(size * 0.235) }}
        >
          {value.toFixed(1)}
        </span>
        {showLabel && (
          <span
            className="mt-1.5 font-semibold uppercase tracking-[0.08em]"
            style={{ color: band.color, fontSize: Math.max(9, size * 0.062) }}
          >
            {band.label}
          </span>
        )}
      </div>
    </div>
  );
}
