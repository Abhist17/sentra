import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { CONFIG } from "../config/env";

// Bundled at build time so the service works from `dist/` and from any CWD.
// Regenerate with `anchor build && cp target/idl/sentra.json backend/src/idl/`.
import IDL from "../idl/sentra.json";

// Known SPL token mint addresses (mainnet)
export const TOKEN_MINTS: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ── Dual RPC setup ───────────────────────────────────────────────
const mainnetConnection = new Connection(CONFIG.MAINNET_RPC_URL, "confirmed");

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

export function createProvider() {
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const wallet     = new anchor.Wallet(resolveSigner());
  const provider   = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  return provider;
}

export function getProgram(provider: anchor.AnchorProvider) {
  return new anchor.Program(IDL as anchor.Idl, provider);
}

/**
 * Fetches wallet portfolio (REAL + SIMULATION fallback)
 */
export async function fetchWalletPortfolio(
  _connection: Connection,
  walletAddress: PublicKey
): Promise<{ symbol: string; amount: number }[]> {

  const solRaw = await mainnetConnection.getBalance(walletAddress);
  const solBalance = solRaw / 1e9;

  const tokenBalances: Record<string, number> = {
    BONK: 0, JUP: 0, USDC: 0,
  };

  try {
    const tokenAccounts = await mainnetConnection.getParsedTokenAccountsByOwner(
      walletAddress,
      { programId: TOKEN_PROGRAM_ID }
    );

    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      const mint   = parsed?.mint as string;
      const amount = parsed?.tokenAmount?.uiAmount as number;

      for (const [symbol, mintAddress] of Object.entries(TOKEN_MINTS)) {
        if (mint === mintAddress && amount > 0) {
          tokenBalances[symbol] = amount;
        }
      }
    }
  } catch {
    console.warn("⚠️ Could not fetch SPL tokens");
  }

  // 🔥 REAL PORTFOLIO
  let portfolio = [
    { symbol: "SOL",  amount: solBalance },
    { symbol: "BONK", amount: tokenBalances.BONK },
    { symbol: "JUP",  amount: tokenBalances.JUP },
    { symbol: "USDC", amount: tokenBalances.USDC },
  ];

  const totalBalance =
    solBalance +
    tokenBalances.BONK +
    tokenBalances.JUP +
    tokenBalances.USDC;

  // 🔥 SIMULATION FALLBACK
  if (CONFIG.SIMULATION_MODE && totalBalance === 0) {
    console.log("⚠️ Using simulated portfolio for empty wallet");

    portfolio = [
      { symbol: "SOL", amount: 5 },
      { symbol: "JUP", amount: 200 },
      { symbol: "USDC", amount: 1000 },
    ];
  }

  return portfolio;
}

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

  try {
    await (program as any).account.riskPreference.fetch(preferencePda);
  } catch {
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
}

export async function recordRiskScoreOnChain(
  program: anchor.Program,
  user: PublicKey,
  riskScore: number
) {
  await ensurePreferenceInitialized(program, user);

  const timestamp   = Math.floor(Date.now() / 1000);
  const timestampBN = new anchor.BN(timestamp);

  const [preferencePda] = derivePreferencePda(user, program.programId);
  const [snapshotPda]   = deriveSnapshotPda(user, timestampBN, program.programId);

  await program.methods
    .recordRiskScore(riskScore, timestampBN)
    .accounts({
      preference: preferencePda,
      snapshot:   snapshotPda,
      user,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(
    `✅ Risk score ${riskScore} recorded on-chain for ${user
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
        offset: 8,
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