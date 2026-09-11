import { Express, RequestHandler, Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { CONFIG } from "../config/env";
import {
  createProvider,
  getProgram,
  getProgramId,
  getReporterPublicKey,
  clusterFromRpcUrl,
  fetchWalletSnapshots,
  fetchPreference,
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
  getAnchors,
  getOnChainState,
  forgetWallet,
} from "../store/metrics.store";
import { ASSET_SYMBOLS } from "../services/price.service";
import { whatIf } from "../engine/risk.engine";

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
     Health and readiness

     Deliberately two endpoints. /health is liveness: can this process answer
     at all. /ready is readiness: is the engine actually producing numbers a
     dashboard should believe.

     Collapsing them into one 503 would be worse than useless here. The
     engine's upstream is a rate-limited public price feed, so it degrades
     several times a day for reasons a restart cannot fix — and a platform
     health check that fails on those would cycle a perfectly healthy
     container in a loop, taking the API down with it.
  ============================= */

  /** Stale prices deliberately do not fail readiness — the engine serves the
   *  last good quotes and says so, which is degraded, not broken. */
  function readiness() {
    const market = getMarket();

    // Three intervals: one for the tick that is running, one for a tick that
    // skipped because the previous overran, and one of slack.
    const overdueAfter = CONFIG.MONITOR_INTERVAL * 3;
    const sinceLastTick = market.lastTickAt > 0 ? Date.now() - market.lastTickAt : null;

    const checks = {
      tickCompleted: market.lastTickAt > 0,
      tickSucceeded: market.lastTickError === null,
      tickOnSchedule: sinceLastTick !== null && sinceLastTick < overdueAfter,
      // Without a return series no wallet can be scored, however healthy the
      // rest of the engine looks.
      historyLoaded: market.historyAssets > 0,
    };

    const failing = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    return { ready: failing.length === 0, checks, failing, sinceLastTick, market };
  }

  /**
   * What a reader needs to verify a snapshot independently: the program, the
   * cluster it lives on, and the key that signs on this engine's behalf. The
   * RPC URL itself is deliberately not exposed — hosted endpoints carry API
   * keys in the path.
   */
  function onchainSummary() {
    const state = getOnChainState();
    // Only name a reporter when snapshots can actually be attributed to it.
    // A read-only engine runs on an ephemeral key nobody should verify against.
    const reporter = CONFIG.ENABLE_ONCHAIN_WRITES ? getReporterPublicKey() : null;

    return {
      enabled: CONFIG.ENABLE_ONCHAIN_WRITES,
      programId: getProgramId().toBase58(),
      cluster: clusterFromRpcUrl(CONFIG.RPC_URL),
      reporter: reporter ? reporter.toBase58() : null,
      anchorInterval: CONFIG.ONCHAIN_ANCHOR_INTERVAL,
      lastAnchoredAt: state.lastAnchoredAt,
      lastError: state.lastError,
    };
  }

  app.get("/health", (_req, res) => {
    const { ready, checks, market } = readiness();

    res.json({
      status: "ok",
      version: CONFIG.VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      ready,
      checks,
      walletsMonitored: getWalletCount(),
      engine: {
        lastTickAt: market.lastTickAt,
        lastTickError: market.lastTickError,
        pricesStale: market.pricesStale,
        historyAssets: market.historyAssets,
        monitorInterval: CONFIG.MONITOR_INTERVAL,
      },
      telegram: telegramConfigured(),
      onchain: onchainSummary(),
      timestamp: Date.now(),
    });
  });

  app.get("/ready", (_req, res) => {
    const { ready, checks, failing, sinceLastTick } = readiness();

    res.status(ready ? 200 : 503).json({
      ready,
      checks,
      failing,
      sinceLastTick,
      version: CONFIG.VERSION,
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
  // Anchors likewise: the panel shows a handful, /snapshots has the rest.
  const OVERVIEW_ANCHORS = 20;

  app.get("/overview", (_req, res) => {
    const market = getMarket();
    const wallets = getWallets().map((w) => ({
      ...w,
      metrics: getWalletMetrics(w.address),
      history: getRiskHistory(w.address).slice(-OVERVIEW_HISTORY_POINTS),
      anchors: getAnchors(w.address).slice(-OVERVIEW_ANCHORS),
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
        correlation: market.correlation,
        lastTickAt: market.lastTickAt,
        lastTickError: market.lastTickError,
        historyAssets: market.historyAssets,
      },
      wallets,
      config: {
        monitorInterval: CONFIG.MONITOR_INTERVAL,
        riskAlertThreshold: CONFIG.RISK_ALERT_THRESHOLD,
        varHorizonDays: CONFIG.VAR_HORIZON_DAYS,
        varConfidence: CONFIG.VAR_CONFIDENCE,
        varLambda: CONFIG.VAR_LAMBDA,
        historyDays: CONFIG.HISTORY_DAYS,
        onchain: onchainSummary(),
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
    const { portfolio, varUsd, esUsd, wallets, updatedAt } = getLatestMetrics();
    res.json({ portfolio, varUsd, esUsd, wallets, updatedAt });
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
     GET /whatif?wallet=&from=&fraction=&to=
     Re-scores the wallet's current book with a share of one position moved
     into another asset. Read-only and instant: the same series and
     arithmetic as the live score, on a hypothetical shape.
  ============================= */
  app.get("/whatif", (req, res) => {
    const address = req.query.wallet as string | undefined;
    const from = req.query.from as string | undefined;
    const to = (req.query.to as string | undefined) || "USDC";
    const fraction = Number(req.query.fraction);

    if (!address || !from) {
      res.status(400).json({ error: "wallet and from are required" });
      return;
    }
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      res.status(400).json({ error: "fraction must be between 0 and 1" });
      return;
    }
    if (!hasWallet(address)) {
      res.status(404).json({ error: "Wallet is not monitored" });
      return;
    }

    const result = whatIf(address, from.toUpperCase(), fraction, to.toUpperCase());
    if (!result) {
      res.status(409).json({
        error:
          "Cannot evaluate: the wallet has no scored book yet, does not hold " +
          "that asset, or the assets are not ones the engine prices",
      });
      return;
    }

    res.json(result);
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
     GET /onchain — how to verify a snapshot
  ============================= */
  app.get("/onchain", (_req, res) => {
    res.json(onchainSummary());
  });

  /* =============================
     GET /snapshots?wallet=&all=1 — on-chain history, read from the chain

     By default this returns only what THIS engine's reporter wrote, which
     is the verification a reader wants: "what did Sentra say, and when".
     `all=1` widens it to every reporter that has ever scored the wallet,
     each row saying who. `trusted` marks the rows from this engine's key.
  ============================= */
  const loadSnapshots = async (walletParam: string, all: boolean) => {
    assertValidAddress(walletParam);
    const program = getProgram(createProvider());
    const wallet = new PublicKey(walletParam);
    const reporter = CONFIG.ENABLE_ONCHAIN_WRITES ? getReporterPublicKey() : null;

    const snapshots = await fetchWalletSnapshots(
      program,
      wallet,
      all || !reporter ? undefined : reporter
    );

    const ours = reporter?.toBase58() ?? null;
    return snapshots.map((s) => ({
      ...s,
      trusted: ours !== null && s.reporter === ours,
    }));
  };

  app.get(
    "/snapshots",
    asyncRoute(async (req, res) => {
      const walletParam = req.query.wallet as string | undefined;
      if (!walletParam) {
        return res.status(400).json({ error: "wallet address required" });
      }
      const all = req.query.all === "1" || req.query.all === "true";

      try {
        const snapshots = await loadSnapshots(walletParam, all);
        res.json({
          snapshots,
          total: snapshots.length,
          reporter: CONFIG.ENABLE_ONCHAIN_WRITES
            ? getReporterPublicKey()?.toBase58() ?? null
            : null,
          programId: getProgramId().toBase58(),
          cluster: clusterFromRpcUrl(CONFIG.RPC_URL),
        });
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
        const snapshots = await loadSnapshots(walletParam, false);
        const data = snapshots.map((s) => ({
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
     GET /preferences?wallet= — the owner-set threshold and named reporter
  ============================= */
  app.get(
    "/preferences",
    asyncRoute(async (req, res) => {
      const walletParam = req.query.wallet as string | undefined;
      if (!walletParam) {
        return res.status(400).json({ error: "wallet address required" });
      }

      try {
        assertValidAddress(walletParam);
        const program = getProgram(createProvider());
        const preference = await fetchPreference(
          program,
          new PublicKey(walletParam)
        );
        res.json({ wallet: walletParam, preference });
      } catch (err) {
        res.status(502).json({
          error: "Failed to fetch preference",
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
          `📉 ${target.model.horizonDays}-day VaR ` +
          `(${(target.model.confidence * 100).toFixed(0)}%): ` +
          `$${target.varUsd.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          })}\n` +
          `🔻 Expected Shortfall: $${target.esUsd.toLocaleString("en-US", {
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
