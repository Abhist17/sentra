"use client";

import { useMemo } from "react";
import type { RiskPoint } from "@/lib/types";

/**
 * Thumbnail of a wallet's risk trend. A list of current scores says which
 * wallet is worst right now; the shape says which one is getting worse, which
 * is usually the more useful signal.
 */
export function Sparkline({
  points,
  color,
  width = 52,
  height = 16,
}: {
  points: RiskPoint[];
  color: string;
  width?: number;
  height?: number;
}) {
  const path = useMemo(() => {
    if (points.length < 2) return null;

    // Only the tail matters at this size, and fewer points draw cleaner.
    const tail = points.slice(-40);
    const values = tail.map((p) => p.risk);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series should render as a flat line, not amplified noise.
    const range = Math.max(max - min, 4);
    const mid = (min + max) / 2;
    const lo = mid - range / 2;

    const x = (i: number) => (i / (tail.length - 1)) * width;
    const y = (v: number) =>
      height - 1 - ((v - lo) / range) * (height - 2);

    return tail
      .map((p, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(p.risk).toFixed(1)}`)
      .join(" ");
  }, [points, width, height]);

  if (!path) {
    return <span style={{ width, height }} className="inline-block" />;
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
