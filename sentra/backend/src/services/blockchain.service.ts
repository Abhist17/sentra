import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { CONFIG } from "../config/env";
import { ASSET_SYMBOLS } from "./price.service";

// Bundled at build time so the service works from `dist/` and from any CWD.
// Regenerate with `anchor build && cp target/idl/sentra.json backend/src/idl/`.
import IDL from "../idl/sentra.json";

// Known SPL token mint addresses (mainnet)
export const TOKEN_MINTS: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const MINT_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(TOKEN_MINTS).map(([symbol, mint]) => [mint, symbol])
);

// ── Dual RPC setup ───────────────────────────────────────────────
const mainnetConnection = new Connection(CONFIG.MAINNET_RPC_URL, "confirmed");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Public Solana RPC endpoints answer bursts with 429s. Without a retry a
 * single rate limit dropped the wallet from that whole tick.
 */
async function rpcWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const retriable = /429|rate|timeout|ECONN|socket|fetch failed/i.test(
        message
      );
      if (!retriable || attempt === attempts - 1) break;
      await sleep(1000 * 2 ** attempt);
    }
  }

  throw new Error(
    `${label} failed: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

/**
 * Loads the server signing keypair, in priority order:
 *   1. SOLANA_SECRET_KEY   — base58 string or JSON byte array (use this in prod)
 *   2. SOLANA_KEYPAIR_PATH — path to a Solana CLI keypair file
 *   3. ~/.config/solana/id.json — local dev default
 *
 * Lazy + cached: nothing touches the filesystem until a signer is actually
 * needed, so read-only routes still work on a host with no keypair configured.
 */
let cachedKeypair: anchor.web3.Keypair | null = null;

/** True once a configured keypair (not an ephemeral stand-in) is loaded. */
let signerConfigured = false;

export function loadKeypair(): anchor.web3.Keypair {
  if (cachedKeypair) return cachedKeypair;

  const inline = CONFIG.SOLANA_SECRET_KEY.trim();

  if (inline) {
    try {
      const bytes = inline.startsWith("[")
        ? Uint8Array.from(JSON.parse(inline))
        : anchor.utils.bytes.bs58.decode(inline);

      cachedKeypair = anchor.web3.Keypair.fromSecretKey(bytes);
      signerConfigured = true;
      return cachedKeypair;
    } catch (err) {
      throw new Error(
        "SOLANA_SECRET_KEY is set but could not be parsed. " +
          "Expected a base58 secret key or a JSON byte array. " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  const keypairPath =
    CONFIG.SOLANA_KEYPAIR_PATH ||
    path.join(os.homedir(), ".config", "solana", "id.json");

  if (!fs.existsSync(keypairPath)) {
    throw new Error(
      `No signing keypair found. Set SOLANA_SECRET_KEY (recommended for ` +
        `deployment) or SOLANA_KEYPAIR_PATH. Looked at: ${keypairPath}`
    );
  }

  cachedKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
  );
  signerConfigured = true;

  return cachedKeypair;
}

/**
 * Reading snapshots and deriving PDAs needs a provider but no real signer.
 * When no keypair is configured we fall back to an ephemeral one so read-only
 * deployments boot cleanly — any write attempt then fails at the RPC, loudly.
 */
function resolveSigner(): anchor.web3.Keypair {
  try {
    return loadKeypair();
  } catch (err) {
    if (CONFIG.ENABLE_ONCHAIN_WRITES) throw err;

    console.warn(
      "⚠️  No signing keypair configured — running read-only. " +
        (err instanceof Error ? err.message : String(err))
    );
    return anchor.web3.Keypair.generate();
  }
}

// Provider and program are process-wide singletons. Building them per request
// opened a fresh RPC connection (and minted a throwaway keypair) on every
// call to /snapshots.
let cachedProvider: anchor.AnchorProvider | null = null;
let cachedProgram: anchor.Program | null = null;

export function createProvider(): anchor.AnchorProvider {
  if (cachedProvider) return cachedProvider;

  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(resolveSigner());
  cachedProvider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(cachedProvider);
  return cachedProvider;
}

export function getProgram(provider?: anchor.AnchorProvider): anchor.Program {
  if (cachedProgram) return cachedProgram;
  cachedProgram = new anchor.Program(
    IDL as anchor.Idl,
    provider ?? createProvider()
  );
  return cachedProgram;
}

export function getMainnetConnection() {
  return mainnetConnection;
}

// ── Portfolio ────────────────────────────────────────────────────

export interface Holding {
  symbol: string;
  amount: number;
}

/**
 * Reads real balances for `walletAddress` from mainnet.
 *
 * Note this always reads mainnet regardless of RPC_URL: RPC_URL points at the
 * cluster we WRITE snapshots to (devnet/localnet), which has no real balances.
 */
export async function fetchWalletPortfolio(
  walletAddress: PublicKey
): Promise<Holding[]> {
  const solRaw = await rpcWithRetry("getBalance", () =>
    mainnetConnection.getBalance(walletAddress)
  );
  const solBalance = solRaw / anchor.web3.LAMPORTS_PER_SOL;

  const tokenBalances: Record<string, number> = { BONK: 0, JUP: 0, USDC: 0 };

  // Token-2022 mints live under a different program id and are invisible to a
  // TOKEN_PROGRAM_ID-only query.
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const tokenAccounts = await rpcWithRetry(
        "getParsedTokenAccountsByOwner",
        () =>
          mainnetConnection.getParsedTokenAccountsByOwner(walletAddress, {
            programId,
          })
      );

      for (const { account } of tokenAccounts.value) {
        const parsed = (account.data as any).parsed?.info;
        const mint = parsed?.mint as string | undefined;
        const amount = parsed?.tokenAmount?.uiAmount as number | undefined;
        if (!mint || !Number.isFinite(amount) || !amount || amount <= 0) continue;

        const symbol = MINT_TO_SYMBOL[mint];
        // A wallet can hold the same mint across several token accounts.
        if (symbol) tokenBalances[symbol] += amount;
      }
    } catch (err) {
      console.warn(
        `⚠️  Could not fetch SPL tokens (${programId.toBase58().slice(0, 8)}…):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  let portfolio: Holding[] = [
    { symbol: "SOL", amount: solBalance },
    { symbol: "BONK", amount: tokenBalances.BONK },
    { symbol: "JUP", amount: tokenBalances.JUP },
    { symbol: "USDC", amount: tokenBalances.USDC },
  ];

  const totalBalance = portfolio.reduce((sum, h) => sum + h.amount, 0);

  // Demo fallback for an empty wallet — off unless SIMULATION_MODE is set.
  if (CONFIG.SIMULATION_MODE && totalBalance === 0) {
    console.log("⚠️  Using simulated portfolio for empty wallet");
    portfolio = [
      { symbol: "SOL", amount: 5 },
      { symbol: "JUP", amount: 200 },
      { symbol: "USDC", amount: 1000 },
    ];
  }

  return portfolio.filter((h) => ASSET_SYMBOLS.includes(h.symbol as any));
}

// ── Program PDAs & instructions ──────────────────────────────────
//
// v2 of the program separates two roles. The REPORTER — this engine's signing
// key — anchors a score for any wallet and pays the rent. The wallet's OWNER
// may register a preference naming the reporter they trust. Nothing here
// requires the scored wallet to sign anything.

/** Cluster the snapshots are written to, named for explorer links. */
export type ClusterName =
  | "mainnet-beta"
  | "devnet"
  | "testnet"
  | "localnet"
  | "custom";

export function clusterFromRpcUrl(url: string): ClusterName {
  const lower = url.toLowerCase();
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(lower)) return "localnet";
  if (lower.includes("devnet")) return "devnet";
  if (lower.includes("testnet")) return "testnet";
  if (lower.includes("mainnet")) return "mainnet-beta";
  return "custom";
}

export function getProgramId(): PublicKey {
  return new PublicKey((IDL as { address: string }).address);
}

/**
 * The key that signs snapshots, or null when the engine is running with an
 * ephemeral stand-in — in which case nothing is being anchored and the API
 * should not present a reporter for anyone to verify against.
 */
export function getReporterPublicKey(): PublicKey | null {
  if (!signerConfigured) {
    // Loading is lazy; a read-only deployment may never have tried.
    try {
      loadKeypair();
    } catch {
      return null;
    }
  }
  return cachedKeypair?.publicKey ?? null;
}

export function derivePreferencePda(owner: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("risk_preference"), owner.toBuffer()],
    programId
  );
}

export function deriveSnapshotPda(
  reporter: PublicKey,
  wallet: PublicKey,
  timestampBN: anchor.BN,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("risk_snapshot"),
      reporter.toBuffer(),
      wallet.toBuffer(),
      timestampBN.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

export interface Preference {
  owner: string;
  threshold: number;
  reporter: string;
  updatedAt: number;
}

export async function fetchPreference(
  program: anchor.Program,
  owner: PublicKey
): Promise<Preference | null> {
  const [pda] = derivePreferencePda(owner, program.programId);
  const account = await (program as any).account.riskPreference.fetchNullable(
    pda
  );
  if (!account) return null;

  return {
    owner: account.owner.toBase58(),
    threshold: account.threshold,
    reporter: account.reporter.toBase58(),
    updatedAt: account.updatedAt.toNumber(),
  };
}

/**
 * Creates or updates the provider wallet's own preference. This is the
 * owner-side instruction — run by a wallet holder from their own keypair,
 * not by the engine.
 */
export async function setPreferences(
  program: anchor.Program,
  threshold: number,
  reporter: PublicKey
): Promise<string> {
  const owner = program.provider.publicKey!;
  const existing = await fetchPreference(program, owner);

  const method = existing
    ? program.methods.updatePreferences(threshold, reporter)
    : program.methods.initializePreferences(threshold, reporter);

  return method.accounts({ owner }).rpc();
}

/**
 * Whether `wallet` has registered a preference that names OUR key. Only then
 * may the preference be passed to record_risk_score — passing it as any other
 * reporter fails with UnauthorizedReporter, and passing a non-existent
 * account fails outright. Cached: this is one RPC call per wallet, and an
 * owner changing their preference is a rare event.
 */
const PREFERENCE_TTL = 60 * 60 * 1000;
const preferenceCache = new Map<string, { usable: boolean; checkedAt: number }>();

async function preferenceUsableFor(
  program: anchor.Program,
  wallet: PublicKey,
  reporter: PublicKey
): Promise<boolean> {
  const key = wallet.toBase58();
  const cached = preferenceCache.get(key);
  if (cached && Date.now() - cached.checkedAt < PREFERENCE_TTL) {
    return cached.usable;
  }

  let usable = false;
  try {
    const preference = await fetchPreference(program, wallet);
    usable = preference !== null && preference.reporter === reporter.toBase58();
  } catch (err) {
    console.warn(
      `⚠️  Could not read preference for ${key.slice(0, 8)}…:`,
      err instanceof Error ? err.message : err
    );
  }

  preferenceCache.set(key, { usable, checkedAt: Date.now() });
  return usable;
}

/** One anchored reading, as the engine knows it the moment it lands. */
export interface AnchorRecord {
  wallet: string;
  reporter: string;
  riskScore: number;
  /** Unix seconds, as stored on-chain. */
  timestamp: number;
  /** Portfolio value when scored, USD. */
  valueUsd: number;
  /** Headline Value at Risk when scored, USD. */
  varUsd: number;
  /** Snapshot account address. */
  pda: string;
  /** Transaction signature, for an explorer link. */
  signature: string;
  /** True when the owner's preference was consulted and the score met it. */
  breached: boolean;
}

/** USD → whole cents as a u64, clamped to what the program can store. */
function toCents(usd: number): anchor.BN {
  if (!Number.isFinite(usd) || usd <= 0) return new anchor.BN(0);
  // Round to the cent before converting: BN has no fractional part, and
  // Math.round on the cents figure avoids 0.1 + 0.2 style drift.
  return new anchor.BN(Math.round(usd * 100).toString());
}

export async function recordRiskScoreOnChain(
  program: anchor.Program,
  wallet: PublicKey,
  riskScore: number,
  valueUsd = 0,
  varUsd = 0
): Promise<AnchorRecord | null> {
  const reporter = program.provider.publicKey!;

  // The program rejects anything above 100 — clamp here so a runaway blended
  // score surfaces as a capped snapshot rather than a failed transaction.
  const score = Math.max(0, Math.min(100, Math.round(riskScore)));

  const timestamp = Math.floor(Date.now() / 1000);
  const timestampBN = new anchor.BN(timestamp);

  const [snapshotPda] = deriveSnapshotPda(
    reporter,
    wallet,
    timestampBN,
    program.programId
  );

  // Snapshot PDAs are seeded by second, so two writes in the same second
  // collide on an already-initialized account.
  const existing = await program.provider.connection.getAccountInfo(
    snapshotPda
  );
  if (existing) {
    console.log(`⏭️  Snapshot for ${timestamp} already exists, skipping`);
    return null;
  }

  const withPreference = await preferenceUsableFor(program, wallet, reporter);
  const [preferencePda] = derivePreferencePda(wallet, program.programId);

  // `null` is how Anchor's client spells "no account" for an optional — it
  // substitutes the program id, which the program reads as None. The untyped
  // Program's signature predates optional accounts and refuses null, though
  // the resolver handles it; the typed client used in the Anchor tests
  // accepts it directly.
  const accounts = {
    snapshot: snapshotPda,
    preference: withPreference ? preferencePda : null,
    reporter,
  } as unknown as Record<string, PublicKey>;

  const signature = await program.methods
    .recordRiskScore(
      wallet,
      score,
      timestampBN,
      toCents(valueUsd),
      toCents(varUsd)
    )
    .accountsPartial(accounts)
    .rpc();

  let breached = false;
  if (withPreference) {
    const preference = await fetchPreference(program, wallet).catch(() => null);
    breached = preference !== null && score >= preference.threshold;
  }

  console.log(
    `⛓️  Anchored ${score} for ${wallet.toBase58().slice(0, 8)}… ` +
      `(${signature.slice(0, 8)}…)` +
      (breached ? " — BREACH" : "")
  );

  return {
    wallet: wallet.toBase58(),
    reporter: reporter.toBase58(),
    riskScore: score,
    timestamp,
    valueUsd: toCents(valueUsd).toNumber() / 100,
    varUsd: toCents(varUsd).toNumber() / 100,
    pda: snapshotPda.toBase58(),
    signature,
    breached,
  };
}

export interface OnChainSnapshot {
  publicKey: string;
  wallet: string;
  reporter: string;
  riskScore: number;
  timestamp: number;
  valueUsd: number;
  varUsd: number;
}

/**
 * Every snapshot anchored for `wallet`, oldest first. Pass `reporter` to see
 * one reporter's series only — the verification a reader actually wants is
 * "what did THIS engine say", not "what has anyone ever said".
 */
export async function fetchWalletSnapshots(
  program: anchor.Program,
  wallet: PublicKey,
  reporter?: PublicKey
): Promise<OnChainSnapshot[]> {
  const filters: { memcmp: { offset: number; bytes: string } }[] = [
    // 8-byte account discriminator, then `wallet`.
    { memcmp: { offset: 8, bytes: wallet.toBase58() } },
  ];
  if (reporter) {
    // `reporter` follows `wallet`, so it sits at 8 + 32.
    filters.push({ memcmp: { offset: 40, bytes: reporter.toBase58() } });
  }

  const snapshots = await (program as any).account.riskSnapshot.all(filters);

  return snapshots
    .map((s: any) => ({
      publicKey: s.publicKey.toBase58(),
      wallet: s.account.wallet.toBase58(),
      reporter: s.account.reporter.toBase58(),
      riskScore: s.account.riskScore,
      timestamp: s.account.timestamp.toNumber(),
      valueUsd: s.account.valueUsdCents.toNumber() / 100,
      varUsd: s.account.varUsdCents.toNumber() / 100,
    }))
    .sort((a: OnChainSnapshot, b: OnChainSnapshot) => a.timestamp - b.timestamp);
}

/** Closes a snapshot this reporter wrote and reclaims its rent. */
export async function closeSnapshotOnChain(
  program: anchor.Program,
  snapshot: PublicKey
): Promise<string> {
  return program.methods
    .closeSnapshot()
    .accountsPartial({ snapshot, reporter: program.provider.publicKey! })
    .rpc();
}
