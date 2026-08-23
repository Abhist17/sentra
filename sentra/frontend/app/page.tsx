"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useOverview, useListKeyboardNav } from "@/lib/hooks";
import { resolveApiUrl } from "@/lib/api";
import { usd, pct, timeAgo } from "@/lib/format";
import { TopBar } from "@/components/TopBar";
import { EngineUrlDialog } from "@/components/EngineUrlDialog";
import { SummaryPanel } from "@/components/SummaryPanel";
import { TrendChart } from "@/components/TrendChart";
import { HoldingsTable } from "@/components/HoldingsTable";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { RiskAttribution } from "@/components/RiskAttribution";
import { WalletList } from "@/components/WalletList";
import { PriceList, StressPanel } from "@/components/MarketPanel";
import {
  Panel,
  PanelHeader,
  Button,
  Notice,
  Skeleton,
  EmptyState,
  Row,
} from "@/components/ui";

export default function Dashboard() {
  const { data, error, loading, refreshing, refresh, demo } = useOverview(10_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Default to the riskiest wallet, and recover gracefully if the selected
  // one is removed.
  useEffect(() => {
    if (!data?.wallets.length) {
      setSelected(null);
      return;
    }
    setSelected((current) => {
      if (current && data.wallets.some((w) => w.address === current)) {
        return current;
      }
      return [...data.wallets].sort(
        (a, b) => (b.metrics?.risk ?? -1) - (a.metrics?.risk ?? -1)
      )[0].address;
    });
  }, [data]);

  const active = useMemo(
    () => data?.wallets.find((w) => w.address === selected) ?? null,
    [data, selected]
  );

  const wallets = data?.wallets ?? [];
  const activeIndex = wallets.findIndex((w) => w.address === selected);

  useListKeyboardNav({
    count: wallets.length,
    index: activeIndex < 0 ? 0 : activeIndex,
    onSelect: useCallback(
      (next: number) => setSelected(wallets[next]?.address ?? null),
      [wallets]
    ),
    onAdd: useCallback(() => {
      document
        .querySelector<HTMLButtonElement>("[data-add-wallet]")
        ?.click();
    }, []),
  });

  const settings = (
    <EngineUrlDialog
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      onSaved={() => void refresh()}
    />
  );

  if (loading) return <LoadingView />;

  if (error && !data) {
    return (
      <>
        <ConnectionError
          message={error}
          onRetry={refresh}
          onConfigure={() => setSettingsOpen(true)}
        />
        {settings}
      </>
    );
  }

  if (!data) return <LoadingView />;

  const { totals, market, config } = data;

  return (
    <div className="min-h-screen">
      <TopBar
        demo={demo}
        lastTickAt={market.lastTickAt}
        lastTickError={market.lastTickError}
        pricesStale={market.pricesStale}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settings}

      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        {demo && (
          <div className="mb-4">
            <Notice tone="info">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium text-text">Demo data.</span>
                <span>
                  No engine is connected, so these figures are synthetic —
                  two example books chosen to show how similar balances can
                  carry very different risk.
                </span>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="font-medium text-text underline underline-offset-2 hover:opacity-70"
                >
                  Connect an engine
                </button>
                <span>for live numbers.</span>
              </span>
            </Notice>
          </div>
        )}

        {(error || market.lastTickError) && (
          <div className="mb-4 space-y-2">
            {error && (
              <Notice tone="warn">
                Showing the last good snapshot — {error}
              </Notice>
            )}
            {market.lastTickError && (
              <Notice tone="error">
                Engine tick failed: {market.lastTickError}
              </Notice>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[264px_minmax(0,1fr)]">
          {/* ── Sidebar ──────────────────────────────────── */}
          <aside className="space-y-4 lg:sticky lg:top-[72px] lg:self-start">
            <Panel>
              <PanelHeader title="Wallets" meta={`${wallets.length}`} />
              <WalletList
                wallets={wallets}
                selected={selected}
                onSelect={setSelected}
                onChanged={refresh}
              />
            </Panel>

            <Panel delay={40}>
              <PanelHeader
                title="Market"
                meta={market.pricesStale ? "cached" : "live"}
              />
              <PriceList
                prices={market.prices}
                changes={market.changes}
                volatility={market.volatility}
                stale={market.pricesStale}
              />
            </Panel>

            <Panel delay={80}>
              <PanelHeader
                title="Engine"
                meta={demo ? "not connected" : undefined}
              />
              <dl className="px-4 py-3">
                <Row
                  label="Poll interval"
                  value={
                    demo ? "—" : `${Math.round(config.monitorInterval / 1000)}s`
                  }
                />
                <Row
                  label="Last tick"
                  value={demo ? "—" : timeAgo(market.lastTickAt)}
                />
                <Row
                  label="Return series"
                  value={
                    demo
                      ? "—"
                      : `${market.historyAssets}/${config.trackedAssets.length}`
                  }
                />
                <Row
                  label="Alert threshold"
                  value={pct(config.riskAlertThreshold, 0)}
                />
                <Row
                  label="Telegram"
                  value={config.telegram ? "on" : "off"}
                  color={
                    config.telegram ? "var(--calm)" : "var(--text-tertiary)"
                  }
                />
                <Row
                  label="On-chain writes"
                  value={config.onchainWrites ? "on" : "off"}
                  color={
                    config.onchainWrites
                      ? "var(--calm)"
                      : "var(--text-tertiary)"
                  }
                />
              </dl>
            </Panel>
          </aside>

          {/* ── Main ─────────────────────────────────────── */}
          <div className="min-w-0 space-y-4">
            <SummaryPanel
              score={totals.risk}
              metrics={[
                {
                  label: "Exposure",
                  value: usd(totals.portfolio),
                  detail: `${totals.wallets} wallet${
                    totals.wallets === 1 ? "" : "s"
                  } monitored`,
                },
                {
                  label: `Value at Risk · ${config.varHorizonDays}d`,
                  value: usd(totals.varUsd),
                  detail: `Expected shortfall ${usd(totals.esUsd)} · ${(
                    config.varConfidence * 100
                  ).toFixed(0)}% confidence`,
                },
                {
                  label: "Market stress",
                  value: `${market.stress.score}`,
                  detail: `${market.stress.signals.length} signal${
                    market.stress.signals.length === 1 ? "" : "s"
                  } active`,
                },
                {
                  label: "Concentration",
                  value: active?.metrics
                    ? pct(active.metrics.maxWeight * 100, 1)
                    : "—",
                  detail: "Largest single-asset weight",
                },
              ]}
            />

            <Panel delay={40}>
              <PanelHeader
                title="Risk over time"
                meta={active?.label}
                action={
                  <span className="numeric text-[11px] text-tertiary">
                    every {Math.round(config.monitorInterval / 1000)}s
                  </span>
                }
              />
              {active ? (
                <TrendChart
                  points={active.history}
                  threshold={config.riskAlertThreshold}
                />
              ) : (
                <EmptyState
                  title="No wallet selected"
                  body="Add a Solana address in the sidebar to start scoring a portfolio."
                />
              )}
            </Panel>

            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <Panel delay={80}>
                <PanelHeader title="Holdings" meta={active?.label} />
                {active?.metrics ? (
                  <HoldingsTable
                    holdings={active.metrics.holdings}
                    total={active.metrics.portfolio}
                  />
                ) : (
                  <EmptyState
                    title="Awaiting first tick"
                    body="Balances are read from mainnet on the next engine cycle."
                    compact
                  />
                )}
              </Panel>

              <div className="space-y-4">
                <Panel delay={120}>
                  <PanelHeader
                    title="Where the risk is"
                    meta="value vs risk"
                  />
                  {active?.metrics ? (
                    <RiskAttribution metrics={active.metrics} />
                  ) : (
                    <EmptyState
                      title="Nothing scored yet"
                      body="Attribution appears once the engine values this wallet."
                      compact
                    />
                  )}
                </Panel>

                <Panel delay={140}>
                  <PanelHeader title="Score composition" />
                  {active?.metrics ? (
                    <ScoreBreakdown metrics={active.metrics} />
                  ) : (
                    <EmptyState
                      title="Nothing scored yet"
                      body="The breakdown appears once the engine values this wallet."
                      compact
                    />
                  )}
                </Panel>

                <Panel delay={160}>
                  <PanelHeader title="Market stress" />
                  <StressPanel
                    score={market.stress.score}
                    level={market.stress.level}
                    signals={market.stress.signals}
                  />
                </Panel>
              </div>
            </div>
          </div>
        </div>

        <footer className="mt-8 border-t border-border pt-4">
          <p className="text-[11px] leading-relaxed text-tertiary">
            Value at Risk is computed from a 30-day covariance matrix and
            blended with live market-stress signals. Figures are model
            estimates, not investment advice.
          </p>
        </footer>
      </main>
    </div>
  );
}

function ConnectionError({
  message,
  onRetry,
  onConfigure,
}: {
  message: string;
  onRetry: () => void;
  onConfigure: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="card w-full max-w-md p-6">
        <h1 className="text-[15px] font-semibold text-text">
          Cannot reach the Sentra engine
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-secondary">
          {message}
        </p>

        <pre className="numeric mt-4 overflow-x-auto rounded-md border border-border bg-bg-subtle px-3 py-2.5 text-[11px] leading-relaxed text-secondary">
{`cd sentra/backend
npm install
npm run dev`}
        </pre>

        <p className="mt-3 text-[11px] leading-relaxed text-tertiary">
          Pointed at{" "}
          <span className="numeric text-secondary">{resolveApiUrl()}</span>.
        </p>

        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={onRetry} className="flex-1">
            Retry
          </Button>
          <Button variant="secondary" onClick={onConfigure}>
            Change URL
          </Button>
        </div>
      </div>
    </div>
  );
}

function LoadingView() {
  return (
    <div className="min-h-screen">
      <div className="h-14 border-b border-border" />
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        <div className="grid gap-4 lg:grid-cols-[264px_minmax(0,1fr)]">
          <div className="space-y-4">
            <Skeleton className="h-52" />
            <Skeleton className="h-40" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[290px]" />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <Skeleton className="h-64" />
              <Skeleton className="h-64" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
