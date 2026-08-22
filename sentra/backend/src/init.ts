/**
 * One-time setup: creates the risk-preference PDA for the server's signing
 * wallet so `record_risk_score` has somewhere to write.
 *
 * Run with `npm run init` after `anchor deploy`.
 */
import {
  createProvider,
  getProgram,
  derivePreferencePda,
  ensurePreferenceInitialized,
  loadKeypair,
} from "./services/blockchain.service";
import { CONFIG } from "./config/env";

const DEFAULT_THRESHOLD = 60;

async function main() {
  // Fail loudly and early when no signer is configured — the old script got
  // an ephemeral keypair and then failed deep inside an RPC call.
  loadKeypair();

  const provider = createProvider();
  const program = getProgram(provider);
  const user = provider.wallet.publicKey;

  console.log(`🔗 Cluster:  ${CONFIG.RPC_URL}`);
  console.log(`🔑 Wallet:   ${user.toBase58()}`);
  console.log(`📜 Program:  ${program.programId.toBase58()}`);

  const balance = await provider.connection.getBalance(user);
  if (balance === 0) {
    throw new Error(
      `Wallet ${user.toBase58()} has no SOL on ${CONFIG.RPC_URL}. ` +
        `Fund it first (\`solana airdrop 1\` on devnet/localnet).`
    );
  }

  const [preferencePda] = derivePreferencePda(user, program.programId);
  console.log(`📍 PDA:      ${preferencePda.toBase58()}`);

  await ensurePreferenceInitialized(program, user, DEFAULT_THRESHOLD);

  const preference = await (program as any).account.riskPreference.fetch(
    preferencePda
  );
  console.log(
    `✅ Ready — threshold ${preference.threshold}, ` +
      `last score ${preference.lastRiskScore}`
  );
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
