import * as anchor from "@coral-xyz/anchor";
import { fetchLivePrices, fetchHistory, TRACKED_ASSETS } from "../services/price.service";
import { computeReturns, calculateVaR } from "../services/risk.service";
import { sendTelegramAlert } from "../services/telegram.service";
import {
  createProvider,
  getProgram,
  recordRiskScoreOnChain,
} from "../services/blockchain.service";
import { updateMetrics } from "../api/routes";
import { CONFIG } from "../config/env";
export async function startRiskEngine() {
  console.log("🚀 Sentra Quant Engine Running\n");

  const provider = createProvider();
  const program = getProgram(provider);
  const connection = provider.connection;
  const user = provider.wallet.publicKey;

  let cachedReturnMatrix: number[][] = [];
  let lastHistoryFetch = 0;

  let lastPrice = 0;
  let lastAlertTime = 0;

  setInterval(async () => {
    try {
      /* =============================
         1. LIVE PRICE FETCH
      ============================= */

      const prices = await fetchLivePrices();

      const solBalance =
        (await connection.getBalance(user)) / 1e9;

      const portfolio = [
        { symbol: "SOL", amount: solBalance },
        { symbol: "BONK", amount: 0 },
        { symbol: "JUP", amount: 0 },
        { symbol: "USDC", amount: 0 },
      ];

      const portfolioValue = portfolio.reduce(
        (sum, asset) =>
          sum +
          asset.amount *
            prices[asset.symbol as keyof typeof prices],
        0
      );

      if (portfolioValue === 0) return;

      /* =============================
         2. SHOCK DETECTION
      ============================= */

      const currentPrice = prices.SOL;

      if (lastPrice !== 0) {
        const change =
          ((currentPrice - lastPrice) / lastPrice) * 100;

        if (
          change <= -CONFIG.SHOCK_THRESHOLD &&
          Date.now() - lastAlertTime >
            CONFIG.ALERT_COOLDOWN
        ) {
          await sendTelegramAlert(
            `⚠️ MARKET SHOCK\nSOL dropped ${change.toFixed(
              2
            )}%`
          );

          lastAlertTime = Date.now();
        }
      }

      lastPrice = currentPrice;

      /* =============================
         3. HISTORICAL CACHE
      ============================= */

      if (
        cachedReturnMatrix.length === 0 ||
        Date.now() - lastHistoryFetch >
          CONFIG.HISTORY_REFRESH_INTERVAL
      ) {
        console.log("Refreshing historical data...");

        const newMatrix: number[][] = [];

        for (const coinId of Object.values(TRACKED_ASSETS)) {
          try {
            const history = await fetchHistory(coinId);

            if (history.length > 2) {
              newMatrix.push(computeReturns(history));
            }
          } catch {
            console.log(`History failed for ${coinId}`);
          }
        }

        cachedReturnMatrix = newMatrix;
        lastHistoryFetch = Date.now();
      }

      if (cachedReturnMatrix.length === 0) {
        console.log("Waiting for historical data...");
        return;
      }

      /* =============================
         4. VaR CALCULATION
      ============================= */

      const weights = portfolio.map(
        (asset) =>
          (asset.amount *
            prices[asset.symbol as keyof typeof prices]) /
          portfolioValue
      );

      const { riskScore } = calculateVaR(
        portfolioValue,
        weights,
        cachedReturnMatrix
      );

      updateMetrics(riskScore, portfolioValue);

console.log(
  `Portfolio: $${portfolioValue.toFixed(2)} | Risk: ${riskScore.toFixed(2)}`
);

      /* =============================
         5. HIGH RISK ALERT
      ============================= */

      if (
        riskScore >= CONFIG.RISK_ALERT_THRESHOLD &&
        Date.now() - lastAlertTime >
          CONFIG.ALERT_COOLDOWN
      ) {
        await sendTelegramAlert(
          `⚠️ HIGH RISK\nScore: ${riskScore.toFixed(2)}`
        );

        lastAlertTime = Date.now();
      }

      /* =============================
         6. ON-CHAIN RECORD
      ============================= */

      await recordRiskScoreOnChain(
        program,
        user,
        Math.floor(riskScore)
      );
    } catch (err) {
      console.log("Engine error (ignored)");
    }
  }, CONFIG.MONITOR_INTERVAL);
}