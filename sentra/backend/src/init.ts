/**
 * Pre-flight for on-chain anchoring. Run with `npm run init` before setting
 * ENABLE_ONCHAIN_WRITES=true.
 *
 * Nothing needs creating on-chain any more — v2 of the program lets the
 * reporter write a snapshot for any wallet without a preference account. What
 * can still go wrong is environmental, so this checks each thing in turn and
 * says which failed: the program is deployed on RPC_URL, a signing key is
 * configured, and it holds enough SOL to pay for the rent it is about to
 * start spending.
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createProvider,
  getProgram,
  getProgramId,
  clusterFromRpcUrl,
  loadKeypair,
} from "./services/blockchain.service";
import { CONFIG } from "./config/env";
import { getWalletCount } from "./services/wallet.registry";

/** 8-byte discriminator + RiskSnapshot::INIT_SPACE
 *  (32 + 32 + 1 + 8 + 8 + 8 + 1). */
const SNAPSHOT_ACCOUNT_BYTES = 8 + 90;

async function main() {
  // Fail loudly and early when no signer is configured — the old script got
  // an ephemeral keypair and then failed deep inside an RPC call.
  const reporter = loadKeypair();

  const provider = createProvider();
  const program = getProgram(provider);
  const cluster = clusterFromRpcUrl(CONFIG.RPC_URL);

  console.log(`🔗 Cluster:   ${cluster} (${CONFIG.RPC_URL})`);
  console.log(`📜 Program:   ${getProgramId().toBase58()}`);
  console.log(`🔑 Reporter:  ${reporter.publicKey.toBase58()}`);
  console.log();

  const programAccount = await provider.connection.getAccountInfo(
    program.programId
  );
  if (!programAccount?.executable) {
    throw new Error(
      `Program ${program.programId.toBase58()} is not deployed on ${cluster}. ` +
        `Run \`anchor deploy --provider.cluster ${cluster}\` first.`
    );
  }
  console.log("✅ Program is deployed and executable");

  const balance = await provider.connection.getBalance(reporter.publicKey);
  const rent = await provider.connection.getMinimumBalanceForRentExemption(
    SNAPSHOT_ACCOUNT_BYTES
  );

  const wallets = getWalletCount();
  const anchorsPerDay =
    wallets * Math.floor((24 * 60 * 60 * 1000) / CONFIG.ONCHAIN_ANCHOR_INTERVAL);
  // Rent plus the signature fee; band-change anchors are extra and bursty.
  const perDay = anchorsPerDay * (rent + 5_000);

  console.log(
    `💰 Balance:   ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `(${(rent / LAMPORTS_PER_SOL).toFixed(5)} SOL rent per snapshot)`
  );
  console.log(
    `📈 Budget:    ${wallets} wallet(s) every ` +
      `${Math.round(CONFIG.ONCHAIN_ANCHOR_INTERVAL / 60_000)} min ≈ ` +
      `${anchorsPerDay} snapshot(s)/day ≈ ${(perDay / LAMPORTS_PER_SOL).toFixed(3)} SOL/day`
  );

  if (balance === 0) {
    throw new Error(
      `Reporter ${reporter.publicKey.toBase58()} has no SOL on ${cluster}. ` +
        (cluster === "mainnet-beta"
          ? "Fund it before enabling on-chain writes."
          : "Fund it first (`solana airdrop 1` on devnet/localnet).")
    );
  }
  if (balance < perDay) {
    console.warn(
      `⚠️  Less than a day of anchoring in the balance at the current ` +
        `interval. Top up, or raise ONCHAIN_ANCHOR_INTERVAL.`
    );
  }

  console.log();
  console.log(
    CONFIG.ENABLE_ONCHAIN_WRITES
      ? "✅ Ready — ENABLE_ONCHAIN_WRITES is on; the engine will anchor on its next tick."
      : "✅ Ready — set ENABLE_ONCHAIN_WRITES=true to start anchoring."
  );
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
