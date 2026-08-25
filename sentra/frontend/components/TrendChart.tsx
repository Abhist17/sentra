"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RiskPoint } from "@/lib/types";
import { riskBand, pct, usd, clockTime } from "@/lib/format";
import { EmptyState } from "./ui";

const H = 210;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

/** Used for the first paint and for static export, before a real box exists. */
const FALLBACK_W = 800;

/** A gap this many times the usual cadence counts as missing data. */
const GAP_FACTOR = 3;

/**
 * Reports the element's own pixel width so the chart can draw in real pixels.
 *
 * The alternative — a fixed viewBox stretched with preserveAspectRatio="none"
 * — scales x and y by different factors, which distorts everything that is
 * not a plain line: the axis labels rendered squashed or stretched depending
 * on the container, and the hover marker drew as an ellipse.
 */
function useMeasuredWidth(fallback: number) {
  const [width, setWidth] = useState(fallback);
  const nodeRef = useRef<SVGSVGElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    const next = Math.round(el.getBoundingClientRect().width);
    if (next > 0) setWidth((current) => (current === next ? current : next));
  }, []);

  /**
   * A callback ref rather than an effect: the chart renders an empty state
   * until it has two points, so the element this measures does not exist on
   * mount. An effect would run once against a null ref and never re-attach,
   * leaving the chart drawing at the fallback width for the rest of the
   * session once real data arrived.
   */
  const ref = useCallback(
    (node: SVGSVGElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = node;
      if (!node) return;

      measure();
      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver(measure);
      observer.observe(node);
      observerRef.current = observer;
    },
    [measure]
  );

  // Only a backstop for browsers without ResizeObserver; elsewhere the
  // observer already covers every resize, container ones included.
  useEffect(() => {
    if (typeof ResizeObserver !== "undefined") return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return [ref, width, nodeRef] as const;
}

export function TrendChart({
  points,
  threshold,
}: {
  points: RiskPoint[];
  threshold: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // The element being measured is the one being drawn into, so the viewBox
  // and the pixel box can never disagree.
  const [svgRef, W, svgNode] = useMeasuredWidth(FALLBACK_W);
  // Touch scrubs only while a finger is down. Tracking on every touch move
  // would fight the page scroll for the width of the chart.
  const dragging = useRef(false);

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

    // Position by TIME, not by index. Now that history survives restarts, the
    // series can contain real gaps — a redeploy, a rate-limited tick, an
    // engine that was simply off. Spacing points evenly draws a three-hour
    // outage exactly like a thirty-second interval, which is the chart
    // quietly asserting something it does not know.
    const t0 = points[0].t;
    const elapsed = Math.max(1, points[points.length - 1].t - t0);

    const x = (i: number) => PAD.left + ((points[i].t - t0) / elapsed) * innerW;
    const y = (v: number) =>
      PAD.top + innerH - ((v - min) / range) * innerH;

    // A gap far wider than the usual cadence is missing data, so the line
    // breaks there instead of interpolating across it. Median rather than
    // mean: one long outage would drag an average enough to hide the rest.
    const gaps: number[] = [];
    for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
    const ordered = [...gaps].sort((a, b) => a - b);
    const medianGap = ordered[Math.floor(ordered.length / 2)] ?? 0;
    const breakAfter = medianGap > 0 ? medianGap * GAP_FACTOR : Infinity;

    const runs: number[][] = [];
    let run: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i > 0 && points[i].t - points[i - 1].t > breakAfter) {
        runs.push(run);
        run = [];
      }
      run.push(i);
    }
    runs.push(run);

    const trace = (indices: number[]) =>
      indices
        .map(
          (i, k) =>
            `${k ? "L" : "M"} ${x(i).toFixed(2)} ${y(points[i].risk).toFixed(2)}`
        )
        .join(" ");

    const baseline = PAD.top + innerH;

    const line = runs
      .map((indices) => {
        const path = trace(indices);
        // A run of one would draw nothing. Repeating the point gives a
        // zero-length segment, which the round linecap renders as a dot — so
        // an isolated reading between two outages is still visible.
        return indices.length === 1
          ? `${path} L ${x(indices[0]).toFixed(2)} ${y(points[indices[0]].risk).toFixed(2)}`
          : path;
      })
      .join(" ");

    const area = runs
      .filter((indices) => indices.length > 1)
      .map(
        (indices) =>
          `${trace(indices)} L ${x(indices[indices.length - 1]).toFixed(2)} ` +
          `${baseline.toFixed(2)} L ${x(indices[0]).toFixed(2)} ` +
          `${baseline.toFixed(2)} Z`
      )
      .join(" ");

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
  }, [points, threshold, W]);

  if (!model) {
    return (
      <EmptyState
        title="Not enough history yet"
        body="The trend appears once the engine has completed a few consecutive ticks."
      />
    );
  }

  // `locate` is a hoisted declaration, so it cannot see the null check above.
  const chart = model;

  const index = hover ?? points.length - 1;
  const active = points[index];
  const band = riskBand(active.risk);

  const first = points[0].risk;
  const last = points[points.length - 1].risk;
  const delta = last - first;

  function locate(clientX: number) {
    const rect = svgNode.current?.getBoundingClientRect();
    if (!rect) return;

    // The viewBox is the element's own pixel box, so a client offset is
    // already a chart coordinate. Points are no longer evenly spaced, so
    // pick the nearest one rather than computing an index from the offset.
    const target = clientX - rect.left;
    let nearest = 0;
    let best = Infinity;

    for (let i = 0; i < points.length; i++) {
      const distance = Math.abs(chart.x(i) - target);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }

    setHover(nearest);
  }

  /** Keyboard scrubbing. Up/down stay unbound — the page uses them to move
   *  between wallets, and stealing them here would trap that navigation. */
  function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    const lastIndex = points.length - 1;
    const current = hover ?? lastIndex;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        setHover(Math.max(0, current - 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        setHover(Math.min(lastIndex, current + 1));
        break;
      case "Home":
        e.preventDefault();
        setHover(0);
        break;
      case "End":
        e.preventDefault();
        setHover(lastIndex);
        break;
      case "Escape":
        setHover(null);
        break;
    }
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

      {/* Only announces while scrubbing. Left always-on it would read out
          every poll, which is noise rather than information. */}
      <span role="status" aria-live="polite" className="sr-only">
        {hover !== null
          ? `${active.risk.toFixed(1)} at ${clockTime(active.t)}, portfolio ${usd(
              active.portfolio
            )}`
          : ""}
      </span>

      {/* touch-pan-y rather than touch-none: a vertical swipe still scrolls
          the page while a horizontal drag scrubs. `touch-none` swallowed
          both, so on a phone the chart was an unscrollable dead zone that
          offered nothing in exchange. */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full touch-pan-y focus-visible:outline-2"
        style={{ height: H }}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse") {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          locate(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse" || dragging.current) locate(e.clientX);
        }}
        onPointerUp={() => {
          // The reading stays put after a touch — lifting a finger to read
          // the number should not erase it.
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setHover(null);
        }}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="img"
        aria-label={
          `Risk trend, ${points.length} points. ` +
          `${hover !== null ? "Inspecting" : "Latest"}: ` +
          `${active.risk.toFixed(1)} at ${clockTime(active.t)}, ` +
          `portfolio ${usd(active.portfolio)}. ` +
          `Left and right arrows step through the series.`
        }
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

      {/* Three labels rather than two: the axis is proportional to time now,
          so a midpoint is a real reading instead of decoration. */}
      <div className="mt-1 flex justify-between px-3">
        <span className="numeric text-[10px] text-tertiary">
          {clockTime(points[0].t)}
        </span>
        <span className="numeric text-[10px] text-tertiary">
          {clockTime((points[0].t + points[points.length - 1].t) / 2)}
        </span>
        <span className="numeric text-[10px] text-tertiary">
          {clockTime(points[points.length - 1].t)}
        </span>
      </div>
    </div>
  );
}
