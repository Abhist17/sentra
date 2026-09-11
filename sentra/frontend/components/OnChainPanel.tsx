"use client";

import { useEffect, useState } from "react";
import type { AnchorRecord, OnChainConfig, Snapshot } from "@/lib/types";
import { getSnapshots, ApiError } from "@/lib/api";
import { usd, riskBand, shortAddress, timeAgo, clockTime } from "@/lib/format";
import { explorerUrl, clusterLabel, intervalLabel } from "@/lib/solana";
import { useMounted, useNow } from "@/lib/hooks";
import { Button, Notice, Tag } from "./ui";

/** Rows shown before the list is cut; the chain has the rest. */
const SHOWN = 6;

/** Rows shown when the list comes from the chain rather than memory. */
const SHOWN_FROM_CHAIN = 12;

/** What the panel is showing: the engine's memory, or the chain itself. */
type Source =
  | { kind: "engine" }
  | { kind: "chain"; rows: Snapshot[]; all: boolean; at: number };

/**
 * The on-chain record for one wallet.
 *
 * Every other panel on the page asks the reader to trust the engine. This one
 * is where they stop having to: each row is an account on Solana that says
 * what the score was, on what book, with how much at risk, at what second —
 * written by a key anyone can check. So the rows link out rather than in,
 * and the panel names the program and reporter to verify against instead of
 * asking to be believed.
 */
export function OnChainPanel({
  wallet,
  anchors,
  onchain,
  demo = false,
}: {
  /** Address of the wallet whose record this is. */
  wallet: string | null;
  anchors: AnchorRecord[];
  onchain: OnChainConfig;
  demo?: boolean;
}) {
  const mounted = useMounted();
  useNow(30_000);

  // The engine remembers what it wrote; the chain remembers everything.
  // Reading the chain here is the point of the panel — a reader who
  // does not trust the engine's list gets the program's answer instead,
  // through the same engine but from an account scan it cannot fake.
  const [source, setSource] = useState<Source>({ kind: "engine" });
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  // A different wallet is a different record.
  useEffect(() => {
    setSource({ kind: "engine" });
    setReadError(null);
  }, [wallet]);

  async function readChain(all: boolean) {
    if (!wallet || reading) return;
    setReading(true);
    setReadError(null);
    try {
      const result = await getSnapshots(wallet, all);
      setSource({ kind: "chain", rows: result.snapshots, all, at: Date.now() });
    } catch (err) {
      setReadError(
        err instanceof ApiError ? err.message : "Could not read the chain"
      );
    } finally {
      setReading(false);
    }
  }

  const cluster = onchain.cluster;
  const programLink = explorerUrl("address", onchain.programId, cluster);
  const reporterLink = onchain.reporter
    ? explorerUrl("address", onchain.reporter, cluster)
    : null;

  // Newest first: the reader wants the latest proof, not the oldest.
  const rows: (AnchorRecord & { trusted: boolean })[] =
    source.kind === "chain"
      ? source.rows.map((s) => ({
          wallet: s.wallet,
          reporter: s.reporter,
          riskScore: s.riskScore,
          timestamp: s.timestamp,
          valueUsd: s.valueUsd,
          varUsd: s.varUsd,
          pda: s.publicKey,
          signature: "",
          breached: false,
          trusted: s.trusted,
        }))
      : anchors.map((a) => ({ ...a, trusted: true }));
  const recent = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  const limit = source.kind === "chain" ? SHOWN_FROM_CHAIN : SHOWN;
  const shown = recent.slice(0, limit);

  return (
    <div className="px-4 py-3.5">
      {onchain.lastError && (
        <div className="mb-3">
          <Notice tone="error">Last anchor failed: {onchain.lastError}</Notice>
        </div>
      )}
      {readError && (
        <div className="mb-3">
          <Notice tone="error">{readError}</Notice>
        </div>
      )}

      {demo && (
        <p className="mb-3 text-[11px] leading-relaxed text-tertiary">
          Synthetic rows. With an engine anchoring, each one is an account on
          Solana holding the score, the book&rsquo;s value and its Value at
          Risk at that second &mdash; a claim about past risk anyone can open.
        </p>
      )}

      {!onchain.enabled ? (
        <p className="text-xs leading-relaxed text-tertiary">
          This engine is not anchoring scores. Set{" "}
          <span className="numeric text-secondary">
            ENABLE_ONCHAIN_WRITES=true
          </span>{" "}
          and every hour, and every band change, writes this wallet&rsquo;s
          score to the Sentra program on {clusterLabel(cluster)} as an
          immutable snapshot.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-xs leading-relaxed text-tertiary">
          Nothing anchored yet &mdash; the first snapshot lands on the next
          tick, then {intervalLabel(onchain.anchorInterval)} and whenever the
          score crosses a band.
        </p>
      ) : (
        <ol className="space-y-2.5" role="list">
          {shown.map((a) => {
            const band = riskBand(a.riskScore);
            const tx = explorerUrl("tx", a.signature, cluster);
            const account = explorerUrl("address", a.pda, cluster);
            const at = a.timestamp * 1000;

            return (
              <li key={a.pda || a.timestamp} className="flex items-baseline gap-3">
                <span
                  className="numeric w-8 shrink-0 text-[15px] font-medium"
                  style={{ color: band.color }}
                >
                  {a.riskScore}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="numeric text-[12px] text-text">
                      {clockTime(at)}
                    </span>
                    <span className="numeric text-[11px] text-tertiary">
                      {mounted ? timeAgo(at) : ""}
                    </span>
                    {a.breached && <Tag color="var(--severe)">breach</Tag>}
                    {/* Another key's reading of this wallet. Shown because
                        the reader asked for everyone; marked because it is
                        not this engine's word. */}
                    {!a.trusted && (
                      <Tag>
                        <span className="numeric">
                          {shortAddress(a.reporter, 4)}
                        </span>
                      </Tag>
                    )}
                  </span>
                  <span className="numeric block text-[11px] text-tertiary">
                    {a.valueUsd > 0 ? usd(a.valueUsd) : "—"} book ·{" "}
                    {a.varUsd > 0 ? usd(a.varUsd) : "—"} at risk
                  </span>
                </span>

                <span className="flex shrink-0 gap-2 text-[11px]">
                  {tx ? (
                    <ExternalLink href={tx}>tx</ExternalLink>
                  ) : (
                    <span className="text-tertiary/60">tx</span>
                  )}
                  {account ? (
                    <ExternalLink href={account}>account</ExternalLink>
                  ) : (
                    <span className="text-tertiary/60">account</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {onchain.enabled && source.kind === "engine" && recent.length > SHOWN && (
        <p className="mt-2 text-[11px] text-tertiary">
          {recent.length - SHOWN} more recent on this engine; the full series
          is on the chain.
        </p>
      )}

      {source.kind === "chain" && (
        <p className="mt-2 text-[11px] text-tertiary">
          {source.rows.length} snapshot{source.rows.length === 1 ? "" : "s"}{" "}
          on the chain
          {source.all ? " from every reporter" : " from this engine"}
          {recent.length > SHOWN_FROM_CHAIN
            ? `, newest ${SHOWN_FROM_CHAIN} shown`
            : ""}
          {mounted ? ` · read ${timeAgo(source.at)}` : ""}.
        </p>
      )}

      {onchain.enabled && !demo && wallet && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void readChain(false)}
            disabled={reading}
          >
            {reading
              ? "Reading…"
              : source.kind === "chain"
                ? "Read again"
                : "Read the chain"}
          </Button>
          {source.kind === "chain" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void readChain(!source.all)}
              disabled={reading}
            >
              {source.all ? "Only this engine" : "Every reporter"}
            </Button>
          )}
          {source.kind === "chain" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSource({ kind: "engine" })}
              disabled={reading}
            >
              Back to live
            </Button>
          )}
        </div>
      )}

      <dl className="mt-4 space-y-1.5 border-t border-border pt-3">
        <Row label="Program">
          {programLink ? (
            <ExternalLink href={programLink} mono>
              {shortAddress(onchain.programId, 6)}
            </ExternalLink>
          ) : (
            <span className="numeric">{shortAddress(onchain.programId, 6)}</span>
          )}
          <span className="ml-1.5 text-tertiary">{clusterLabel(cluster)}</span>
        </Row>
        <Row label="Reporter">
          {onchain.reporter ? (
            reporterLink ? (
              <ExternalLink href={reporterLink} mono>
                {shortAddress(onchain.reporter, 6)}
              </ExternalLink>
            ) : (
              <span className="numeric">{shortAddress(onchain.reporter, 6)}</span>
            )
          ) : (
            <span className="text-tertiary">none</span>
          )}
        </Row>
        {onchain.enabled && (
          <Row label="Cadence">
            <span>{intervalLabel(onchain.anchorInterval)}, and on band change</span>
          </Row>
        )}
      </dl>

      {onchain.enabled && onchain.reporter && !demo && (
        <p className="mt-2.5 text-[10px] leading-snug text-tertiary">
          A snapshot is this engine&rsquo;s word only if its reporter field is
          the key above. Anyone may write one; nobody can write one as someone
          else.
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-baseline text-xs text-text">{children}</dd>
    </div>
  );
}

function ExternalLink({
  href,
  mono = false,
  children,
}: {
  href: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${
        mono ? "numeric " : ""
      }text-secondary underline decoration-border-strong underline-offset-2 transition-colors hover:text-text hover:decoration-text`}
    >
      {children}
      <span aria-hidden="true" className="ml-0.5 text-[9px]">
        ↗
      </span>
      <span className="sr-only"> (opens Solana Explorer)</span>
    </a>
  );
}
