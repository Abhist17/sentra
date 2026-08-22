import express from "express";
import cors from "cors";
import type { Server } from "http";
import { registerRoutes } from "./routes";
import { CONFIG } from "../config/env";

export function startServer(): Server {
  const app = express();

  // Rate limiting keys on req.ip, which is the proxy's address unless Express
  // is told to trust the X-Forwarded-For header that Render/Railway/Fly set.
  app.set("trust proxy", 1);

  // The frontend is deployed on a different origin (Vercel) to this API,
  // so browser calls need CORS. CORS_ORIGIN accepts "*" or a comma-separated
  // allowlist.
  const origin =
    CONFIG.CORS_ORIGIN === "*"
      ? "*"
      : CONFIG.CORS_ORIGIN.split(",")
          .map((o) => o.trim())
          .filter(Boolean);

  app.use(cors({ origin }));
  // Cap the body size — the API takes nothing bigger than an address + label.
  app.use(express.json({ limit: "16kb" }));

  registerRoutes(app);

  // Hosts like Render/Railway inject PORT — never hardcode it.
  const server = app.listen(CONFIG.PORT, () => {
    console.log(`🌐 API running on port ${CONFIG.PORT}`);
    console.log(`   CORS origin: ${CONFIG.CORS_ORIGIN}`);
    console.log(
      `   Write routes: ${CONFIG.API_KEY ? "API key required" : "UNPROTECTED"}`
    );
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `❌ Port ${CONFIG.PORT} is already in use — set PORT to something else.`
      );
      process.exit(1);
    }
    throw err;
  });

  return server;
}
