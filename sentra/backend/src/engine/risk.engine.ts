import * as anchor from "@coral-xyz/anchor";
import {
  fetchLivePrices,
  fetchHistory,
  TRACKED_ASSETS,
} from "../services/price.service";
import { computeReturns, calculateVaR } from "../services/risk.service";
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
} from "../services/wallet.registry";
import { updateMetrics } from "../store/metrics.store";
import { CONFIG } from "../config/env";

// ─────────────────────────────────────────────
// 🟢 1. SHORT-TERM VOLATILITY TRACKER
// Stores last N prices per asset
// Computes standard deviation of returns
// ─────────────────────────────────────────────
interface VolatilityWindow {
  prices: number[];
  maxSize: number;
}

const volatilityMap: Record<string, VolatilityWindow> = {};
const VOLATILITY_WINDOW_SIZE = 5;

function updateVolatilityMap(symbol: string, price: number): void {
  if (!volatilityMap[symbol]) {
    volatilityMap[symbol] = { prices: [], maxSize: VOLATILITY_WINDOW_SIZE };
  }

  const window = volatilityMap[symbol];
  window.prices.push(price);

  // keep only the last N prices
  if (window.prices.length > window.maxSize) {
    window.prices.shift();
  }
}

function computeVolatility(symbol: string): number {
  const window = volatilityMap[symbol];
  if (!window || window.prices.length < 3) return 0;

  // compute percentage returns between consecutive prices
  const returns: number[] = [];
  for (let i = 1; i < window.prices.length; i++) {
    const prev = window.prices[i - 1];
    if (prev === 0) continue;
    returns.push((window.prices[i] - prev) / prev);
  }

  if (returns.length === 0) return 0;

  // standard deviation of returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;

  return Math.sqrt(variance);
}

function isVolatilitySpike(threshold: number = 0.03): {
  spiking: boolean;
  spikingAssets: string[];
} {
  const spikingAssets: string[] = [];

  for (const symbol of Object.keys(volatilityMap)) {
    const vol = computeVolatility(symbol);
    if (vol > threshold) {
      spikingAssets.push(symbol);
    }
  }

  return {
    spiking: spikingAssets.length > 0,
    spikingAssets,
  };
}

// ─────────────────────────────────────────────
// 🟢 2. RAPID PRICE DROP DETECTION
// Compare current price vs previous price
// Detect drops > -3% in one interval
// ─────────────────────────────────────────────
interface RapidDropResult {
  detected: boolean;
  drops: { symbol: string; changePercent: number }[];
}

function detectRapidDrops(
  currentPrices: Record<string, number>,
  previousPrices: Record<string, number>,
  dropThreshold: number = -3
): RapidDropResult {
  const drops: { symbol: string; changePercent: number }[] = [];

  for (const symbol in currentPrices) {
    if (previousPrices[symbol] && previousPrices[symbol] > 0) {
      const changePercent =
        ((currentPrices[symbol] - previousPrices[symbol]) /
          previousPrices[symbol]) *
        100;

      if (changePercent <= dropThreshold) {
        drops.push({ symbol, changePercent });
      }
    }
  }

  return {
    detected: drops.length > 0,
    drops,
  };
}

// ─────────────────────────────────────────────
// 🟢 3. CROSS-ASSET CORRELATION BREAKDOWN
// Check if multiple assets are going negative
// together → systemic risk
// ─────────────────────────────────────────────
interface CorrelationBreakdownResult {
  breakdown: boolean;
  fallingAssets: string[];
  fallingCount: number;
}

function detectCorrelationBreakdown(
  cachedReturnMatrix: number[][],
  assetSymbols: string[],
  lookback: number = 3,
  minFallingAssets: number = 3
): CorrelationBreakdownResult {
  const fallingAssets: string[] = [];

  for (let i = 0; i < cachedReturnMatrix.length; i++) {
    const returns = cachedReturnMatrix[i];
    if (!returns || returns.length < lookback) continue;

    // check if the last `lookback` returns are all negative
    const recentReturns = returns.slice(-lookback);
    const avgReturn =
      recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;

    if (avgReturn < 0) {
      const symbol = assetSymbols[i] || `Asset_${i}`;
      fallingAssets.push(symbol);
    }
  }

  return {
    breakdown: fallingAssets.length >= minFallingAssets,
    fallingAssets,
    fallingCount: fallingAssets.length,
  };
}

// ─────────────────────────────────────────────
// 🟢 4. MARKET STRESS SCORE (0–100)
// Combine: volatility spike, correlation
// breakdown, rapid drop
// ─────────────────────────────────────────────
interface MarketStressResult {
  score: number;
  signals: string[];
  level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
}

function computeMarketStressScore(
  volatilitySpiking: boolean,
  spikingAssets: string[],
  correlationBreakdown: boolean,
  fallingAssets: string[],
  rapidDropDetected: boolean,
  drops: { symbol: string; changePercent: number }[]
): MarketStressResult {
  let score = 0;
  const signals: string[] = [];

  // volatility spike → +30
  if (volatilitySpiking) {
    score += 30;
    signals.push(`⚡ Volatility spike: ${spikingAssets.join(", ")}`);
  }

  // correlation breakdown → +30
  if (correlationBreakdown) {
    score += 30;
    signals.push(`📉 Correlation breakdown: ${fallingAssets.join(", ")} falling together`);
  }

  // rapid drop → +40
  if (rapidDropDetected) {
    score += 40;
    const dropDetails = drops
      .map((d) => `${d.symbol}: ${d.changePercent.toFixed(2)}%`)
      .join(", ");
    signals.push(`🔥 Rapid drop: ${dropDetails}`);
  }

  // cap at 100
  score = Math.min(100, score);

  // determine level
  let level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  if (score >= 70) level = "CRITICAL";
  else if (score >= 40) level = "HIGH";
  else if (score >= 20) level = "MODERATE";
  else level = "LOW";

  return { score, signals, level };
}

// ─────────────────────────────────────────────
// 🟢 5. SMART TELEGRAM ALERT BUILDER
// Explain WHY risk exists, not just the number
// ─────────────────────────────────────────────
function buildStressAlertMessage(stress: MarketStressResult): string {
  const header = `🚨 MARKET STRESS ALERT\n`;
  const scoreLine = `\nStress Score: ${stress.score}/100 [${stress.level}]\n`;
  const signalBlock = stress.signals.length > 0
    ? `\n${stress.signals.join("\n")}\n`
    : "";
  const footer = `\n→ Elevated systemic risk detected\n⚡ Powered by Sentra`;

  return `${header}${scoreLine}${signalBlock}${footer}`;
}

function buildWalletRiskAlertMessage(
  label: string,
  hybridRisk: number,
  portfolioValue: number,
  solPrice: number,
  solBalance: number,
  stress: MarketStressResult
): string {
  let message =
    `⚠️ HIGH RISK ALERT\n\n` +
    `👛 Wallet: ${label}\n` +
    `📊 Risk Score: ${hybridRisk.toFixed(2)}%\n` +
    `💰 Portfolio: $${portfolioValue.toFixed(2)}\n` +
    `📉 SOL: $${solPrice.toFixed(2)}\n` +
    `🪙 SOL Balance: ${solBalance.toFixed(4)}\n`;

  // append stress context if active
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
// 🚀 MAIN ENGINE
// ─────────────────────────────────────────────
export async function startRiskEngine() {
  console.log("🚀 Sentra Quant Engine Running\n");

  const provider   = createProvider();
  const program    = getProgram(provider);
  const connection = provider.connection;

  let cachedReturnMatrix: number[][] = [];
  let lastHistoryFetch = 0;
  let lastSolPrice     = 0;
  const prevPrices: Record<string, number> = {};

  const lastAlertTime: Map<string, number> = new Map();
  let lastStressAlertTime = 0;

  // build asset symbol array matching cachedReturnMatrix order
  const assetSymbols = Object.keys(TRACKED_ASSETS);

  setInterval(async () => {
    try {
      /* =============================
         1. LIVE PRICE FETCH
      ============================= */
      const prices: Record<string, number> = await fetchLivePrices();

      console.log(
        `💹 SOL: $${prices.SOL.toFixed(2)} | ` +
        `BONK: $${prices.BONK.toFixed(8)} | ` +
        `JUP: $${prices.JUP.toFixed(4)} | ` +
        `USDC: $${prices.USDC.toFixed(4)}`
      );

      /* =============================
         1b. UPDATE VOLATILITY MAP
      ============================= */
      for (const symbol in prices) {
        updateVolatilityMap(symbol, prices[symbol]);
      }

      /* =============================
         2. RAPID PRICE DROP DETECTION
      ============================= */
      const rapidDropResult = detectRapidDrops(prices, prevPrices, -3);

      if (rapidDropResult.detected) {
        for (const drop of rapidDropResult.drops) {
          console.log(
            `🔥 RAPID DROP: ${drop.symbol} → ${drop.changePercent.toFixed(2)}%`
          );
        }
      }

      /* =============================
         2b. MARKET SHOCK DETECTION
             (existing — kept for
              backward compat)
      ============================= */
      let marketShock = false;

      for (const symbol in prices) {
        if (prevPrices[symbol]) {
          const change =
            ((prices[symbol] - prevPrices[symbol]) / prevPrices[symbol]) * 100;

          if (change <= -CONFIG.SHOCK_THRESHOLD) {
            marketShock = true;
            console.log(`🚨 ${symbol} shock: ${change.toFixed(2)}%`);

            await sendTelegramAlert(
              `🚨 MARKET SHOCK DETECTED\n\n` +
              `${symbol} dropped ${Math.abs(change).toFixed(2)}%\n` +
              `Price: $${prices[symbol].toFixed(4)}`
            );
          }
        }
        prevPrices[symbol] = prices[symbol];
      }

      /* =============================
         3. HISTORY REFRESH
      ============================= */
      if (
        cachedReturnMatrix.length === 0 ||
        Date.now() - lastHistoryFetch > CONFIG.HISTORY_REFRESH_INTERVAL
      ) {
        console.log("🔄 Refreshing historical data...");
        const newMatrix: number[][] = [];
        const coins = Object.entries(TRACKED_ASSETS);

        for (let i = 0; i < coins.length; i++) {
          const [, coinId] = coins[i];
          try {
            await new Promise((r) => setTimeout(r, i * 2000));
            const history = await fetchHistory(coinId);
            if (history.length > 2) newMatrix.push(computeReturns(history));
          } catch {
            console.log(`⚠️  History failed for ${coinId}`);
          }
        }

        if (newMatrix.length > 0) {
          cachedReturnMatrix = newMatrix;
          lastHistoryFetch   = Date.now();
          console.log(`✅ History refreshed (${newMatrix.length} assets)`);
        }
      }

      if (cachedReturnMatrix.length === 0) {
        console.log("⏳ Waiting for historical data...");
        return;
      }

      /* =============================
         3b. VOLATILITY SPIKE CHECK
      ============================= */
      const { spiking: volatilitySpiking, spikingAssets } =
        isVolatilitySpike(0.03);

      if (volatilitySpiking) {
        console.log(
          `⚡ VOLATILITY SPIKE detected: ${spikingAssets.join(", ")}`
        );
      }

      /* =============================
         3c. CORRELATION BREAKDOWN
      ============================= */
      const correlationResult = detectCorrelationBreakdown(
        cachedReturnMatrix,
        assetSymbols,
        3,   // lookback periods
        3    // min falling assets
      );

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

      /* =============================
         5. SMART STRESS ALERT
             (market-wide, not
              per-wallet)
      ============================= */
      if (marketStress.score >= 40) {
        const now = Date.now();
        if (now - lastStressAlertTime >= CONFIG.ALERT_COOLDOWN) {
          const stressMessage = buildStressAlertMessage(marketStress);
          await sendTelegramAlert(stressMessage);
          lastStressAlertTime = now;
          console.log(`📨 Market stress alert sent (score: ${marketStress.score})`);
        }
      }

      /* =============================
         6. PER-WALLET RISK LOOP
      ============================= */
      const wallets = getWalletPublicKeys();
      if (wallets.length === 0) return;

      for (const walletPubkey of wallets) {
        const address = walletPubkey.toBase58();
        const label   = getWalletLabel(address);
        const owned   = isWalletOwned(address);

        try {
          /* ===========================
             6a. FETCH REAL BALANCES
          =========================== */
          const portfolio = await fetchWalletPortfolio(connection, walletPubkey);

          if (!portfolio || portfolio.length === 0) {
            console.log(`⚠️  [${label}] Portfolio fetch returned empty`);
            continue;
          }

          const portfolioValue = portfolio.reduce(
            (sum, asset) => sum + asset.amount * (prices[asset.symbol] ?? 0),
            0
          );

          if (portfolioValue === 0) {
            console.log(`⚠️  [${label}] Wallet empty, skipping`);
            continue;
          }

          /* ===========================
             6b. VaR CALCULATION
          =========================== */
          const weights = portfolio.map(
            (asset) =>
              (asset.amount * (prices[asset.symbol] ?? 0)) / portfolioValue
          );
          const maxWeight = Math.max(...weights);

          let concentrationRisk = 0;
          if (maxWeight > 0.5) concentrationRisk = 20;
          else if (maxWeight > 0.3) concentrationRisk = 10;

          const { riskScore: varRisk } = calculateVaR(
            portfolioValue,
            weights,
            cachedReturnMatrix
          );

          /* ===========================
             6c. HYBRID RISK
                 (Portfolio + Market)
          =========================== */
          let hybridRisk = varRisk;

          // concentration penalty
          hybridRisk += concentrationRisk;

          // legacy market shock penalty
          if (marketShock) hybridRisk += 15;

          // short-term trend from history
          const recentReturns = cachedReturnMatrix[0]?.slice(-5) || [];
          const trend = recentReturns.reduce((a, b) => a + b, 0);
          if (trend < 0) hybridRisk += 5;

          // 🟢 NEW: incorporate market stress score
          // Scale: stress 0–100 → add 0–25 points to hybrid risk
          const stressContribution = (marketStress.score / 100) * 25;
          hybridRisk += stressContribution;

          // cap
          hybridRisk = Math.min(100, hybridRisk);

          updateMetrics(hybridRisk, portfolioValue, address);

          console.log(
            `[${label}] ` +
            `Portfolio: $${portfolioValue.toFixed(2)} | ` +
            `Risk: ${hybridRisk.toFixed(2)}% ` +
            `(VaR: ${varRisk.toFixed(1)} + Conc: ${concentrationRisk} + ` +
            `Stress: ${stressContribution.toFixed(1)}) | ` +
            `SOL: ${portfolio[0].amount.toFixed(4)}`
          );

          /* ===========================
             7. TELEGRAM ALERT
                🟢 UPGRADED CONDITION:
                hybridRisk >= threshold
                OR marketStressScore > 40
          =========================== */
          const shouldAlert =
            hybridRisk >= CONFIG.RISK_ALERT_THRESHOLD ||
            marketStress.score > 40;

          if (shouldAlert) {
            const last = lastAlertTime.get(address) ?? 0;
            const now  = Date.now();

            if (now - last >= CONFIG.ALERT_COOLDOWN) {
              const alertMessage = buildWalletRiskAlertMessage(
                label,
                hybridRisk,
                portfolioValue,
                prices.SOL,
                portfolio[0].amount,
                marketStress
              );

              await sendTelegramAlert(alertMessage);
              lastAlertTime.set(address, now);
              console.log(`📨 Alert sent for ${label}`);
            }
          } else {
            lastAlertTime.delete(address);
          }

          /* ===========================
             8. RECORD ON-CHAIN
          =========================== */
          if (owned) {
            await recordRiskScoreOnChain(
              program,
              walletPubkey,
              Math.floor(hybridRisk)
            );
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
    } catch (err) {
      console.error(
        "❌ Engine error:",
        err instanceof Error ? err.message : err
      );
    }
  }, CONFIG.MONITOR_INTERVAL);
}