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
import { updateMetrics } from "../api/routes";
import { CONFIG } from "../config/env";

export async function startRiskEngine() {
  console.log("🚀 Sentra Quant Engine Running\n");

  const provider   = createProvider();
  const program    = getProgram(provider);
  const connection = provider.connection;

  let cachedReturnMatrix: number[][] = [];
  let lastHistoryFetch = 0;
  let lastSolPrice     = 0;

  const lastAlertTime: Map<string, number> = new Map();

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
         2. MARKET SHOCK DETECTION
      ============================= */
      if (lastSolPrice !== 0) {
        const change = ((prices.SOL - lastSolPrice) / lastSolPrice) * 100;
        if (change <= -CONFIG.SHOCK_THRESHOLD) {
          console.log(`🚨 Market shock! SOL changed ${change.toFixed(2)}%`);
          await sendTelegramAlert(
            `🚨 MARKET SHOCK DETECTED\n\n` +
            `SOL dropped ${Math.abs(change).toFixed(2)}% in one interval\n` +
            `Current price: $${prices.SOL.toFixed(2)}\n\n` +
            `⚡ Sentra is monitoring all wallets for impact.`
          );
        }
      }
      lastSolPrice = prices.SOL;

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
         4. PER-WALLET RISK LOOP
      ============================= */
      const wallets = getWalletPublicKeys();
      if (wallets.length === 0) return;

      for (const walletPubkey of wallets) {
        const address = walletPubkey.toBase58();
        const label   = getWalletLabel(address);
        const owned   = isWalletOwned(address);

        try {
          /* ===========================
             5. FETCH REAL BALANCES
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
             6. VaR CALCULATION
          =========================== */
          const weights = portfolio.map(
            (asset) => (asset.amount * (prices[asset.symbol] ?? 0)) / portfolioValue
          );

          const { riskScore } = calculateVaR(portfolioValue, weights, cachedReturnMatrix);

          updateMetrics(riskScore, portfolioValue, address);

          console.log(
            `[${label}] ` +
            `Portfolio: $${portfolioValue.toFixed(2)} | ` +
            `Risk: ${riskScore.toFixed(2)}% | ` +
            `SOL: ${portfolio[0].amount.toFixed(4)}`
          );

          /* ===========================
             7. TELEGRAM ALERT
             Fires every cycle when
             risk >= threshold
          =========================== */
          if (riskScore >= CONFIG.RISK_ALERT_THRESHOLD) {
            const last = lastAlertTime.get(address) ?? 0;
            const now  = Date.now();

            if (now - last >= CONFIG.MONITOR_INTERVAL) {
              await sendTelegramAlert(
                `⚠️ HIGH RISK ALERT\n\n` +
                `👛 Wallet: ${label}\n` +
                `📊 Risk Score: ${riskScore.toFixed(2)}%\n` +
                `💰 Portfolio: $${portfolioValue.toFixed(2)}\n` +
                `📉 SOL: $${prices.SOL.toFixed(2)}\n` +
                `🪙 SOL Balance: ${portfolio[0].amount.toFixed(4)}\n\n` +
                `⚡ Powered by Sentra — real-time on-chain risk monitoring.`
              );
              lastAlertTime.set(address, now);
              console.log(`📨 Alert sent for ${label}`);
            }
          } else {
            lastAlertTime.delete(address);
          }

          /* ===========================
             8. RECORD ON-CHAIN
             Only for wallets the server
             keypair owns — skip demo/
             external wallets
          =========================== */
          if (owned) {
            await recordRiskScoreOnChain(program, walletPubkey, Math.floor(riskScore));
          } else {
            console.log(`📊 [${label}] Risk monitored (read-only wallet, skipping on-chain write)`);
          }

        } catch (walletErr) {
          console.error(
            `❌ [${label}] Error:`,
            walletErr instanceof Error ? walletErr.message : walletErr
          );
        }
      }

    } catch (err) {
      console.error("❌ Engine error:", err instanceof Error ? err.message : err);
    }
  }, CONFIG.MONITOR_INTERVAL);
}