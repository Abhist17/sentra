/**
 * Owner-side CLI: register or update your wallet's on-chain risk preference.
 *
 *   npm run preferences -- --threshold 60 --reporter <engine reporter key>
 *   npm run preferences -- --show
 *
 * Signs with the keypair the engine is configured with (SOLANA_SECRET_KEY /
 * SOLANA_KEYPAIR_PATH / ~/.config/solana/id.json), which for this command is
 * YOUR wallet, not the engine's. The preference is what turns a plain
 * snapshot into a breach event: once you name a reporter, only that key's
 * snapshots may declare your threshold crossed.
 */
import { PublicKey } from "@solana/web3.js";
import {
  createProvider,
  getProgram,
  clusterFromRpcUrl,
  fetchPreference,
  setPreferences,
  loadKeypair,
} from "./services/blockchain.service";
import { CONFIG } from "./config/env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const owner = loadKeypair();
  const provider = createProvider();
  const program = getProgram(provider);

  console.log(`🔗 Cluster:  ${clusterFromRpcUrl(CONFIG.RPC_URL)}`);
  console.log(`👛 Wallet:   ${owner.publicKey.toBase58()}`);

  const current = await fetchPreference(program, owner.publicKey);
  if (current) {
    console.log(
      `📍 Current:  threshold ${current.threshold}, reporter ${current.reporter}`
    );
  } else {
    console.log("📍 Current:  no preference registered");
  }

  if (process.argv.includes("--show")) return;

  const thresholdRaw = arg("threshold");
  const reporterRaw = arg("reporter");

  if (thresholdRaw === undefined && reporterRaw === undefined) {
    console.log();
    console.log("Usage: npm run preferences -- --threshold <0-100> --reporter <pubkey>");
    console.log("       npm run preferences -- --show");
    return;
  }

  const threshold =
    thresholdRaw !== undefined ? Number(thresholdRaw) : current?.threshold;
  if (
    threshold === undefined ||
    !Number.isInteger(threshold) ||
    threshold < 0 ||
    threshold > 100
  ) {
    throw new Error("--threshold must be an integer from 0 to 100");
  }

  const reporterKey = reporterRaw ?? current?.reporter;
  if (!reporterKey) {
    throw new Error("--reporter is required the first time (the engine's key)");
  }
  const reporter = new PublicKey(reporterKey);

  const signature = await setPreferences(program, threshold, reporter);
  console.log(
    `✅ ${current ? "Updated" : "Registered"} — threshold ${threshold}, ` +
      `reporter ${reporter.toBase58()}`
  );
  console.log(`   ${signature}`);
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
