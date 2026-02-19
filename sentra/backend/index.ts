import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";


const PROGRAM_ID = new PublicKey(
  "3hvd91mHEs4ujsWkRAaGLzkvY7VTNwpaD79is2YFZrma"
);

const RPC_URL = "http://127.0.0.1:8899";
const connection = new Connection(RPC_URL, "confirmed");


const USER_PUBLIC_KEY = new PublicKey(
  "4u8ckM2U1GBpizKKDVdnb6wfGtenUECDZCbcLMiBHpFc" // example public key
);

function computeHHI(weights: number[]): number {
  return weights.reduce((sum, w) => sum + w * w, 0);
}



async function main() {
  console.log("Sentra Risk Engine Starting...\n");

  // 1. Fetch SOL balance
  const solBalanceLamports = await connection.getBalance(USER_PUBLIC_KEY);
  const solBalance = solBalanceLamports / 1e9;

  console.log("SOL Balance:", solBalance);

  // 2. Mock token balances (for now)
  const portfolio = [
    { symbol: "SOL", value: solBalance * 100 }, // mock $100 per SOL
    { symbol: "USDC", value: 500 },
    { symbol: "BONK", value: 200 },
  ];

  const totalValue = portfolio.reduce((sum, a) => sum + a.value, 0);

  const weights = portfolio.map((a) => a.value / totalValue);

  const hhi = computeHHI(weights);

  // Normalize HHI to 0–100 scale
  const riskScore = Math.min(100, hhi * 100);

  console.log("Portfolio Value:", totalValue);
  console.log("Concentration Risk (HHI):", hhi.toFixed(4));
  console.log("Risk Score (0-100):", riskScore.toFixed(2));

  // 3. Fetch PDA (threshold)
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("risk_preference"), USER_PUBLIC_KEY.toBuffer()],
    PROGRAM_ID
  );

  const accountInfo = await connection.getAccountInfo(pda);

  if (!accountInfo) {
    console.log("No RiskPreference account found.");
    return;
  }

  const threshold = accountInfo.data[40]; // offset for threshold

  console.log("User Threshold:", threshold);

  if (riskScore > threshold) {
    console.log("ALERT: Risk threshold exceeded!");
  } else {
    console.log("Risk within acceptable range.");
  }
}

main().catch(console.error);
