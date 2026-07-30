import express from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { CONFIG } from "../config/env";

export function startServer() {
  const app = express();

  // The frontend is deployed on a different origin (Vercel) to this API,
  // so browser calls need CORS. CORS_ORIGIN accepts "*" or a comma-separated
  // allowlist.
  const origin =
    CONFIG.CORS_ORIGIN === "*"
      ? "*"
      : CONFIG.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

  app.use(cors({ origin }));
  app.use(express.json());

  registerRoutes(app);

  // Hosts like Render/Railway inject PORT — never hardcode it.
  app.listen(CONFIG.PORT, () => {
    console.log(`🌐 API running on port ${CONFIG.PORT}`);
    console.log(`   CORS origin: ${CONFIG.CORS_ORIGIN}`);
    console.log(
      `   Write routes: ${CONFIG.API_KEY ? "API key required" : "UNPROTECTED"}`
    );
  });
}
