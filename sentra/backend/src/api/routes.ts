import { Express, RequestHandler, Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { CONFIG } from "../config/env";
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
  assertValidAddress,
} from "../services/wallet.registry";
import {
  sendTelegramAlert,
  telegramConfigured,
} from "../services/telegram.service";
import {
  walletMetrics,
  getLatestMetrics,
  getWalletMetrics,
  getRiskHistory,
  getMarket,
  forgetWallet,
} from "../store/metrics.store";
import { ASSET_SYMBOLS } from "../services/price.service";

/**
 * Guards routes that mutate state or spend resources (wallet registry writes,
 * Telegram sends). Open by default for local dev; set API_KEY in the deployed
 * environment and the routes start requiring `x-api-key`.
 */
const requireApiKey: RequestHandler = (req, res, next) => {
  if (!CONFIG.API_KEY) return next();

  if (!secretsMatch(req.header("x-api-key"), CONFIG.API_KEY)) {
    res.status(401).json({ error: "Invalid or missing x-api-key" });
    return;
  }

  next();
};

/**
 * Constant-time key comparison. A plain `!==` returns as soon as two bytes
 * differ, which leaks the shared prefix length to anyone timing the endpoint.
 */
function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // a secret worth protecting — compare it up front.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Small fixed-window limiter. The API is public by default and every request
 * to /snapshots costs an RPC call, so an unthrottled endpoint is an easy way
 * to burn a rate limit (or a bill).
 */
function rateLimiter(perMinute: number): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Buckets accumulate one entry per client IP; sweep them so the map does
  // not grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, 60_000);
  sweep.unref?.();

  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }

    bucket.count++;
    if (bucket.count > perMinute) {
      res.status(429).json({
        error: "Too many requests",
        retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

/** Wraps an async handler so a rejected promise becomes a 500, not a crash. */
const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

function readAddress(source: unknown): string {
  const address = (source as { address?: unknown })?.address;
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("address is required");
  }
  return address.trim();
}

export function registerRoutes(app: Express) {
  app.use(rateLimiter(CONFIG.RATE_LIMIT_PER_MIN));

  /* =============================
     Health check
  ============================= */
  app.get("/health", (_req, res) => {
    const market = getMarket();
    res.json({
      status: "ok",
      walletsMonitored: getWalletCount(),
      engine: {
        lastTickAt: market.lastTickAt,
        lastTickError: market.lastTickError,
        pricesStale: market.pricesStale,
        historyAssets: market.historyAssets,
      },
      telegram: telegramConfigured(),
      onchainWrites: CONFIG.ENABLE_ONCHAIN_WRITES,
      timestamp: Date.now(),
    });
  });

  /* =============================
     Single-call dashboard payload
     The UI needs prices + stress + wallets + history together; fetching them
     as four separate round-trips made the panels update out of step.
  ============================= */
  // Points of history sent per wallet. The full series stays available on
  // /history — inlining all of it here made the 10s poll grow toward a
  // megabyte once several wallets had filled their ring buffers.
  const OVERVIEW_HISTORY_POINTS = 120;

  app.get("/overview", (_req, res) => {
    const market = getMarket();
    const wallets = getWallets().map((w) => ({
      ...w,
      metrics: getWalletMetrics(w.address),
      history: getRiskHistory(w.address).slice(-OVERVIEW_HISTORY_POINTS),
    }));

    res.json({
      totals: getLatestMetrics(),
      market: {
        prices: market.prices,
        changes: market.changes,
        pricesStale: market.pricesStale,
        pricesFetchedAt: market.pricesFetchedAt,
        stress: market.stress,
        volatility: market.volatility,
        lastTickAt: market.lastTickAt,
        lastTickError: market.lastTickError,
        historyAssets: market.historyAssets,
      },
      wallets,
      config: {
        monitorInterval: CONFIG.MONITOR_INTERVAL,
        riskAlertThreshold: CONFIG.RISK_ALERT_THRESHOLD,
        onchainWrites: CONFIG.ENABLE_ONCHAIN_WRITES,
        telegram: telegramConfigured(),
        trackedAssets: ASSET_SYMBOLS,
        requiresApiKey: Boolean(CONFIG.API_KEY),
      },
      timestamp: Date.now(),
    });
  });

  /* =============================
     Latest aggregate risk & portfolio
  ============================= */
  app.get("/risk", (_req, res) => {
    const { risk, wallets, updatedAt } = getLatestMetrics();
    res.json({ risk, wallets, updatedAt });
  });

  app.get("/portfolio", (_req, res) => {
    const { portfolio, varUsd, wallets, updatedAt } = getLatestMetrics();
    res.json({ portfolio, varUsd, wallets, updatedAt });
  });

  app.get("/market", (_req, res) => {
    res.json(getMarket());
  });

  app.get("/prices", (_req, res) => {
    const market = getMarket();
    res.json({
      prices: market.prices,
      changes: market.changes,
      stale: market.pricesStale,
      fetchedAt: market.pricesFetchedAt,
    });
  });

  /* =============================
     GET /history?wallet=
     In-memory risk series. Unlike /snapshots this needs no on-chain writes,
     so the chart has data even with ENABLE_ONCHAIN_WRITES=false.
  ============================= */
  app.get("/history", (req, res) => {
    const address = req.query.wallet as string | undefined;

    if (!address) {
      res.status(400).json({ error: "wallet address required" });
      return;
    }

    res.json({
      wallet: address,
      points: getRiskHistory(address),
    });
  });

  /* =============================
     GET /wallets
  ============================= */
  app.get("/wallets", (_req, res) => {
    const wallets = getWallets().map((w) => ({
      ...w,
      metrics: walletMetrics.get(w.address) ?? null,
    }));
    res.json({ wallets, total: wallets.length });
  });

  /* =============================
     POST /wallet/add
  ============================= */
  app.post("/wallet/add", requireApiKey, (req, res) => {
    try {
      const address = readAddress(req.body);
      const label = (req.body as { label?: unknown })?.label;

      const entry = addWallet(
        address,
        typeof label === "string" ? label : undefined
      );

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
     Accepts the address in the body or as ?address= — some HTTP clients and
     proxies strip DELETE bodies entirely.
  ============================= */
  app.delete("/wallet/remove", requireApiKey, (req, res) => {
    try {
      const address =
        typeof req.query.address === "string" && req.query.address.trim()
          ? req.query.address.trim()
          : readAddress(req.body);

      const removed = removeWallet(address);
      if (!removed) {
        res.status(404).json({ success: false, error: "Wallet not found" });
        return;
      }

      forgetWallet(address);

      res.json({ success: true, message: `Stopped monitoring ${address}` });
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
    const address = req.query.address as string | undefined;
    if (!address) {
      res.status(400).json({ error: "address is required" });
      return;
    }

    res.json({
      monitored: hasWallet(address),
      metrics: getWalletMetrics(address),
      history: getRiskHistory(address),
    });
  });

  /* =============================
     GET /snapshots — on-chain history
  ============================= */
  const loadSnapshots = async (walletParam: string) => {
    assertValidAddress(walletParam);
    const program = getProgram(createProvider());
    return fetchUserSnapshots(program, new PublicKey(walletParam));
  };

  app.get(
    "/snapshots",
    asyncRoute(async (req, res) => {
      const walletParam = req.query.wallet as string | undefined;
      if (!walletParam) {
        return res.status(400).json({ error: "wallet address required" });
      }

      try {
        const snapshots = await loadSnapshots(walletParam);
        res.json({ snapshots, total: snapshots.length });
      } catch (err) {
        // The old handler swallowed the cause, so an unreachable validator and
        // a malformed address looked identical from the client.
        res.status(502).json({
          error: "Failed to fetch snapshots",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  app.get(
    "/snapshots/chart",
    asyncRoute(async (req, res) => {
      const walletParam = req.query.wallet as string | undefined;
      if (!walletParam) {
        return res.status(400).json({ error: "wallet address required" });
      }

      try {
        const snapshots = await loadSnapshots(walletParam);
        const data = snapshots.map((s: { timestamp: number; riskScore: number }) => ({
          time: new Date(s.timestamp * 1000).toISOString(),
          risk: s.riskScore,
        }));

        res.json({ data, total: data.length });
      } catch (err) {
        res.status(502).json({
          error: "Failed to fetch chart data",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  /* =============================
     POST /test/alert
     Sends the CURRENT numbers. It used to invent a $1,326,354,419 portfolio
     when no metrics existed, which made a test alert indistinguishable from
     a real one.
  ============================= */
  app.post(
    "/test/alert",
    requireApiKey,
    asyncRoute(async (_req, res) => {
      if (!telegramConfigured()) {
        return res.status(400).json({
          success: false,
          error:
            "Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
        });
      }

      const wallets = getWallets();
      const withMetrics = wallets
        .map((w) => getWalletMetrics(w.address))
        .filter((m): m is NonNullable<typeof m> => m !== null);

      const target = withMetrics.sort((a, b) => b.risk - a.risk)[0];

      const body = target
        ? `👛 Wallet: ${target.label}\n` +
          `📊 Risk Score: ${target.risk.toFixed(2)}%\n` +
          `💰 Portfolio: $${target.portfolio.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          })}\n` +
          `📉 1-day VaR (95%): $${target.varUsd.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          })}`
        : "No wallet metrics yet — the engine has not completed a tick.";

      const sent = await sendTelegramAlert(
        `🧪 SENTRA TEST ALERT\n\n${body}\n\n⚡ Powered by Sentra`
      );

      res.status(sent ? 200 : 502).json({
        success: sent,
        ...(sent ? {} : { error: "Telegram send failed — check server logs" }),
      });
    })
  );

  /* =============================
     POST /test/shock
  ============================= */
  app.post(
    "/test/shock",
    requireApiKey,
    asyncRoute(async (_req, res) => {
      if (!telegramConfigured()) {
        return res.status(400).json({
          success: false,
          error:
            "Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
        });
      }

      const market = getMarket();
      const solPrice = market.prices?.SOL;

      const sent = await sendTelegramAlert(
        `🧪 SIMULATED MARKET SHOCK\n\n` +
          `This is a test — no real shock was detected.\n` +
          (solPrice ? `Current SOL price: $${solPrice.toFixed(2)}\n` : "") +
          `\n⚡ Powered by Sentra`
      );

      res.status(sent ? 200 : 502).json({
        success: sent,
        ...(sent ? {} : { error: "Telegram send failed — check server logs" }),
      });
    })
  );

  /* =============================
     404 + error handler
  ============================= */
  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("❌ Unhandled route error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });
}
