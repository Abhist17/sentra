import { Express } from "express";
import {
  createProvider,
  getProgram,
  fetchUserSnapshots,
} from "../services/blockchain.service";
import { PublicKey } from "@solana/web3.js";

let latestRisk = 0;
let latestPortfolio = 0;

/* =============================
   Update From Engine
============================= */
export function updateMetrics(risk: number, portfolio: number) {
  latestRisk = risk;
  latestPortfolio = portfolio;
}

/* =============================
   Register API Routes
============================= */
export function registerRoutes(app: Express) {
  app.get("/health", (_, res) => {
    res.json({ status: "ok" });
  });

  app.get("/risk", (_, res) => {
    res.json({ risk: latestRisk });
  });

  app.get("/portfolio", (_, res) => {
    res.json({ portfolio: latestPortfolio });
  });

  /* =============================
     Snapshot List (Multi-User)
  ============================= */
  app.get("/snapshots", async (req, res) => {
    try {
      const walletParam = req.query.wallet as string;

      if (!walletParam) {
        return res.status(400).json({
          error: "Wallet address required",
        });
      }

      const provider = createProvider();
      const program = getProgram(provider);
      const user = new PublicKey(walletParam);

      const snapshots = await fetchUserSnapshots(program, user);

      res.json({ snapshots });
    } catch {
      res.status(500).json({ error: "Failed to fetch snapshots" });
    }
  });

  /* =============================
     Chart Data (Multi-User)
  ============================= */
  app.get("/snapshots/chart", async (req, res) => {
    try {
      const walletParam = req.query.wallet as string;

      if (!walletParam) {
        return res.status(400).json({
          error: "Wallet address required",
        });
      }

      const provider = createProvider();
      const program = getProgram(provider);
      const user = new PublicKey(walletParam);

      const snapshots = await fetchUserSnapshots(program, user);

      const formatted = snapshots.map((s: any) => ({
        time: new Date(s.timestamp * 1000).toISOString(),
        risk: s.riskScore,
      }));

      res.json({ data: formatted });
    } catch {
      res.status(500).json({ error: "Failed to fetch chart data" });
    }
  });
}