import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import { CONFIG } from "../config/env";

// 🔥 Toggle simulation mode
const SIMULATION_MODE = true;

// Known SPL token mint addresses (mainnet)
export const TOKEN_MINTS: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ── Dual RPC setup ───────────────────────────────────────────────
const mainnetConnection = new Connection(
  process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

const keypair = anchor.web3.Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync("/home/abhi/.config/solana/id.json", "utf-8")
    )
  )
);

export function createProvider() {
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const wallet     = new anchor.Wallet(keypair);
  const provider   = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  return provider;
}

export function getProgram(provider: anchor.AnchorProvider) {
  const idlPaths = [
    "../target/idl/sentra.json",
    "../../target/idl/sentra.json",
  ];

  for (const p of idlPaths) {
    try {
      const idl = JSON.parse(fs.readFileSync(p, "utf-8"));
      return new anchor.Program(idl as anchor.Idl, provider);
    } catch {
      continue;
    }
  }

  throw new Error("Could not find sentra.json IDL. Run `anchor build` first.");
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
  if (SIMULATION_MODE && totalBalance === 0) {
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