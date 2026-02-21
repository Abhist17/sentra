import * as anchor from "@coral-xyz/anchor";
import {
  createProvider,
  getProgram,
  derivePreferencePda,
} from "./services/blockchain.service";

async function main() {
  const provider = createProvider();
  const program = getProgram(provider);

  const user = provider.wallet.publicKey;

  const [preferencePda] = derivePreferencePda(
    user,
    program.programId
  );

  console.log("Initializing threshold...");

  await program.methods
    .initializePreferences(60)
    .accounts({
      preference: preferencePda,
      user,
      systemProgram:
        anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Threshold initialized to 60");
}

main().catch(console.error);