import type { Server } from "http";
import { startRiskEngine, stopRiskEngine } from "./engine/risk.engine";
import { startServer } from "./api/server";
import { flushRiskHistory } from "./store/metrics.store";

// An unhandled rejection anywhere in the engine used to take the whole process
// down with an unhelpful stack and no exit log.
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});

const server: Server = startServer();
startRiskEngine();

function shutdown(signal: string) {
  console.log(`\n👋 ${signal} received — shutting down`);
  stopRiskEngine();
  // Writes are batched during normal running, so the last interval of risk
  // history only reaches disk if we ask for it here.
  flushRiskHistory();
  server.close(() => process.exit(0));
  // Do not hang forever on a lingering keep-alive socket.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
