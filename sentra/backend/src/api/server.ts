import express from "express";
import { registerRoutes } from "./routes";

export function startServer() {
  const app = express();
  app.use(express.json());

  registerRoutes(app);

  const PORT = 4000;

  app.listen(PORT, () => {
    console.log(`🌐 API running on http://localhost:${PORT}`);
  });
}