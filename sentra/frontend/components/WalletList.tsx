"use client";

import { useState } from "react";
import type { WalletRow } from "@/lib/types";
import { addWallet, removeWallet, ApiError } from "@/lib/api";
import { usd, pct, shortAddress, riskBand } from "@/lib/format";
import { Button, Input, Notice, Tag } from "./ui";
import { Sparkline } from "./Sparkline";

export function WalletList({
  wallets,
  selected,
  onSelect,
  onChanged,
  readOnly = false,
  onConnectEngine,
}: {
  wallets: WalletRow[];
  selected: string | null;
  onSelect: (address: string) => void;
  onChanged: () => Promise<void> | void;
  /** Engine requires a key this dashboard does not have — writes will 401. */
  readOnly?: boolean;
  onConnectEngine?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim() || busy) return;

    setBusy(true);
    setError(null);

    try {
      await addWallet(address.trim(), label.trim() || undefined);
      setAddress("");
      setLabel("");
      setAdding(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add wallet");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(target: string) {
    // Removing discards that wallet's whole in-memory history, so it confirms.
    if (confirming !== target) {
      setConfirming(target);
      setTimeout(
        () => setConfirming((c) => (c === target ? null : c)),
        4000
      );
      return;
    }

    setConfirming(null);
    setBusy(true);
    setError(null);

    try {
      await removeWallet(target);
      await onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not remove wallet"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-3 py-3">
      <ul className="space-y-0.5" role="list">
        {wallets.map((wallet) => {
          const isSelected = wallet.address === selected;
          const band = wallet.metrics ? riskBand(wallet.metrics.risk) : null;

          return (
            <li key={wallet.address} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(wallet.address)}
                aria-current={isSelected ? "true" : undefined}
                className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                  isSelected
                    ? "bg-surface-active"
                    : "hover:bg-surface-hover"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: band?.color ?? "var(--border-strong)",
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
                    {wallet.label}
                  </span>
                  {wallet.metrics && (
                    <span
                      className="numeric shrink-0 text-[13px] font-medium"
                      style={{ color: band!.color }}
                    >
                      {pct(wallet.metrics.risk, 1)}
                    </span>
                  )}
                </span>

                <span className="mt-0.5 flex items-center gap-2 pl-3.5">
                  <span className="numeric truncate text-[11px] text-tertiary">
                    {shortAddress(wallet.address, 5)}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {band && wallet.history.length > 1 && (
                      <Sparkline points={wallet.history} color={band.color} />
                    )}
                    <span className="numeric text-[11px] text-tertiary">
                      {wallet.metrics ? usd(wallet.metrics.portfolio) : "pending"}
                    </span>
                  </span>
                </span>
              </button>

              {!wallet.isDemo && !readOnly && (
                <div className="absolute right-1.5 top-1.5">
                  {confirming === wallet.address ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRemove(wallet.address)}
                      disabled={busy}
                      className="!h-5 !px-1.5 !text-[10px] border-severe/50 text-severe"
                    >
                      Remove?
                    </Button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleRemove(wallet.address)}
                      disabled={busy}
                      aria-label={`Stop monitoring ${wallet.label}`}
                      className="rounded p-1 text-tertiary opacity-0 transition-opacity hover:text-severe focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M2 2l8 8M10 2l-8 8"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              )}

              {wallet.isDemo && !wallet.metrics && (
                <span className="absolute right-2 top-2">
                  <Tag>demo</Tag>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-2 border-t border-border pt-2.5">
        {/* A public engine protects its write routes so strangers cannot spend
            its RPC quota. Say so up front rather than letting someone type an
            address and meet a 401. */}
        {readOnly ? (
          <p className="px-1.5 py-1 text-[11px] leading-relaxed text-tertiary">
            This engine is read-only.{" "}
            {onConnectEngine && (
              <>
                <button
                  type="button"
                  onClick={onConnectEngine}
                  className="font-medium text-secondary underline underline-offset-2 hover:text-text"
                >
                  Connect your own
                </button>{" "}
              </>
            )}
            to monitor a wallet.
          </p>
        ) : adding ? (
          <form onSubmit={handleAdd} className="space-y-2">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Solana address"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              aria-label="Solana wallet address"
              className="numeric !text-xs"
            />
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              maxLength={64}
              aria-label="Wallet label"
              className="!text-xs"
            />
            <div className="flex gap-1.5">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={busy || !address.trim()}
                className="flex-1"
              >
                {busy ? "Adding…" : "Add wallet"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            data-add-wallet
            className="w-full justify-between"
          >
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true">+</span> Monitor a wallet
            </span>
            <kbd className="numeric rounded border border-border px-1 text-[9px] text-tertiary">
              /
            </kbd>
          </Button>
        )}

        {error && (
          <div className="mt-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </div>
    </div>
  );
}
