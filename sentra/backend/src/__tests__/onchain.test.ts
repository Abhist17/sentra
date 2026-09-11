/**
 * On-chain anchoring, off-chain.
 *
 * The program itself is covered by the Anchor suite against a validator.
 * What lives here is the engine's side of the contract: the PDA derivation
 * must match the program's seeds byte for byte, the anchoring policy decides
 * how much rent the reporter spends, and the anchor store is what the
 * dashboard reads. None of it needs a network.
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import {
  clusterFromRpcUrl,
  derivePreferencePda,
  deriveSnapshotPda,
  getProgramId,
} from "../services/blockchain.service";
import {
  riskBandIndex,
  crossedBand,
  shouldAnchor,
  resetAnchorMemory,
  RISK_BANDS,
  BAND_HYSTERESIS,
} from "../engine/risk.engine";
import {
  recordAnchor,
  seedAnchors,
  getAnchors,
  hasAnchors,
  forgetWallet,
  getOnChainState,
  setOnChainError,
} from "../store/metrics.store";
import type { AnchorRecord } from "../services/blockchain.service";

const PROGRAM = getProgramId();
const REPORTER = new PublicKey("4u8ckM2U1GBpizKKDVdnb6wfGtenUECDZCbcLMiBHpFc");
const WALLET = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const OTHER = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");

beforeEach(() => resetAnchorMemory());

// ── PDAs ─────────────────────────────────────────────────────────

test("the program id comes from the bundled IDL", () => {
  assert.equal(PROGRAM.toBase58(), "6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj");
});

test("snapshot PDAs are seeded by reporter, wallet and second", () => {
  const t = new BN(1_800_000_000);
  const [a] = deriveSnapshotPda(REPORTER, WALLET, t, PROGRAM);

  // Deterministic: the engine derives it before the write and the dashboard
  // can derive it again from the record.
  assert.equal(deriveSnapshotPda(REPORTER, WALLET, t, PROGRAM)[0].toBase58(), a.toBase58());

  // Every seed participates. A second reporter, another wallet or the next
  // second each lands on a different account, so nothing can be squatted.
  assert.notEqual(deriveSnapshotPda(OTHER, WALLET, t, PROGRAM)[0].toBase58(), a.toBase58());
  assert.notEqual(deriveSnapshotPda(REPORTER, OTHER, t, PROGRAM)[0].toBase58(), a.toBase58());
  assert.notEqual(
    deriveSnapshotPda(REPORTER, WALLET, new BN(1_800_000_001), PROGRAM)[0].toBase58(),
    a.toBase58()
  );
});

test("the timestamp seed is 8 bytes little-endian, as the program reads it", () => {
  // Hand-derive with the exact byte layout `&timestamp.to_le_bytes()` uses,
  // so a change to either side shows up here rather than as a runtime
  // ConstraintSeeds error on the first write.
  const t = 1_800_000_000;
  const le = Buffer.alloc(8);
  le.writeBigInt64LE(BigInt(t));

  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("risk_snapshot"), REPORTER.toBuffer(), WALLET.toBuffer(), le],
    PROGRAM
  );
  const [actual] = deriveSnapshotPda(REPORTER, WALLET, new BN(t), PROGRAM);
  assert.equal(actual.toBase58(), expected.toBase58());
});

test("preference PDAs are per owner", () => {
  const [a] = derivePreferencePda(WALLET, PROGRAM);
  const [b] = derivePreferencePda(OTHER, PROGRAM);
  assert.notEqual(a.toBase58(), b.toBase58());
  assert.equal(derivePreferencePda(WALLET, PROGRAM)[0].toBase58(), a.toBase58());
});

// ── Cluster naming ───────────────────────────────────────────────

test("the cluster is named from the RPC URL for explorer links", () => {
  assert.equal(clusterFromRpcUrl("https://api.devnet.solana.com"), "devnet");
  assert.equal(clusterFromRpcUrl("https://api.testnet.solana.com"), "testnet");
  assert.equal(clusterFromRpcUrl("https://api.mainnet-beta.solana.com"), "mainnet-beta");
  assert.equal(clusterFromRpcUrl("http://127.0.0.1:8899"), "localnet");
  assert.equal(clusterFromRpcUrl("http://localhost:8899"), "localnet");
  // A hosted endpoint names its cluster in the host, so links still resolve.
  assert.equal(clusterFromRpcUrl("https://devnet.helius-rpc.com/?api-key=x"), "devnet");
  assert.equal(clusterFromRpcUrl("https://rpc.example.com"), "custom");
});

// ── Anchoring policy ─────────────────────────────────────────────

test("band boundaries match the dashboard ramp", () => {
  assert.deepEqual([...RISK_BANDS], [0, 25, 45, 70]);
  assert.equal(riskBandIndex(0), 0);
  assert.equal(riskBandIndex(24.9), 0);
  assert.equal(riskBandIndex(25), 1);
  assert.equal(riskBandIndex(44.9), 1);
  assert.equal(riskBandIndex(45), 2);
  assert.equal(riskBandIndex(70), 3);
  assert.equal(riskBandIndex(100), 3);
});

test("the first reading is always anchored", () => {
  assert.equal(shouldAnchor(undefined, 12, 1_000, 60_000), "first");
});

test("within the interval and the same band, nothing is written", () => {
  const previous = { at: 1_000, score: 30 };
  assert.equal(shouldAnchor(previous, 31, 1_000 + 30_000, 60_000), null);
  // The boundary itself: exactly at the interval counts as due.
  assert.equal(shouldAnchor(previous, 31, 1_000 + 60_000, 60_000), "interval");
});

test("crossing a band anchors immediately, whichever direction", () => {
  const previous = { at: 1_000, score: 30 };
  assert.equal(shouldAnchor(previous, 47, 1_000 + 5, 60_000), "band");
  assert.equal(shouldAnchor(previous, 23, 1_000 + 5, 60_000), "band");
  // A large move inside the band is still not an event worth rent.
  assert.equal(shouldAnchor(previous, 44.9, 1_000 + 5, 60_000), null);
});

test("a crossing must clear the boundary by the hysteresis margin", () => {
  assert.equal(BAND_HYSTERESIS, 2);

  // Rising from Watch: 45.0 and 46.9 are Elevated by the ramp, but a score
  // that close to the line is noise, not a transition worth rent.
  assert.equal(crossedBand(30, 45), false);
  assert.equal(crossedBand(30, 46.9), false);
  assert.equal(crossedBand(30, 47), true);

  // Falling from Elevated: leaving 45 needs to reach 43.
  assert.equal(crossedBand(50, 44.9), false);
  assert.equal(crossedBand(50, 43.1), false);
  assert.equal(crossedBand(50, 43), true);

  // A jump straight across two bands clears the margin trivially.
  assert.equal(crossedBand(10, 80), true);
  assert.equal(crossedBand(80, 10), true);
});

test("a wallet twitching around a boundary anchors once, not every tick", () => {
  // Anchored at 44 (Watch). The price then wobbles the score across 45.
  let previous = { at: 1_000, score: 44 };
  const wobble = [45.2, 44.8, 45.4, 44.6, 45.1];
  let anchored = 0;

  for (const score of wobble) {
    if (shouldAnchor(previous, score, 1_000 + 30, 60_000)) {
      anchored++;
      previous = { at: 1_000 + 30, score };
    }
  }
  assert.equal(anchored, 0);

  // A real move into Elevated is still caught the moment it clears 47.
  assert.equal(shouldAnchor(previous, 47.5, 1_000 + 60, 60_000), "band");
});

test("the interval check wins when both apply, for an honest log line", () => {
  const previous = { at: 1_000, score: 30 };
  assert.equal(shouldAnchor(previous, 80, 1_000 + 60_000, 60_000), "interval");
});

// ── Anchor store ─────────────────────────────────────────────────

function anchor(wallet: string, timestamp: number, score = 40): AnchorRecord {
  return {
    wallet,
    reporter: REPORTER.toBase58(),
    riskScore: score,
    timestamp,
    valueUsd: 50_000,
    varUsd: 3_100,
    pda: `pda-${wallet}-${timestamp}`,
    signature: `sig-${timestamp}`,
    breached: false,
  };
}

test("anchors are kept per wallet, newest last, and bounded", () => {
  const w = "anchor-store-a";
  for (let i = 0; i < 60; i++) recordAnchor(anchor(w, 1_000 + i));

  const kept = getAnchors(w);
  assert.equal(kept.length, 50);
  assert.equal(kept[0].timestamp, 1_010);
  assert.equal(kept[kept.length - 1].timestamp, 1_059);
  assert.ok(hasAnchors(w));

  forgetWallet(w);
  assert.equal(getAnchors(w).length, 0);
  assert.equal(hasAnchors(w), false);
});

test("a successful anchor clears the last error and stamps the time", () => {
  setOnChainError("insufficient funds");
  assert.equal(getOnChainState().lastError, "insufficient funds");

  recordAnchor(anchor("anchor-store-b", 2_000));
  assert.equal(getOnChainState().lastError, null);
  assert.equal(getOnChainState().lastAnchoredAt, 2_000 * 1000);
  forgetWallet("anchor-store-b");
});

test("seeding from chain merges without duplicating what the engine wrote", () => {
  const w = "anchor-store-c";
  recordAnchor(anchor(w, 3_002));

  // A restart reads the chain: the record just written is there too, plus
  // two older ones. The engine's own copy (with its signature) is kept.
  seedAnchors(w, [
    anchor(w, 3_000),
    anchor(w, 3_001),
    { ...anchor(w, 3_002), signature: "" },
  ]);

  const kept = getAnchors(w);
  assert.deepEqual(
    kept.map((a) => a.timestamp),
    [3_000, 3_001, 3_002]
  );
  assert.equal(kept[2].signature, "sig-3002", "the live record wins");
  forgetWallet(w);
});

test("seeding an empty list still marks the wallet as looked at", () => {
  const w = "anchor-store-d";
  assert.equal(hasAnchors(w), false);
  seedAnchors(w, []);
  // So a failed or empty chain read is one attempt, not one per tick.
  assert.equal(hasAnchors(w), true);
  assert.equal(getAnchors(w).length, 0);
  forgetWallet(w);
});
