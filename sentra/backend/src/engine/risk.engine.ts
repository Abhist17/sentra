import {
  fetchLivePrices,
  fetchAllHistories,
  inferIntervalMs,
  ASSET_SYMBOLS,
  STABLE_ASSETS,
  type AssetSymbol,
  type PriceMap,
} from "../services/price.service";
import {
  computeReturns,
  calculatePortfolioRisk,
  concentrationPenalty,
  correlationMatrix,
  scaleLambdaToFrequency,
} from "../services/risk.service";
import { sendTelegramAlert } from "../services/telegram.service";
import {
  createProvider,
  getProgram,
  fetchWalletPortfolio,
  fetchWalletSnapshots,
  recordRiskScoreOnChain,
  type AnchorRecord,
} from "../services/blockchain.service";
import {
  getWalletPublicKeys,
  getWalletLabel,
  hasWallet,
} from "../services/wallet.registry";
import {
  updateMetrics,
  updateMarket,
  recordAnchor,
  seedAnchors,
  hasAnchors,
  getAnchors,
  setOnChainError,
  type AssetHolding,
} from "../store/metrics.store";
import { CONFIG } from "../config/env";
import type { PublicKey } from "@solana/web3.js";

/** Prices here span eight orders of magnitude; one fixed precision fits none. */
function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.001) return value.toFixed(4);
  return value.toFixed(8);
}

// ─────────────────────────────────────────────
// 1. SHORT-TERM VOLATILITY TRACKER
// Keeps the last N *live* prices per asset and takes the standard deviation
// of the returns between them.
// ─────────────────────────────────────────────
const VOLATILITY_WINDOW_SIZE = 12;

const priceWindow: Record<string, number[]> = {};

export function updatePriceWindow(symbol: string, price: number): void {
  const window = (priceWindow[symbol] ??= []);
  window.push(price);
  if (window.length > VOLATILITY_WINDOW_SIZE) window.shift();
}

/** Clears the live price window. Tests need a clean slate between cases. */
export function resetPriceWindow(): void {
  for (const key of Object.keys(priceWindow)) delete priceWindow[key];
}

/** Returns between consecutive live ticks for one asset. */
export function liveReturns(symbol: string): number[] {
  return computeReturns(priceWindow[symbol] ?? []);
}

export function computeVolatility(symbol: string): number {
  const returns = liveReturns(symbol);
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;

  return Math.sqrt(variance);
}

export function detectVolatilitySpike(threshold = 0.03): {
  spiking: boolean;
  spikingAssets: string[];
  volatility: Record<string, number>;
} {
  const spikingAssets: string[] = [];
  const volatility: Record<string, number> = {};

  for (const symbol of Object.keys(priceWindow)) {
    const vol = computeVolatility(symbol);
    volatility[symbol] = vol;

    // A 3% "move" on a stablecoin is a feed glitch, not a market signal.
    if (STABLE_ASSETS.has(symbol as AssetSymbol)) continue;
    if (vol > threshold) spikingAssets.push(symbol);
  }

  return { spiking: spikingAssets.length > 0, spikingAssets, volatility };
}

// ─────────────────────────────────────────────
// 2. RAPID PRICE DROP DETECTION
// ─────────────────────────────────────────────
export interface RapidDropResult {
  detected: boolean;
  drops: { symbol: string; changePercent: number }[];
  changes: Partial<Record<AssetSymbol, number>>;
}

export function detectRapidDrops(
  currentPrices: PriceMap,
  previousPrices: Partial<PriceMap>,
  dropThreshold = -3
): RapidDropResult {
  const drops: { symbol: string; changePercent: number }[] = [];
  const changes: Partial<Record<AssetSymbol, number>> = {};

  for (const symbol of ASSET_SYMBOLS) {
    const prev = previousPrices[symbol];
    const current = currentPrices[symbol];
    if (!prev || prev <= 0 || !Number.isFinite(current)) continue;

    const changePercent = ((current - prev) / prev) * 100;
    changes[symbol] = changePercent;

    if (STABLE_ASSETS.has(symbol)) continue;
    if (changePercent <= dropThreshold) drops.push({ symbol, changePercent });
  }

  return { detected: drops.length > 0, drops, changes };
}

// ─────────────────────────────────────────────
// 3. CROSS-ASSET CORRELATION BREAKDOWN
// Assets falling together is a systemic signal — so it has to be measured on
// LIVE ticks. The old implementation read the cached 30-day history, which
// only changes once an hour, so the "signal" was frozen between refreshes.
// ─────────────────────────────────────────────
export interface CorrelationBreakdownResult {
  breakdown: boolean;
  fallingAssets: string[];
  fallingCount: number;
}

/**
 * How many non-stable assets must fall together to call it systemic. With
 * three volatile assets this was all of them; the universe is larger now,
 * and the signal keeps the same meaning — a clear majority moving down as
 * one — rather than a fixed count that grows easier to trip as assets are
 * added.
 */
export function correlatedMinimum(): number {
  const volatile = ASSET_SYMBOLS.filter((s) => !STABLE_ASSETS.has(s)).length;
  return Math.max(3, Math.ceil(volatile * 0.6));
}

export function detectCorrelationBreakdown(
  lookback = 3,
  minFallingAssets = correlatedMinimum()
): CorrelationBreakdownResult {
  const fallingAssets: string[] = [];

  for (const symbol of ASSET_SYMBOLS) {
    if (STABLE_ASSETS.has(symbol)) continue;

    const returns = liveReturns(symbol);
    if (returns.length < lookback) continue;

    const recent = returns.slice(-lookback);
    const avgReturn = recent.reduce((a, b) => a + b, 0) / recent.length;

    if (avgReturn < 0) fallingAssets.push(symbol);
  }

  return {
    breakdown: fallingAssets.length >= minFallingAssets,
    fallingAssets,
    fallingCount: fallingAssets.length,
  };
}

// ─────────────────────────────────────────────
// 4. MARKET STRESS SCORE (0–100)
// ─────────────────────────────────────────────
export interface MarketStressResult {
  score: number;
  signals: string[];
  level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
}

export function computeMarketStressScore(
  volatilitySpiking: boolean,
  spikingAssets: string[],
  correlationBreakdown: boolean,
  fallingAssets: string[],
  rapidDropDetected: boolean,
  drops: { symbol: string; changePercent: number }[]
): MarketStressResult {
  let score = 0;
  const signals: string[] = [];

  if (volatilitySpiking) {
    score += 30;
    signals.push(`⚡ Volatility spike: ${spikingAssets.join(", ")}`);
  }

  if (correlationBreakdown) {
    score += 30;
    signals.push(
      `📉 Correlation breakdown: ${fallingAssets.join(", ")} falling together`
    );
  }

  if (rapidDropDetected) {
    score += 40;
    const dropDetails = drops
      .map((d) => `${d.symbol}: ${d.changePercent.toFixed(2)}%`)
      .join(", ");
    signals.push(`🔥 Rapid drop: ${dropDetails}`);
  }

  score = Math.min(100, score);

  let level: MarketStressResult["level"];
  if (score >= 70) level = "CRITICAL";
  else if (score >= 40) level = "HIGH";
  else if (score >= 20) level = "MODERATE";
  else level = "LOW";

  return { score, signals, level };
}

// ─────────────────────────────────────────────
// 5. TELEGRAM ALERT BUILDERS
// ─────────────────────────────────────────────
function buildStressAlertMessage(stress: MarketStressResult): string {
  const signalBlock =
    stress.signals.length > 0 ? `\n${stress.signals.join("\n")}\n` : "";

  return (
    `🚨 MARKET STRESS ALERT\n` +
    `\nStress Score: ${stress.score}/100 [${stress.level}]\n` +
    signalBlock +
    `\n→ Elevated systemic risk detected\n⚡ Powered by Sentra`
  );
}

function buildWalletRiskAlertMessage(
  label: string,
  hybridRisk: number,
  portfolioValue: number,
  varUsd: number,
  esUsd: number,
  horizonDays: number,
  confidence: number,
  solPrice: number,
  solBalance: number,
  stress: MarketStressResult
): string {
  const horizon = horizonDays === 1 ? "1-day" : `${horizonDays}-day`;
  const pct = (confidence * 100).toFixed(0);

  let message =
    `⚠️ HIGH RISK ALERT\n\n` +
    `👛 Wallet: ${label}\n` +
    `📊 Risk Score: ${hybridRisk.toFixed(2)}%\n` +
    `💰 Portfolio: $${portfolioValue.toFixed(2)}\n` +
    `📉 ${horizon} VaR (${pct}%): $${varUsd.toFixed(2)}\n` +
    `🔻 Expected Shortfall: $${esUsd.toFixed(2)}\n` +
    `🪙 SOL: ${solBalance.toFixed(4)} @ $${solPrice.toFixed(2)}\n`;

  if (stress.score > 0) {
    message += `\n🔴 Market Stress: ${stress.score}/100 [${stress.level}]\n`;
    if (stress.signals.length > 0) {
      message += stress.signals.join("\n") + "\n";
    }
  }

  message += `\n⚡ Powered by Sentra — real-time on-chain risk monitoring.`;
  return message;
}

// ─────────────────────────────────────────────
// 6. ON-CHAIN ANCHORING POLICY
// ─────────────────────────────────────────────

/**
 * Band boundaries, shared with the dashboard's ramp: Calm / Watch / Elevated /
 * Severe. Anchoring on every tick would rent ~2,900 accounts a day per
 * wallet; anchoring on a timer alone would miss the moment a book crossed
 * into Severe. So: a snapshot on the timer, plus one the instant the band
 * changes — the readings a reader would actually want to be able to prove.
 */
export const RISK_BANDS = [0, 25, 45, 70] as const;

/**
 * Points past a boundary a score must travel before the crossing counts.
 * Without this a wallet sitting at 44.9 / 45.1 would anchor on every tick
 * as the price twitched, spending a snapshot's rent on nothing.
 */
export const BAND_HYSTERESIS = 2;

export function riskBandIndex(score: number): number {
  let band = 0;
  for (let i = 0; i < RISK_BANDS.length; i++) {
    if (score >= RISK_BANDS[i]) band = i;
  }
  return band;
}

/**
 * True when `score` has moved into a different band than `from` AND cleared
 * the boundary by the hysteresis margin, in the direction it crossed.
 */
export function crossedBand(from: number, score: number): boolean {
  const before = riskBandIndex(from);
  const after = riskBandIndex(score);
  if (after === before) return false;

  if (after > before) {
    // Rising: the boundary entered is the new band's floor.
    return score >= RISK_BANDS[after] + BAND_HYSTERESIS;
  }
  // Falling: the boundary left is the old band's floor.
  return score <= RISK_BANDS[before] - BAND_HYSTERESIS;
}

interface AnchorMemory {
  at: number;
  score: number;
}

const lastAnchor = new Map<string, AnchorMemory>();

export function shouldAnchor(
  previous: AnchorMemory | undefined,
  score: number,
  now: number,
  interval: number = CONFIG.ONCHAIN_ANCHOR_INTERVAL
): "first" | "interval" | "band" | null {
  if (!previous) return "first";
  if (now - previous.at >= interval) return "interval";
  if (crossedBand(previous.score, score)) return "band";
  return null;
}

/** Tests need to start each case from a fresh anchoring memory. */
export function resetAnchorMemory(): void {
  lastAnchor.clear();
}

/**
 * After a restart the engine has no memory of what it anchored, so the
 * dashboard would show an empty on-chain record until the next write. One
 * read per wallet, once, restores the tail from the chain itself — which
 * is, after all, the point of having put it there.
 */
async function hydrateAnchors(
  program: ReturnType<typeof getProgram>,
  wallet: PublicKey
): Promise<void> {
  const address = wallet.toBase58();
  if (hasAnchors(address)) return;

  // No anchors known means a wallet the engine has not seen this process —
  // or one removed and added back, whose old memory would otherwise decide
  // when its next snapshot is due.
  lastAnchor.delete(address);

  try {
    const reporter = program.provider.publicKey!;
    const snapshots = await fetchWalletSnapshots(program, wallet, reporter);
    const records: AnchorRecord[] = snapshots.map((s) => ({
      wallet: s.wallet,
      reporter: s.reporter,
      riskScore: s.riskScore,
      timestamp: s.timestamp,
      valueUsd: s.valueUsd,
      varUsd: s.varUsd,
      pda: s.publicKey,
      // The signature is not stored on-chain; the account address is the
      // durable identifier, and explorers resolve it directly.
      signature: "",
      breached: false,
    }));
    seedAnchors(address, records);

    const latest = records[records.length - 1];
    if (latest) {
      lastAnchor.set(address, {
        at: latest.timestamp * 1000,
        score: latest.riskScore,
      });
    }
    if (records.length) {
      console.log(
        `⛓️  Restored ${records.length} on-chain snapshot(s) for ` +
          `${address.slice(0, 8)}…`
      );
    }
  } catch (err) {
    // Not fatal: the next anchor still lands, and the chain still has the
    // history. Mark the wallet as looked-at so this is one attempt, not one
    // per tick.
    seedAnchors(address, []);
    console.warn(
      `⚠️  Could not read on-chain snapshots for ${address.slice(0, 8)}…:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

/** Historical returns keyed by SYMBOL, never by position. */
let returnsBySymbol: Record<string, number[]> = {};
/**
 * Observations per day in the historical series, measured from the data's own
 * timestamps. The feed changes granularity with the requested window, so this
 * is the difference between reporting a genuine one-day VaR and reporting a
 * one-hour figure labelled as daily.
 */
let periodsPerDay = 0;
let lastHistoryFetch = 0;
const prevPrices: Partial<PriceMap> = {};
const lastAlertTime = new Map<string, number>();
let lastStressAlertTime = 0;
let lastShockAlertTime = 0;

/**
 * setInterval fires on a schedule regardless of whether the previous callback
 * finished. A tick that refreshes history takes ~10s+ of network time, so ticks
 * used to overlap and interleave their logs and alerts. This guard makes a tick
 * that is still running skip the next slot instead.
 */
let tickInFlight = false;
let engineTimer: NodeJS.Timeout | null = null;

/**
 * The refresh runs beside the tick, not inside it. Ten assets at the feed's
 * pace — plus the backoff a public rate limit imposes — take a minute or
 * more, and a tick that waited for that overran its own interval, skipped
 * the next slot, and left the dashboard with nothing to show. Now the tick
 * publishes prices and stress at once and keeps its cadence; wallet scoring
 * starts the moment the first refresh lands, and later refreshes swap the
 * series in behind ticks that never notice.
 */
let historyRefresh: Promise<void> | null = null;

function refreshHistoryIfStale(): Promise<void> {
  const stale =
    Object.keys(returnsBySymbol).length === 0 ||
    Date.now() - lastHistoryFetch > CONFIG.HISTORY_REFRESH_INTERVAL;

  if (!stale) return Promise.resolve();
  if (historyRefresh) return historyRefresh;

  historyRefresh = refreshHistory().finally(() => {
    historyRefresh = null;
  });
  return historyRefresh;
}

async function refreshHistory() {
  console.log("🔄 Refreshing historical data...");
  const { returnsSource, failed } = await fetchAllHistories();

  const next: Record<string, number[]> = {};
  const intervals: number[] = [];

  for (const [symbol, points] of Object.entries(returnsSource)) {
    const returns = computeReturns(points.map((p) => p.price));
    if (returns.length >= 2) next[symbol] = returns;

    const interval = inferIntervalMs(points);
    if (interval) intervals.push(interval);
  }

  if (Object.keys(next).length > 0) {
    returnsBySymbol = next;

    // Take the coarsest interval across assets — the joint series can only be
    // as granular as its least granular member.
    const intervalMs = intervals.length ? Math.max(...intervals) : 0;
    periodsPerDay = intervalMs > 0 ? 86_400_000 / intervalMs : 0;

    lastHistoryFetch = Date.now();
    console.log(
      `✅ History refreshed (${Object.keys(next).join(", ")}) — ` +
        `${(intervalMs / 3_600_000).toFixed(2)}h sampling, ` +
        `${periodsPerDay.toFixed(1)} obs/day` +
        (failed.length ? ` — unavailable: ${failed.join(", ")}` : "")
    );

    // Stablecoins are left out: their variance is feed noise, and a
    // correlation of noise with anything is a number that means nothing.
    const volatile = ASSET_SYMBOLS.filter((s) => !STABLE_ASSETS.has(s));
    const { symbols, matrix } = correlationMatrix(
      returnsBySymbol,
      volatile,
      scaleLambdaToFrequency(CONFIG.VAR_LAMBDA, periodsPerDay)
    );
    updateMarket({
      correlation: {
        symbols,
        matrix,
        asOf: lastHistoryFetch,
        windowDays: CONFIG.HISTORY_DAYS,
      },
    });
  } else {
    console.warn("⚠️  History refresh produced no usable series");
  }
}

async function runTick() {
  /* =============================
     1. LIVE PRICE FETCH
  ============================= */
  const { prices, stale, fetchedAt } = await fetchLivePrices();

  console.log(
    "💹 " +
      ASSET_SYMBOLS.map((s) => `${s}: $${formatPrice(prices[s])}`).join(" | ") +
      (stale ? " (cached)" : "")
  );

  /* =============================
     2. RAPID DROP + SHOCK
  ============================= */
  const rapidDropResult = detectRapidDrops(prices, prevPrices, -3);

  for (const drop of rapidDropResult.drops) {
    console.log(
      `🔥 RAPID DROP: ${drop.symbol} → ${drop.changePercent.toFixed(2)}%`
    );
  }

  // A shock is a bigger move than a rapid drop, and gets its own alert.
  // Cooldown added: this used to fire once per symbol per tick with no limit.
  const shocks = ASSET_SYMBOLS.filter((symbol) => {
    const change = rapidDropResult.changes[symbol];
    return change !== undefined && change <= -CONFIG.SHOCK_THRESHOLD;
  });
  const marketShock = shocks.length > 0;

  if (marketShock) {
    const now = Date.now();
    for (const symbol of shocks) {
      console.log(
        `🚨 ${symbol} shock: ${rapidDropResult.changes[symbol]!.toFixed(2)}%`
      );
    }
    if (now - lastShockAlertTime >= CONFIG.ALERT_COOLDOWN) {
      const body = shocks
        .map(
          (s) =>
            `${s} dropped ${Math.abs(
              rapidDropResult.changes[s]!
            ).toFixed(2)}% → $${prices[s].toFixed(4)}`
        )
        .join("\n");
      // Only start the cooldown when the send actually landed — a failed
      // send used to suppress retries for the whole cooldown window.
      if (await sendTelegramAlert(`🚨 MARKET SHOCK DETECTED\n\n${body}`)) {
        lastShockAlertTime = now;
      }
    }
  }

  // Only seed the live window with fresh quotes — repeating a cached price
  // would read as zero volatility.
  if (!stale) {
    for (const symbol of ASSET_SYMBOLS) {
      updatePriceWindow(symbol, prices[symbol]);
      prevPrices[symbol] = prices[symbol];
    }
  }

  /* =============================
     3. HISTORY + LIVE SIGNALS
  ============================= */
  // Kicked off, not awaited — see refreshHistoryIfStale. A failure here is
  // logged by the refresh itself and leaves the previous series in place.
  refreshHistoryIfStale().catch((err) => {
    console.warn(
      "⚠️  History refresh failed:",
      err instanceof Error ? err.message : err
    );
  });

  const {
    spiking: volatilitySpiking,
    spikingAssets,
    volatility,
  } = detectVolatilitySpike(0.03);

  if (volatilitySpiking) {
    console.log(`⚡ VOLATILITY SPIKE detected: ${spikingAssets.join(", ")}`);
  }

  const correlationResult = detectCorrelationBreakdown(3);

  if (correlationResult.breakdown) {
    console.log(
      `📉 CORRELATION BREAKDOWN: ${correlationResult.fallingAssets.join(", ")} ` +
        `(${correlationResult.fallingCount} assets falling)`
    );
  }

  /* =============================
     4. MARKET STRESS SCORE
  ============================= */
  const marketStress = computeMarketStressScore(
    volatilitySpiking,
    spikingAssets,
    correlationResult.breakdown,
    correlationResult.fallingAssets,
    rapidDropResult.detected,
    rapidDropResult.drops
  );

  console.log(
    `🧠 Market Stress: ${marketStress.score}/100 [${marketStress.level}]`
  );

  updateMarket({
    prices,
    changes: rapidDropResult.changes,
    pricesStale: stale,
    pricesFetchedAt: fetchedAt,
    stress: marketStress,
    volatility,
    lastTickAt: Date.now(),
    lastTickError: null,
    historyAssets: Object.keys(returnsBySymbol).length,
  });

  /* =============================
     5. MARKET-WIDE STRESS ALERT
  ============================= */
  if (marketStress.score >= 40) {
    const now = Date.now();
    if (now - lastStressAlertTime >= CONFIG.ALERT_COOLDOWN) {
      if (await sendTelegramAlert(buildStressAlertMessage(marketStress))) {
        lastStressAlertTime = now;
        console.log(`📨 Market stress alert sent (score: ${marketStress.score})`);
      }
    }
  }

  if (Object.keys(returnsBySymbol).length === 0) {
    console.log("⏳ Waiting for historical data before scoring wallets...");
    return;
  }

  /* =============================
     6. PER-WALLET RISK LOOP
  ============================= */
  const provider = createProvider();
  const program = getProgram(provider);
  const wallets = getWalletPublicKeys();
  if (wallets.length === 0) return;

  for (const walletPubkey of wallets) {
    const address = walletPubkey.toBase58();
    const label = getWalletLabel(address);

    try {
      /* 6a. REAL BALANCES */
      const portfolio = await fetchWalletPortfolio(walletPubkey);

      if (!portfolio || portfolio.length === 0) {
        console.log(`⚠️  [${label}] Portfolio fetch returned empty`);
        continue;
      }

      const holdings: AssetHolding[] = portfolio.map((asset) => {
        const price = prices[asset.symbol as AssetSymbol] ?? 0;
        return {
          symbol: asset.symbol,
          amount: asset.amount,
          price,
          value: asset.amount * price,
          weight: 0,
        };
      });

      const portfolioValue = holdings.reduce((sum, h) => sum + h.value, 0);

      if (portfolioValue <= 0) {
        console.log(`⚠️  [${label}] Wallet empty, skipping`);
        continue;
      }

      for (const h of holdings) h.weight = h.value / portfolioValue;

      /* 6b. VaR — aligned by symbol, so a missing history series drops that
             asset's weight instead of shifting every other asset's returns. */
      const weightsBySymbol = Object.fromEntries(
        holdings.filter((h) => h.weight > 0).map((h) => [h.symbol, h.weight])
      );

      const risk = calculatePortfolioRisk({
        portfolioValue,
        weightsBySymbol,
        returnsBySymbol,
        periodsPerDay,
        horizonDays: CONFIG.VAR_HORIZON_DAYS,
        confidence: CONFIG.VAR_CONFIDENCE,
        lambda: CONFIG.VAR_LAMBDA,
      });

      const { riskScore: varRisk, coverage, uncovered } = risk;

      if (uncovered.length) {
        console.log(
          `ℹ️  [${label}] No return series for ${uncovered.join(", ")} ` +
            `(${(coverage * 100).toFixed(1)}% of value covered)`
        );
      }

      /* 6c. HYBRID RISK — portfolio risk plus market context */
      const concentration = concentrationPenalty(holdings.map((h) => h.weight));
      const { penalty: concentrationRisk, maxWeight } = concentration;

      // Short-term trend from the live window of the largest holding.
      const heaviest = holdings.reduce((a, b) => (a.weight > b.weight ? a : b));
      const recentReturns = liveReturns(heaviest.symbol).slice(-5);
      const trendPenalty =
        recentReturns.length >= 2 &&
        recentReturns.reduce((a, b) => a + b, 0) < 0
          ? 5
          : 0;

      // Stress 0–100 contributes 0–25 points. The legacy flat +15 shock
      // penalty was dropped: a shock already drives the stress score to 40+,
      // so adding both counted the same event twice.
      const stressContribution = (marketStress.score / 100) * 25;

      const hybridRisk = Math.max(
        0,
        Math.min(
          100,
          varRisk + concentrationRisk + trendPenalty + stressContribution
        )
      );

      // The wallet list is snapshotted at the top of this loop, but each
      // iteration awaits RPC calls — so a DELETE can land mid-tick. Without
      // this check the loop writes metrics for a wallet that was just
      // removed, resurrecting it in the store and inflating the aggregate
      // exposure forever. Node is single-threaded, so checking immediately
      // before the write (no await in between) closes the window entirely.
      if (!hasWallet(address)) {
        console.log(`⏭️  [${label}] Removed mid-tick — discarding result`);
        continue;
      }

      updateMetrics({
        address,
        label,
        risk: hybridRisk,
        portfolio: portfolioValue,
        breakdown: {
          var: varRisk,
          concentration: concentrationRisk,
          stress: stressContribution,
          trend: trendPenalty,
        },
        varUsd: risk.headlineVarUsd,
        esUsd: risk.headlineEsUsd,
        model: {
          headline: risk.headlineModel,
          horizonDays: risk.horizonDays,
          confidence: risk.confidence,
          periodsPerDay,
          observations: risk.observations,
          independentObservations: risk.independentObservations,
          lambdaApplied: risk.lambdaApplied,
          parametric: { varUsd: risk.varUsd, esUsd: risk.esUsd },
          historical: { varUsd: risk.histVarUsd, esUsd: risk.histEsUsd },
          contributions: risk.contributions.map((c) => ({
            symbol: c.symbol,
            weight: c.weight,
            riskShare: c.riskShare,
            componentVarUsd: c.componentVarUsd,
            volHorizon: c.volHorizon,
          })),
          diversificationRatio: risk.diversificationRatio,
        },
        maxWeight,
        coverage,
        holdings,
        updatedAt: Date.now(),
      });

      console.log(
        `[${label}] ` +
          `Portfolio: $${portfolioValue.toFixed(2)} | ` +
          `Risk: ${hybridRisk.toFixed(2)}% ` +
          `(VaR: ${varRisk.toFixed(1)} [${risk.headlineModel}] + ` +
          `Conc: ${concentrationRisk.toFixed(1)} ` +
          `[${concentration.effectiveAssets.toFixed(1)} eff. assets] + ` +
          `Trend: ${trendPenalty} + ` +
          `Stress: ${stressContribution.toFixed(1)})`
      );

      /* 7. TELEGRAM ALERT */
      const shouldAlert =
        hybridRisk >= CONFIG.RISK_ALERT_THRESHOLD || marketStress.score > 40;

      if (shouldAlert) {
        const last = lastAlertTime.get(address) ?? 0;
        const now = Date.now();

        if (now - last >= CONFIG.ALERT_COOLDOWN) {
          const delivered = await sendTelegramAlert(
            buildWalletRiskAlertMessage(
              label,
              hybridRisk,
              portfolioValue,
              risk.headlineVarUsd,
              risk.headlineEsUsd,
              risk.horizonDays,
              risk.confidence,
              prices.SOL,
              holdings.find((h) => h.symbol === "SOL")?.amount ?? 0,
              marketStress
            )
          );

          if (delivered) {
            lastAlertTime.set(address, now);
            console.log(`📨 Alert sent for ${label}`);
          }
        }
      } else {
        lastAlertTime.delete(address);
      }

      /* 8. ANCHOR ON-CHAIN */
      if (!CONFIG.ENABLE_ONCHAIN_WRITES) {
        console.log(`📊 [${label}] Risk monitored (on-chain writes disabled)`);
      } else {
        await hydrateAnchors(program, walletPubkey);

        const now = Date.now();
        const reason = shouldAnchor(lastAnchor.get(address), hybridRisk, now);

        if (reason) {
          try {
            const record = await recordRiskScoreOnChain(
              program,
              walletPubkey,
              hybridRisk,
              portfolioValue,
              risk.headlineVarUsd
            );
            // Remember the attempt either way: a failed write that retried
            // every 30s would burn the reporter's balance on fees for a
            // problem — usually rent — that a retry cannot fix.
            lastAnchor.set(address, { at: now, score: hybridRisk });

            if (record && hasWallet(address)) {
              recordAnchor(record);
              console.log(
                `⛓️  [${label}] Anchored on-chain (${reason})` +
                  (getAnchors(address).length > 1 ? "" : " — first snapshot")
              );
            }
          } catch (chainErr) {
            const message =
              chainErr instanceof Error ? chainErr.message : String(chainErr);
            lastAnchor.set(address, { at: now, score: hybridRisk });
            setOnChainError(message);
            console.error(`❌ [${label}] On-chain write failed: ${message}`);
          }
        }
      }
    } catch (walletErr) {
      console.error(
        `❌ [${label}] Error:`,
        walletErr instanceof Error ? walletErr.message : walletErr
      );
    }
  }
}

async function tick() {
  if (tickInFlight) {
    console.log("⏭️  Previous tick still running — skipping this interval");
    return;
  }

  tickInFlight = true;
  try {
    await runTick();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("❌ Engine error:", message);
    updateMarket({ lastTickAt: Date.now(), lastTickError: message });
  } finally {
    tickInFlight = false;
  }
}

export function startRiskEngine() {
  console.log("🚀 Sentra Quant Engine Running\n");
  console.log(
    `   Interval: ${CONFIG.MONITOR_INTERVAL / 1000}s | ` +
      `Alert threshold: ${CONFIG.RISK_ALERT_THRESHOLD} | ` +
      `On-chain writes: ${CONFIG.ENABLE_ONCHAIN_WRITES ? "on" : "off"}\n`
  );

  // Run immediately — the dashboard used to sit empty for a full interval
  // before the first tick produced any numbers.
  void tick();
  engineTimer = setInterval(tick, CONFIG.MONITOR_INTERVAL);
}

export function stopRiskEngine() {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
}
