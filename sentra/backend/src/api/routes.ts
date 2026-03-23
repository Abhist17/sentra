import { Express } from "express";
import { PublicKey } from "@solana/web3.js";
import {
  createProvider,
  getProgram,
  fetchUserSnapshots,
} from "../services/blockchain.service";
import {
  addWallet,
  removeWallet,
  getWallets,
  hasWallet,
  getWalletCount,
} from "../services/wallet.registry";
import { sendTelegramAlert } from "../services/telegram.service";

// ✅ IMPORT SHARED STORE (NEW)
import {
  walletMetrics,
  getLatestMetrics,
} from "../store/metrics.store";

export function registerRoutes(app: Express) {

  /* =============================
     Health check
  ============================= */
  app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      walletsMonitored: getWalletCount(),
      timestamp: Date.now(),
    });
  });

  /* =============================
     Latest global risk & portfolio
  ============================= */
  app.get("/risk", (_, res) => {
    res.json({ risk: getLatestMetrics().risk });
  });

  app.get("/portfolio", (_, res) => {
    res.json({ portfolio: getLatestMetrics().portfolio });
  });

  /* =============================
     GET /wallets
  ============================= */
  app.get("/wallets", (_, res) => {
    const wallets = getWallets().map((w) => ({
      ...w,
      metrics: walletMetrics.get(w.address) ?? null,
    }));
    res.json({ wallets, total: wallets.length });
  });

  /* =============================
     POST /wallet/add
  ============================= */
  app.post("/wallet/add", (req, res) => {
    try {
      const { address, label } = req.body;
      if (!address) return res.status(400).json({ error: "address is required" });

      const entry = addWallet(address, label);
      res.json({
        success: true,
        message: `Now monitoring ${entry.label}`,
        wallet: entry,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : "Failed to add wallet",
      });
    }
  });

  /* =============================
     DELETE /wallet/remove
  ============================= */
  app.delete("/wallet/remove", (req, res) => {
    try {
      const { address } = req.body;
      if (!address) return res.status(400).json({ error: "address is required" });

      const removed = removeWallet(address);
      if (!removed)
        return res.status(404).json({ success: false, error: "Wallet not found" });

      walletMetrics.delete(address);

      res.json({
        success: true,
        message: `Stopped monitoring ${address}`,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : "Failed to remove wallet",
      });
    }
  });

  /* =============================
     GET /wallet/status
  ============================= */
  app.get("/wallet/status", (req, res) => {
    const address = req.query.address as string;
    if (!address)
      return res.status(400).json({ error: "address is required" });

    res.json({
      monitored: hasWallet(address),
      metrics: walletMetrics.get(address) ?? null,
    });
  });

  /* =============================
     GET /snapshots
  ============================= */
  app.get("/snapshots", async (req, res) => {
    try {
      const walletParam = req.query.wallet as string;
      if (!walletParam)
        return res.status(400).json({ error: "wallet address required" });

      const provider = createProvider();
      const program = getProgram(provider);
      const snapshots = await fetchUserSnapshots(
        program,
        new PublicKey(walletParam)
      );

      res.json({ snapshots, total: snapshots.length });
    } catch {
      res.status(500).json({ error: "Failed to fetch snapshots" });
    }
  });

  /* =============================
     GET /snapshots/chart
  ============================= */
  app.get("/snapshots/chart", async (req, res) => {
    try {
      const walletParam = req.query.wallet as string;
      if (!walletParam)
        return res.status(400).json({ error: "wallet address required" });

      const provider = createProvider();
      const program = getProgram(provider);
      const snapshots = await fetchUserSnapshots(
        program,
        new PublicKey(walletParam)
      );

      const data = snapshots.map((s: any) => ({
        time: new Date(s.timestamp * 1000).toISOString(),
        risk: s.riskScore,
      }));

      res.json({ data, total: data.length });
    } catch {
      res.status(500).json({ error: "Failed to fetch chart data" });
    }
  });

  /* =============================
     POST /test/alert
  ============================= */
  app.post("/test/alert", async (req, res) => {
    try {
      const wallets = getWallets();
      const firstWallet = wallets[0];
      const metrics = firstWallet
        ? walletMetrics.get(firstWallet.address)
        : null;

      const walletLabel = firstWallet?.label ?? "Demo Wallet";
      const riskScore = metrics?.risk?.toFixed(2) ?? "3.00";
      const portfolioValue = metrics?.portfolio
        ? `$${metrics.portfolio.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          })}`
        : "$1,326,354,419";

      await sendTelegramAlert(
        `⚠️ HIGH RISK ALERT\n\n` +
          `👛 Wallet: ${walletLabel}\n` +
          `📊 Risk Score: ${riskScore}%\n` +
          `💰 Portfolio: ${portfolioValue}\n\n` +
          `⚡ Powered by Sentra`
      );

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({
        success: false,
        error:
          err instanceof Error ? err.message : "Failed to send alert",
      });
    }
  });

  /* =============================
     POST /test/shock
  ============================= */
  app.post("/test/shock", async (_, res) => {
    try {
      await sendTelegramAlert(
        `🚨 MARKET SHOCK DETECTED\n\n` +
          `SOL dropped 3.00% in one interval\n` +
          `Current price: $192.45 (simulated)`
      );

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({
        success: false,
        error:
          err instanceof Error ? err.message : "Failed to send alert",
      });
    }
  });
}