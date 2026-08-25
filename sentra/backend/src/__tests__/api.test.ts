/**
 * HTTP surface tests.
 *
 * The API was previously untested end to end. These boot the real Express app
 * on an ephemeral port and exercise it over HTTP, so routing, JSON handling,
 * validation and error mapping are all covered rather than mocked.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Must be set before the config module loads. ES import bindings are hoisted
// above these assignments once compiled to CommonJS, so the server module is
// pulled in lazily inside before() rather than at the top of the file.
process.env.PORT = "0"; // ask the OS for a free port
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sentra-api-"));
process.env.RATE_LIMIT_PER_MIN = "5000";
process.env.API_KEY = "";

let server: Server;
let base: string;

before(async () => {
  const { startServer } =
    require("../api/server") as typeof import("../api/server");

  server = startServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // fetch() keeps sockets alive, and server.close() only stops NEW
  // connections — so an un-awaited close left the process holding open
  // handles at teardown. That surfaced on CI as the test runner failing the
  // whole file with "Unable to deserialize cloned data", which looks like a
  // broken test and is really a process that would not shut down.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (p: string) => fetch(`${base}${p}`);
const send = (p: string, method: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const VALID = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

// ── Reads ────────────────────────────────────────────────────────

test("GET /health reports liveness and feature flags", async () => {
  const res = await get("/health");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.walletsMonitored, "number");
  assert.equal(typeof body.engine.lastTickAt, "number");
  assert.equal(typeof body.telegram, "boolean");
  assert.equal(typeof body.onchainWrites, "boolean");
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.uptimeSeconds, "number");
});

test("GET /health stays 200 even when the engine is not ready", async () => {
  // The engine never starts in these tests, so readiness is failing. Liveness
  // must not follow it down: a platform probe that restarts the container
  // whenever the public price feed rate-limits would cycle a healthy service
  // in a loop and take the API with it.
  const res = await get("/health");

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.ready, false);
});

test("GET /ready fails with the specific checks that are failing", async () => {
  const res = await get("/ready");
  assert.equal(res.status, 503);

  const body = await res.json();
  assert.equal(body.ready, false);
  assert.ok(Array.isArray(body.failing));
  // No tick has run, so there is no history and no schedule to be on.
  for (const check of ["tickCompleted", "tickOnSchedule", "historyLoaded"]) {
    assert.ok(body.failing.includes(check), `expected ${check} to fail`);
  }
  // A tick that never ran has not errored either — absence of failure is not
  // the same as success, and the two must be reported separately.
  assert.equal(body.checks.tickSucceeded, true);
  assert.equal(body.sinceLastTick, null);
});

test("readiness checks and health checks agree", async () => {
  const [health, ready] = await Promise.all([
    get("/health").then((r) => r.json()),
    get("/ready").then((r) => r.json()),
  ]);

  assert.equal(health.ready, ready.ready);
  assert.deepEqual(health.checks, ready.checks);
});

test("GET /overview returns every section the dashboard needs", async () => {
  const res = await get("/overview");
  assert.equal(res.status, 200);

  const body = await res.json();
  for (const key of ["totals", "market", "wallets", "config", "timestamp"]) {
    assert.ok(key in body, `missing ${key}`);
  }
  assert.ok(Array.isArray(body.wallets));
  assert.equal(typeof body.totals.risk, "number");
  assert.equal(typeof body.totals.esUsd, "number");
  assert.ok(Array.isArray(body.config.trackedAssets));
  // Model parameters must reach the UI, which renders its captions from them.
  assert.equal(typeof body.config.varHorizonDays, "number");
  assert.equal(typeof body.config.varConfidence, "number");
});

test("aggregate endpoints agree with /overview", async () => {
  const [overview, risk, portfolio] = await Promise.all([
    get("/overview").then((r) => r.json()),
    get("/risk").then((r) => r.json()),
    get("/portfolio").then((r) => r.json()),
  ]);

  assert.equal(risk.risk, overview.totals.risk);
  assert.equal(portfolio.portfolio, overview.totals.portfolio);
  assert.equal(portfolio.varUsd, overview.totals.varUsd);
  assert.equal(portfolio.esUsd, overview.totals.esUsd);
});

test("GET /market and /prices expose the feed state", async () => {
  const market = await get("/market").then((r) => r.json());
  assert.ok("stress" in market);
  assert.ok("volatility" in market);
  assert.equal(typeof market.stress.score, "number");

  const prices = await get("/prices").then((r) => r.json());
  assert.ok("prices" in prices);
  assert.equal(typeof prices.stale, "boolean");
});

test("GET /wallets lists the seeded demo wallet", async () => {
  const body = await get("/wallets").then((r) => r.json());

  assert.ok(Array.isArray(body.wallets));
  assert.equal(body.total, body.wallets.length);
  assert.ok(body.wallets.some((w: { isDemo: boolean }) => w.isDemo));
});

test("GET /history requires a wallet and returns a series", async () => {
  const missing = await get("/history");
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /wallet/i);

  const ok = await get(`/history?wallet=${VALID}`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((await ok.json()).points));
});

test("GET /wallet/status reports monitoring state", async () => {
  const missing = await get("/wallet/status");
  assert.equal(missing.status, 400);

  const body = await get(`/wallet/status?address=${VALID}`).then((r) => r.json());
  assert.equal(typeof body.monitored, "boolean");
  assert.ok("metrics" in body);
});

// ── Writes ───────────────────────────────────────────────────────

test("POST /wallet/add validates the address", async () => {
  const bad = await send("/wallet/add", "POST", { address: "nonsense" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Invalid Solana address/);

  const empty = await send("/wallet/add", "POST", {});
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /address is required/);
});

test("POST /wallet/add survives a missing body", async () => {
  // Destructuring an absent body used to throw a TypeError.
  const res = await send("/wallet/add", "POST");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).success, false);
});

test("a wallet can be added, found, and removed", async () => {
  const added = await send("/wallet/add", "POST", {
    address: VALID,
    label: "Route Test",
  });
  assert.equal(added.status, 200);
  assert.match((await added.json()).message, /Route Test/);

  const status = await get(`/wallet/status?address=${VALID}`).then((r) => r.json());
  assert.equal(status.monitored, true);

  // Duplicates are refused rather than silently relabelling.
  const dup = await send("/wallet/add", "POST", { address: VALID });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /already being monitored/);

  // Query-param form: some proxies strip DELETE bodies.
  const removed = await fetch(`${base}/wallet/remove?address=${VALID}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).success, true);

  const gone = await fetch(`${base}/wallet/remove?address=${VALID}`, {
    method: "DELETE",
  });
  assert.equal(gone.status, 404);
});

test("the demo wallet cannot be removed", async () => {
  const wallets = await get("/wallets").then((r) => r.json());
  const demo = wallets.wallets.find((w: { isDemo: boolean }) => w.isDemo);

  const res = await fetch(`${base}/wallet/remove?address=${demo.address}`, {
    method: "DELETE",
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Cannot remove demo wallet/);
});

// ── Errors ───────────────────────────────────────────────────────

test("unknown routes return a JSON 404, not an HTML page", async () => {
  const res = await get("/does-not-exist");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /json/);
  assert.match((await res.json()).error, /No route for GET/);
});

test("/snapshots rejects a malformed address before touching the chain", async () => {
  const res = await get("/snapshots?wallet=nonsense");
  // 502 with a cause, rather than a bare "failed" that hides whether the
  // address or the validator was the problem.
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(body.detail, "the cause is surfaced");
});

test("/snapshots requires a wallet parameter", async () => {
  const res = await get("/snapshots");
  assert.equal(res.status, 400);
});

test("CORS headers are present for browser clients", async () => {
  const res = await get("/health");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("the private-network opt-in is advertised on preflight", async () => {
  // Without this a page served over HTTPS cannot call a local engine.
  const res = await fetch(`${base}/health`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.github.io",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Private-Network": "true",
    },
  });

  assert.equal(res.headers.get("access-control-allow-private-network"), "true");
});
