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

export function loadKeypair(): anchor.web3.Keypair {
  if (cachedKeypair) return cachedKeypair;

  const inline = CONFIG.SOLANA_SECRET_KEY.trim();

  if (inline) {
    try {
      const bytes = inline.startsWith("[")
        ? Uint8Array.from(JSON.parse(inline))
        : anchor.utils.bytes.bs58.decode(inline);

      cachedKeypair = anchor.web3.Keypair.fromSecretKey(bytes);
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

export function derivePreferencePda(user: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("risk_preference"), user.toBuffer()],
    programId
  );
}

export function deriveSnapshotPda(
  user: PublicKey,
  timestampBN: anchor.BN,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("risk_snapshot"),
      user.toBuffer(),
      timestampBN.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

export async function ensurePreferenceInitialized(
  program: anchor.Program,
  user: PublicKey,
  defaultThreshold = 50
) {
  const [preferencePda] = derivePreferencePda(user, program.programId);

  const existing = await program.provider.connection.getAccountInfo(
    preferencePda
  );
  if (existing) return;

  console.log("Initializing preference PDA for", user.toBase58());
  await program.methods
    .initializePreferences(defaultThreshold)
    .accounts({
      preference: preferencePda,
      user,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  console.log("✅ Preference PDA initialized");
}

export async function recordRiskScoreOnChain(
  program: anchor.Program,
  user: PublicKey,
  riskScore: number
) {
  // The program rejects anything above 100 — clamp here so a runaway blended
  // score surfaces as a capped snapshot rather than a failed transaction.
  const score = Math.max(0, Math.min(100, Math.round(riskScore)));

  await ensurePreferenceInitialized(program, user);

  const timestamp = Math.floor(Date.now() / 1000);
  const timestampBN = new anchor.BN(timestamp);

  const [preferencePda] = derivePreferencePda(user, program.programId);
  const [snapshotPda] = deriveSnapshotPda(
    user,
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
    return;
  }

  await program.methods
    .recordRiskScore(score, timestampBN)
    .accounts({
      preference: preferencePda,
      snapshot: snapshotPda,
      user,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(
    `✅ Risk score ${score} recorded on-chain for ${user
      .toBase58()
      .slice(0, 8)}...`
  );
}

export async function fetchUserSnapshots(
  program: anchor.Program,
  user: PublicKey
) {
  const snapshots = await (program as any).account.riskSnapshot.all([
    {
      memcmp: {
        offset: 8, // 8-byte account discriminator, then `owner`
        bytes: user.toBase58(),
      },
    },
  ]);

  return snapshots
    .map((s: any) => ({
      publicKey: s.publicKey.toBase58(),
      riskScore: s.account.riskScore,
      timestamp: s.account.timestamp.toNumber(),
    }))
    .sort((a: any, b: any) => a.timestamp - b.timestamp);
}
