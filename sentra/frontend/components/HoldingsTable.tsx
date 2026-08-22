"use client";

import type { Holding } from "@/lib/types";
import { usd, tokenAmount, price, assetColor } from "@/lib/format";
import { EmptyState } from "./ui";

export function HoldingsTable({
  holdings,
  total,
}: {
  holdings: Holding[];
  total: number;
}) {
  const held = holdings
    .filter((h) => h.value > 0)
    .sort((a, b) => b.value - a.value);

  if (held.length === 0) {
    return (
      <EmptyState
        title="No priced holdings"
        body="This wallet holds none of the tracked assets — SOL, BONK, JUP or USDC."
        compact
      />
    );
  }

  return (
    <div>
      {/* Composition bar — the shape of the book at a glance */}
      <div className="flex h-1 gap-px px-4 pt-4">
        {held.map((h) => (
          <div
            key={h.symbol}
            className="h-full rounded-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${Math.max(h.weight * 100, 0.5)}%`,
              backgroundColor: assetColor(h.symbol),
            }}
          />
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th className="label px-4 py-2.5 text-left font-semibold">
                Asset
              </th>
              <th className="label px-4 py-2.5 text-right font-semibold">
                Balance
              </th>
              <th className="label px-4 py-2.5 text-right font-semibold">
                Price
              </th>
              <th className="label px-4 py-2.5 text-right font-semibold">
                Value
              </th>
              <th className="label px-4 py-2.5 text-right font-semibold">
                Weight
              </th>
            </tr>
          </thead>
          <tbody>
            {held.map((h) => (
              <tr
                key={h.symbol}
                className="border-b border-border last:border-0 transition-colors hover:bg-surface-hover"
              >
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: assetColor(h.symbol) }}
                    />
                    <span className="font-medium text-text">{h.symbol}</span>
                  </span>
                </td>
                <td className="numeric px-4 py-2.5 text-right text-secondary">
                  {tokenAmount(h.amount)}
                </td>
                <td className="numeric px-4 py-2.5 text-right text-secondary">
                  {price(h.price)}
                </td>
                <td className="numeric px-4 py-2.5 text-right font-medium text-text">
                  {usd(h.value)}
                </td>
                <td className="numeric px-4 py-2.5 text-right text-secondary">
                  {(h.weight * 100).toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-strong">
              <td className="label px-4 py-2.5 font-semibold">Total</td>
              <td colSpan={2} />
              <td className="numeric px-4 py-2.5 text-right font-medium text-text">
                {usd(total)}
              </td>
              <td className="numeric px-4 py-2.5 text-right text-tertiary">
                100%
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
