"use client";

import { useEffect, useState } from "react";
import type { WalletMetrics, WhatIfResult } from "@/lib/types";
import { getWhatIf, ApiError } from "@/lib/api";
import { usd, riskBand } from "@/lib/format";
import { Button } from "./ui";

/** Shares of a position the reader can move in one click. */
const FRACTIONS = [
  { value: 0.25, label: "¼" },
  { value: 0.5, label: "½" },
  { value: 1, label: "all" },
];

/**
 * "What if I sold some of this?"
 *
 * The attribution panel says where the risk is; this is the step after —
 * what moving some of it into a stablecoin would do to the number. The
 * engine re-scores the actual book with the actual series, so the answer
 * is the score the dashboard would show next tick, not an approximation.
 * Value is preserved in the move: selling de-risks a book, it does not
 * shrink it.
 */
export function WhatIf({
  wallet,
  metrics,
  demo = false,
}: {
  wallet: string;
  metrics: WalletMetrics;
  demo?: boolean;
}) {
  // Anything the reader could plausibly sell down: held, priced, and not
  // already a stablecoin — moving USDC into USDC answers nothing.
  const candidates = metrics.holdings
    .filter((h) => h.value > 0 && h.symbol !== "USDC" && h.symbol !== "USDT")
    .sort((a, b) => b.value - a.value)
    .map((h) => h.symbol);

  const [from, setFrom] = useState<string>(candidates[0] ?? "");
  const [fraction, setFraction] = useState<number | null>(null);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A new wallet, or a book that no longer holds the chosen asset, resets
  // the question rather than answering a stale one.
  useEffect(() => {
    setFrom(candidates[0] ?? "");
    setFraction(null);
    setResult(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  useEffect(() => {
    if (!candidates.includes(from)) setFrom(candidates[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.join("|")]);

  useEffect(() => {
    if (demo || !from || fraction === null) return;
    let cancelled = false;
    setBusy(true);
    setError(null);

    getWhatIf(wallet, from, fraction)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (cancelled) return;
        setResult(null);
        setError(err instanceof ApiError ? err.message : "Could not evaluate");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [wallet, from, fraction, demo]);

  if (candidates.length === 0) return null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="label">What if</span>
        <span className="text-[12px] text-tertiary">you sold</span>
        <span className="flex gap-1">
          {FRACTIONS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={fraction === f.value ? "primary" : "secondary"}
              onClick={() => setFraction(f.value)}
              disabled={demo}
              className="!h-6 !px-2 !text-[11px]"
              aria-pressed={fraction === f.value}
            >
              {f.label}
            </Button>
          ))}
        </span>
        <span className="text-[12px] text-tertiary">of</span>
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          disabled={demo}
          aria-label="Asset to sell"
          className="numeric h-6 rounded-md border border-border bg-bg-subtle px-1.5 text-[11px] text-text focus:border-focus focus:outline-none disabled:opacity-45"
        >
          {candidates.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-tertiary">for USDC</span>
      </div>

      {demo ? (
        <p className="mt-2 text-[11px] leading-snug text-tertiary">
          Connect an engine to re-score your own book with a position moved
          into a stablecoin — same series, same arithmetic, before the trade.
        </p>
      ) : error ? (
        <p className="mt-2 text-[11px] leading-snug" style={{ color: "var(--severe)" }}>
          {error}
        </p>
      ) : result && fraction !== null ? (
        <Outcome result={result} busy={busy} />
      ) : (
        <p className="mt-2 text-[11px] leading-snug text-tertiary">
          {busy
            ? "Re-scoring…"
            : "Pick a share to see the score, VaR and concentration re-scored on the moved book."}
        </p>
      )}
    </div>
  );
}

function Outcome({ result, busy }: { result: WhatIfResult; busy: boolean }) {
  const { before, after } = result;
  const delta = after.risk - before.risk;
  const bandBefore = riskBand(before.risk);
  const bandAfter = riskBand(after.risk);

  return (
    <div className={`mt-2.5 space-y-1.5 ${busy ? "opacity-60" : ""}`}>
      <div className="flex items-baseline gap-2">
        <span className="numeric text-[15px] font-medium" style={{ color: bandBefore.color }}>
          {before.risk.toFixed(1)}
        </span>
        <span className="text-tertiary" aria-hidden="true">→</span>
        <span className="numeric text-[15px] font-medium" style={{ color: bandAfter.color }}>
          {after.risk.toFixed(1)}
        </span>
        <span
          className="numeric text-[12px]"
          style={{ color: delta < 0 ? "var(--calm)" : delta > 0 ? "var(--severe)" : "var(--text-tertiary)" }}
        >
          {delta > 0 ? "+" : ""}
          {delta.toFixed(1)}
        </span>
        {bandBefore.key !== bandAfter.key && (
          <span className="text-[11px] text-tertiary">
            {bandBefore.label} → <span style={{ color: bandAfter.color }}>{bandAfter.label}</span>
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
        <Change label="Value at Risk" from={usd(before.varUsd)} to={usd(after.varUsd)} />
        <Change
          label="Effective assets"
          from={before.effectiveAssets.toFixed(1)}
          to={after.effectiveAssets.toFixed(1)}
        />
        <Change
          label="Largest position"
          from={`${(before.maxWeight * 100).toFixed(0)}%`}
          to={`${(after.maxWeight * 100).toFixed(0)}%`}
        />
      </dl>

      <p className="text-[10px] leading-snug text-tertiary">
        Moves {usd(result.movedUsd)} of {result.from} into {result.to} at the
        last tick&rsquo;s prices; the book keeps its value and changes shape.
      </p>
    </div>
  );
}

function Change({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-tertiary">{label}</dt>
      <dd className="numeric text-text">
        <span className="text-tertiary">{from}</span>
        <span className="mx-1 text-tertiary" aria-hidden="true">→</span>
        {to}
      </dd>
    </div>
  );
}
