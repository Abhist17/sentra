"use client";

import type { Overview } from "@/lib/types";
import { useMounted } from "@/lib/hooks";
import { timeAgo } from "@/lib/format";

type Correlation = NonNullable<Overview["market"]["correlation"]>;

/**
 * The correlation matrix behind the covariance behind the VaR.
 *
 * Monochrome on purpose. Colour on this page carries risk severity and asset
 * identity; a correlation is neither, it is a fact about pairs, so the cells
 * darken with |ρ| and say the number. The reader's question is "which of my
 * holdings are secretly the same bet", so the assets the selected wallet
 * holds are picked out and everything else recedes.
 */
export function CorrelationGrid({
  correlation,
  held = [],
}: {
  correlation: Correlation;
  /** Symbols the selected wallet holds, to foreground their rows. */
  held?: string[];
}) {
  const mounted = useMounted();
  const { symbols, matrix } = correlation;
  const holds = new Set(held);
  const anyHeld = symbols.some((s) => holds.has(s));

  // The pair the reader should notice: the most correlated of the wallet's
  // own holdings, if it holds more than one of these.
  let callout: { a: string; b: string; rho: number } | null = null;
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      if (!holds.has(symbols[i]) || !holds.has(symbols[j])) continue;
      const rho = matrix[i][j];
      if (!callout || rho > callout.rho) {
        callout = { a: symbols[i], b: symbols[j], rho };
      }
    }
  }

  return (
    <div className="px-4 py-3.5">
      <div className="overflow-x-auto">
        <table
          className="numeric w-full border-separate border-spacing-[2px] text-[10px]"
          aria-label={`Correlation matrix across ${symbols.length} assets`}
        >
          <thead>
            <tr>
              <th aria-hidden="true" />
              {symbols.map((s) => (
                <th
                  key={s}
                  scope="col"
                  className={`pb-1 text-center font-medium ${
                    !anyHeld || holds.has(s) ? "text-text" : "text-tertiary"
                  }`}
                >
                  {short(s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((row, i) => (
              <tr key={row}>
                <th
                  scope="row"
                  className={`pr-1.5 text-left font-medium ${
                    !anyHeld || holds.has(row) ? "text-text" : "text-tertiary"
                  }`}
                >
                  {short(row)}
                </th>
                {symbols.map((col, j) => {
                  const rho = matrix[i][j];
                  const diagonal = i === j;
                  const dim = anyHeld && !(holds.has(row) && holds.has(col));
                  return (
                    <td
                      key={col}
                      className="h-7 min-w-7 rounded-[3px] text-center"
                      style={{
                        backgroundColor: diagonal
                          ? "transparent"
                          : `color-mix(in srgb, var(--text) ${Math.round(
                              Math.abs(rho) * (dim ? 22 : 60)
                            )}%, transparent)`,
                        color: diagonal
                          ? "var(--border-strong)"
                          : Math.abs(rho) * (dim ? 22 : 60) > 34
                            ? "var(--bg)"
                            : dim
                              ? "var(--text-tertiary)"
                              : "var(--text)",
                        // A rare negative pair is shown by its outline, since
                        // fill intensity alone cannot carry a sign.
                        outline:
                          rho < -0.05 ? "1px solid var(--text-secondary)" : undefined,
                        outlineOffset: -1,
                      }}
                      title={diagonal ? undefined : `${row} · ${col}: ${rho.toFixed(2)}`}
                    >
                      {diagonal ? "·" : fmt(rho)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-snug text-tertiary">
        {callout ? (
          <>
            <span className="text-secondary">
              {callout.a} and {callout.b}
            </span>{" "}
            move together at {callout.rho.toFixed(2)} —{" "}
            {callout.rho >= 0.9
              ? "one position wearing two names."
              : callout.rho >= 0.7
                ? "spreading across them buys less than it looks."
                : "genuinely different exposures."}
          </>
        ) : (
          <>
            Pairs near 1.00 move as one; a book spread across them is one bet
            with several tickers.
          </>
        )}
      </p>

      <p className="mt-1.5 text-[10px] leading-snug text-tertiary">
        {correlation.windowDays}-day window, exponentially weighted on the
        same decay as the loss model
        {mounted && correlation.asOf > 0
          ? ` · refreshed ${timeAgo(correlation.asOf)}`
          : ""}
        .
      </p>
    </div>
  );
}

/** Column headers are tight. JitoSOL's usual short form keeps it apart
 *  from JTO, which a plain four-letter cut would not. */
const SHORT: Record<string, string> = { JITOSOL: "jSOL" };

function short(symbol: string): string {
  return SHORT[symbol] ?? (symbol.length <= 4 ? symbol : symbol.slice(0, 4));
}

function fmt(rho: number): string {
  // ".87" fits a 28px cell where "0.87" does not.
  const s = Math.abs(rho).toFixed(2).replace(/^0/, "");
  return rho < 0 ? `-${s}` : s;
}
