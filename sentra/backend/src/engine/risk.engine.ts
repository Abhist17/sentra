import {
  fetchLivePrices,
  fetchAllHistories,
  inferIntervalMs,
  ASSET_SYMBOLS,
  STABLE_ASSETS,
  type AssetSymbol,
  type PriceMap,
} from "../services/price.service";
import { computeReturns, calculatePortfolioRisk } from "../services/risk.service";
import { sendTelegramAlert } from "../services/telegram.service";
import {
  createProvider,
  getProgram,
  fetchWalletPortfolio,
  recordRiskScoreOnChain,
} from "../services/blockchain.service";
import {
  getWalletPublicKeys,
  getWalletLabel,
  isWalletOwned,
  hasWallet,
} from "../services/wallet.registry";
import {
  updateMetrics,
  updateMarket,
  type AssetHolding,
} from "../store/metrics.store";
import { CONFIG } from "../config/env";

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

export function detectCorrelationBreakdown(
  lookback = 3,
  minFallingAssets = 3
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

async function refreshHistoryIfStale() {
  const stale =
    Object.keys(returnsBySymbol).length === 0 ||
    Date.now() - lastHistoryFetch > CONFIG.HISTORY_REFRESH_INTERVAL;

  if (!stale) return;

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
    `💹 SOL: $${prices.SOL.toFixed(2)} | ` +
      `BONK: $${prices.BONK.toFixed(8)} | ` +
      `JUP: $${prices.JUP.toFixed(4)} | ` +
      `USDC: $${prices.USDC.toFixed(4)}` +
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
  await refreshHistoryIfStale();

  const {
    spiking: volatilitySpiking,
    spikingAssets,
    volatility,
  } = detectVolatilitySpike(0.03);

  if (volatilitySpiking) {
    console.log(`⚡ VOLATILITY SPIKE detected: ${spikingAssets.join(", ")}`);
  }

  const correlationResult = detectCorrelationBreakdown(3, 3);

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
    const owned = isWalletOwned(address);

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
      const maxWeight = Math.max(...holdings.map((h) => h.weight));

      let concentrationRisk = 0;
      if (maxWeight > 0.5) concentrationRisk = 20;
      else if (maxWeight > 0.3) concentrationRisk = 10;

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
          `Conc: ${concentrationRisk} + Trend: ${trendPenalty} + ` +
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

      /* 8. RECORD ON-CHAIN */
      if (!CONFIG.ENABLE_ONCHAIN_WRITES) {
        console.log(`📊 [${label}] Risk monitored (on-chain writes disabled)`);
      } else if (owned) {
        await recordRiskScoreOnChain(program, walletPubkey, hybridRisk);
      } else {
        console.log(
          `📊 [${label}] Risk monitored (read-only wallet, skipping on-chain write)`
        );
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
