"use client";

import type { AssetSymbol, StressLevel } from "@/lib/types";
import { price, signedPct, assetColor, stressColor } from "@/lib/format";
import { Notice } from "./ui";

export function PriceList({
  prices,
  changes,
  volatility,
  stale,
}: {
  prices: Record<AssetSymbol, number> | null;
  changes: Partial<Record<AssetSymbol, number>>;
  volatility: Record<string, number>;
  stale: boolean;
}) {
  if (!prices) {
    return (
      <p className="px-4 py-4 text-xs text-tertiary">
        Waiting for the first price tick…
      </p>
    );
  }

  const symbols = Object.keys(prices) as AssetSymbol[];

  return (
    <div>
      <ul className="px-1 py-1" role="list">
        {symbols.map((symbol) => {
          const change = changes[symbol];
          const vol = volatility[symbol] ?? 0;
          const flat = change === undefined || Math.abs(change) < 0.005;

          return (
            <li
              key={symbol}
              className="flex items-center gap-2 rounded-md px-3 py-1.5"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: assetColor(symbol) }}
              />
              <span className="text-[13px] font-medium text-text">{symbol}</span>

              {vol > 0.03 && (
                <span
                  className="text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--watch)" }}
                  title={`Live volatility ${(vol * 100).toFixed(2)}% per tick`}
                >
                  vol
                </span>
              )}

              <span className="numeric ml-auto text-[13px] text-text">
                {price(prices[symbol])}
              </span>

              <span
                className="numeric w-14 shrink-0 text-right text-[11px]"
                style={{
                  color: flat
                    ? "var(--text-tertiary)"
                    : change! > 0
                      ? "var(--calm)"
                      : "var(--severe)",
                }}
              >
                {change === undefined ? "—" : signedPct(change)}
              </span>
            </li>
          );
        })}
      </ul>

      {stale && (
        <div className="px-3 pb-3">
          <Notice tone="warn">
            Price feed unreachable — showing last known quotes.
          </Notice>
        </div>
      )}
    </div>
  );
}

const SEGMENTS = 24;

export function StressPanel({
  score,
  level,
  signals,
}: {
  score: number;
  level: StressLevel;
  signals: string[];
}) {
  const color = stressColor(level);
  const lit = Math.round((score / 100) * SEGMENTS);

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-baseline justify-between">
        <span className="numeric text-2xl font-medium" style={{ color }}>
          {score}
          <span className="ml-0.5 text-sm text-tertiary">/100</span>
        </span>
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color }}
        >
          {level.toLowerCase()}
        </span>
      </div>

      <div className="mt-3 flex gap-[2px]" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <div
            key={i}
            className="h-3 flex-1 rounded-[1px] transition-colors duration-300"
            style={{
              backgroundColor: i < lit ? color : "var(--surface-hover)",
            }}
          />
        ))}
      </div>

      <div className="mt-3.5 space-y-1.5">
        {signals.length === 0 ? (
          <p className="text-xs leading-relaxed text-tertiary">
            No systemic signals firing. Volatility, correlated drawdowns and
            rapid drops are all within normal range.
          </p>
        ) : (
          signals.map((signal, i) => (
            <p
              key={i}
              className="rounded-md px-2.5 py-1.5 text-xs leading-snug"
              style={{
                color: "var(--text-secondary)",
                backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
              }}
            >
              {signal}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
