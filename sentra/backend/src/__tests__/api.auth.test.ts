/**
 * Protection tests for the API.
 *
 * These run in their own process because the guards are configured at import
 * time — a tight rate limit here would otherwise starve every other test.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.PORT = "0";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sentra-auth-"));
process.env.API_KEY = "correct-horse-battery-staple";
process.env.RATE_LIMIT_PER_MIN = "25";

const KEY = process.env.API_KEY;
const VALID = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

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

after(() => server.close());

function add(key?: string) {
  return fetch(`${base}/wallet/add`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify({ address: VALID, label: "Auth Test" }),
  });
}

// ── API key ──────────────────────────────────────────────────────

test("write routes reject a missing key", async () => {
  const res = await add();
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /x-api-key/);
});

test("write routes reject a wrong key", async () => {
  assert.equal((await add("nope")).status, 401);
  // A prefix of the real key must not pass — the comparison is constant-time
  // over equal lengths, never a partial match.
  assert.equal((await add(KEY!.slice(0, -1))).status, 401);
  assert.equal((await add(KEY! + "x")).status, 401);
});

test("write routes accept the correct key", async () => {
  const res = await add(KEY);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
});

test("read routes stay open when a key is configured", async () => {
  // The dashboard must be able to render without shipping the secret.
  for (const route of ["/health", "/overview", "/wallets", "/market"]) {
    assert.equal((await fetch(`${base}${route}`)).status, 200, route);
  }
});

test("test-alert routes are protected too", async () => {
  const unauth = await fetch(`${base}/test/alert`, { method: "POST" });
  assert.equal(unauth.status, 401, "anyone could otherwise spam the bot");

  const authed = await fetch(`${base}/test/alert`, {
    method: "POST",
    headers: { "x-api-key": KEY! },
  });
  // Telegram is unconfigured in tests, so this reports that rather than 401.
  assert.equal(authed.status, 400);
  assert.match((await authed.json()).error, /Telegram is not configured/);
});

test("DELETE is protected as well as POST", async () => {
  const res = await fetch(`${base}/wallet/remove?address=${VALID}`, {
    method: "DELETE",
  });
  assert.equal(res.status, 401);

  const ok = await fetch(`${base}/wallet/remove?address=${VALID}`, {
    method: "DELETE",
    headers: { "x-api-key": KEY! },
  });
  assert.equal(ok.status, 200);
});

// ── Rate limiting ────────────────────────────────────────────────

test("the limiter returns 429 with a retry hint once the budget is spent", async () => {
  // Budget is 25/min for this process and some has already been used, so
  // drive well past it and assert on the transition rather than an exact count.
  const codes: number[] = [];
  for (let i = 0; i < 40; i++) {
    codes.push((await fetch(`${base}/health`)).status);
  }

  assert.ok(codes.includes(429), "the limiter must eventually engage");

  const firstLimited = codes.indexOf(429);
  assert.ok(
    codes.slice(firstLimited).every((c) => c === 429),
    "once limited it stays limited for the window"
  );

  const body = await fetch(`${base}/health`).then((r) => r.json());
  assert.equal(typeof body.retryAfter, "number");
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 60);
});
