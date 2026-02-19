import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

// ------------------------------
// CONFIG
// ------------------------------

const RPC_URL = "http://127.0.0.1:8899";
const COINGECKO_API =
  "https://api.coingecko.com/api/v3/simple/price";

// Wrapped SOL mint
const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// Use native fetch (Node 18+)
const fetch = globalThis.fetch;

// Load local keypair
const keypair = anchor.web3.Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync(
        "/home/abhi/.config/solana/id.json",
        "utf-8"
      )
    )
  )
);

// ------------------------------
// Risk Logic
// ------------------------------

function computeHHI(weights: number[]): number {
  return weights.reduce((sum, w) => sum + w * w, 0);
}

// ------------------------------
// Fetch SPL Tokens
// ------------------------------

async function fetchTokenPortfolio(
  connection: Connection,
  owner: PublicKey
) {
  const tokenAccounts =
    await connection.getParsedTokenAccountsByOwner(owner, {
      programId: anchor.utils.token.TOKEN_PROGRAM_ID,
    });

  const portfolio: {
    mint: string;
    balance: number;
  }[] = [];

  for (const account of tokenAccounts.value) {
    const info = account.account.data.parsed.info;
    const amount = info.tokenAmount.uiAmount;

    if (amount && amount > 0) {
      portfolio.push({
        mint: info.mint,
        balance: amount,
      });
    }
  }

  return portfolio;
}

// ------------------------------
// Fetch Prices (CoinGecko)
// ------------------------------

async function fetchPrices(
  mints: string[]
) {
  // Map Solana mint to CoinGecko ID
  const idsMap: Record<string, string> = {
    [WSOL_MINT]: "solana",
  };

  const ids = mints
    .map((mint) => idsMap[mint])
    .filter(Boolean)
    .join(",");

  if (!ids) return {};

  const response = await fetch(
    `${COINGECKO_API}?ids=${ids}&vs_currencies=usd`
  );

  const data = await response.json();
  return data;
}

// ------------------------------
// MAIN
// ------------------------------

async function main() {
  console.log("Sentra Risk Engine Starting...\n");

  const connection = new Connection(
    RPC_URL,
    "confirmed"
  );

  const wallet = new anchor.Wallet(keypair);
  const provider =
    new anchor.AnchorProvider(
      connection,
      wallet,
      {}
    );

  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      "../target/idl/sentra.json",
      "utf-8"
    )
  );

  const program = new anchor.Program(
    idl as anchor.Idl,
    provider
  );

  const programId = program.programId;
  const user = keypair.publicKey;

  // ------------------------------
  // Fetch SOL Balance
  // ------------------------------

  const solLamports =
    await connection.getBalance(user);

  const solBalance = solLamports / 1e9;

  console.log("SOL Balance:", solBalance);

  // ------------------------------
  // Fetch SPL Tokens
  // ------------------------------

  const splPortfolio =
    await fetchTokenPortfolio(
      connection,
      user
    );

  // Combine SOL + SPL
  const portfolio = [
    { mint: WSOL_MINT, balance: solBalance },
    ...splPortfolio,
  ];

  console.log("Detected Assets:", portfolio);

  if (portfolio.length === 0) {
    console.log("No assets detected.");
    return;
  }

  // ------------------------------
  // Fetch Live Prices
  // ------------------------------

  const uniqueMints = [
    ...new Set(portfolio.map((a) => a.mint)),
  ];

  const prices = await fetchPrices(
    uniqueMints
  );

  // ------------------------------
  // Convert to USD
  // ------------------------------

  const portfolioWithUSD = portfolio.map(
    (asset) => {
      let price = 0;

      if (asset.mint === WSOL_MINT) {
        price =
          prices["solana"]?.usd || 0;
      }

      return {
        mint: asset.mint,
        usdValue:
          asset.balance * price,
      };
    }
  );

  const totalUSD =
    portfolioWithUSD.reduce(
      (sum, a) => sum + a.usdValue,
      0
    );

  const weights =
    portfolioWithUSD.map(
      (a) => a.usdValue / totalUSD
    );

  const hhi = computeHHI(weights);

  const riskScore = Math.min(
    100,
    hhi * 100
  );

  console.log(
    "Total USD Value:",
    totalUSD.toFixed(2)
  );
  console.log(
    "HHI:",
    hhi.toFixed(4)
  );
  console.log(
    "Risk Score:",
    riskScore.toFixed(2)
  );

  // ------------------------------
  // Derive PDAs
  // ------------------------------

  const [preferencePda] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("risk_preference"),
        user.toBuffer(),
      ],
      programId
    );

  const timestamp =
    Math.floor(Date.now() / 1000);

  const timestampBN =
    new anchor.BN(timestamp);

  const [snapshotPda] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("risk_snapshot"),
        user.toBuffer(),
        timestampBN.toArrayLike(
          Buffer,
          "le",
          8
        ),
      ],
      programId
    );

  // ------------------------------
  // Record On-Chain
  // ------------------------------

  console.log(
    "\nRecording risk score on-chain..."
  );

  await program.methods
    .recordRiskScore(
      Math.floor(riskScore),
      timestampBN
    )
    .accounts({
      preference: preferencePda,
      snapshot: snapshotPda,
      user: user,
      systemProgram:
        anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(
    "Risk recorded successfully."
  );
}

main().catch(console.error);
