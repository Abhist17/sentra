"use client";

import type { AnchorRecord, OnChainConfig } from "@/lib/types";
import { usd, riskBand, shortAddress, timeAgo, clockTime } from "@/lib/format";
import { explorerUrl, clusterLabel, intervalLabel } from "@/lib/solana";
import { useMounted, useNow } from "@/lib/hooks";
import { Notice, Tag } from "./ui";

/** Rows shown before the list is cut; the chain has the rest. */
const SHOWN = 6;

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
  anchors,
  onchain,
  demo = false,
}: {
  anchors: AnchorRecord[];
  onchain: OnChainConfig;
  demo?: boolean;
}) {
  const mounted = useMounted();
  useNow(30_000);

  const cluster = onchain.cluster;
  const programLink = explorerUrl("address", onchain.programId, cluster);
  const reporterLink = onchain.reporter
    ? explorerUrl("address", onchain.reporter, cluster)
    : null;

  // Newest first: the reader wants the latest proof, not the oldest.
  const recent = [...anchors].sort((a, b) => b.timestamp - a.timestamp);
  const shown = recent.slice(0, SHOWN);

  return (
    <div className="px-4 py-3.5">
      {onchain.lastError && (
        <div className="mb-3">
          <Notice tone="error">Last anchor failed: {onchain.lastError}</Notice>
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

      {onchain.enabled && recent.length > SHOWN && (
        <p className="mt-2 text-[11px] text-tertiary">
          {recent.length - SHOWN} older on this engine, the full series on
          the chain.
        </p>
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
