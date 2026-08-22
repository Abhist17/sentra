"use client";

import { useMemo, useRef, useState } from "react";
import type { RiskPoint } from "@/lib/types";
import { riskBand, pct, usd, clockTime } from "@/lib/format";
import { EmptyState } from "./ui";

const W = 800;
const H = 210;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

export function TrendChart({
  points,
  threshold,
}: {
  points: RiskPoint[];
  threshold: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const model = useMemo(() => {
    if (points.length < 2) return null;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    const risks = points.map((p) => p.risk);
    // Frame at least a 12-point band, otherwise a near-flat series renders as
    // a dramatic squiggle and reads as volatility that is not there.
    const lo = Math.min(...risks, threshold);
    const hi = Math.max(...risks, threshold);
    const mid = (lo + hi) / 2;
    const span = Math.max(hi - lo, 12);
    const min = Math.max(0, mid - span * 0.62);
    const max = Math.min(100, mid + span * 0.62);
    const range = max - min || 1;

    const x = (i: number) => PAD.left + (i / (points.length - 1)) * innerW;
    const y = (v: number) =>
      PAD.top + innerH - ((v - min) / range) * innerH;

    const line = points
      .map((p, i) => `${i ? "L" : "M"} ${x(i).toFixed(2)} ${y(p.risk).toFixed(2)}`)
      .join(" ");

    const area = `${line} L ${x(points.length - 1).toFixed(2)} ${(
      PAD.top + innerH
    ).toFixed(2)} L ${x(0).toFixed(2)} ${(PAD.top + innerH).toFixed(2)} Z`;

    const ticks = [0, 0.5, 1].map((f) => ({
      y: PAD.top + f * innerH,
      value: max - f * range,
    }));

    return {
      x,
      y,
      line,
      area,
      ticks,
      innerH,
      thresholdY: y(Math.max(min, Math.min(max, threshold))),
      thresholdVisible: threshold >= min && threshold <= max,
    };
  }, [points, threshold]);

  if (!model) {
    return (
      <EmptyState
        title="Not enough history yet"
        body="The trend appears once the engine has completed a few consecutive ticks."
      />
    );
  }

  const index = hover ?? points.length - 1;
  const active = points[index];
  const band = riskBand(active.risk);

  const first = points[0].risk;
  const last = points[points.length - 1].risk;
  const delta = last - first;

  function locate(clientX: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (clientX - rect.left) / rect.width;
    const innerW = W - PAD.left - PAD.right;
    const i = Math.round(((ratio * W - PAD.left) / innerW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  return (
    <div className="px-1 pb-3 pt-3">
      <div className="mb-2 flex items-baseline justify-between gap-4 px-3">
        <div className="flex items-baseline gap-2.5">
          <span
            className="numeric text-xl font-medium"
            style={{ color: band.color }}
          >
            {pct(active.risk)}
          </span>
          <span className="numeric text-xs text-tertiary">
            {usd(active.portfolio)}
          </span>
        </div>
        <span className="numeric text-xs text-tertiary">
          {hover !== null ? (
            new Date(active.t).toLocaleTimeString()
          ) : (
            <>
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(2)} over {points.length} ticks
            </>
          )}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        style={{ height: H }}
        preserveAspectRatio="none"
        onMouseMove={(e) => locate(e.clientX)}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Risk trend across ${points.length} points`}
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={band.color} stopOpacity="0.16" />
            <stop offset="100%" stopColor={band.color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {model.ticks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={tick.y}
              x2={W - PAD.right}
              y2={tick.y}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={tick.y + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-tertiary)"
              className="numeric"
            >
              {tick.value.toFixed(0)}
            </text>
          </g>
        ))}

        {model.thresholdVisible && (
          <>
            <line
              x1={PAD.left}
              y1={model.thresholdY}
              x2={W - PAD.right}
              y2={model.thresholdY}
              stroke="var(--severe)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.5}
            />
            <text
              x={W - PAD.right}
              y={model.thresholdY - 5}
              textAnchor="end"
              fontSize="9"
              fill="var(--severe)"
              opacity={0.75}
              className="numeric"
            >
              alert {threshold}
            </text>
          </>
        )}

        <path d={model.area} fill="url(#trend-fill)" />
        <path
          d={model.line}
          fill="none"
          stroke={band.color}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover !== null && (
          <line
            x1={model.x(hover)}
            y1={PAD.top}
            x2={model.x(hover)}
            y2={PAD.top + model.innerH}
            stroke="var(--text-tertiary)"
            strokeWidth={1}
          />
        )}

        <circle
          cx={model.x(index)}
          cy={model.y(active.risk)}
          r={3}
          fill={band.color}
          stroke="var(--surface)"
          strokeWidth={2}
        />
      </svg>

      <div className="mt-1 flex justify-between px-3">
        <span className="numeric text-[10px] text-tertiary">
          {clockTime(points[0].t)}
        </span>
        <span className="numeric text-[10px] text-tertiary">
          {clockTime(points[points.length - 1].t)}
        </span>
      </div>
    </div>
  );
}
