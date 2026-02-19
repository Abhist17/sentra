import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sentra } from "../target/types/sentra";
import { assert } from "chai";

describe("sentra", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Sentra as Program<Sentra>;
  const user = provider.wallet;

  let preferencePda: anchor.web3.PublicKey;

  before(async () => {
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("risk_preference"),
        user.publicKey.toBuffer(),
      ],
      program.programId
    );
    preferencePda = pda;
  });

  it("Initializes preference correctly", async () => {
    await program.methods
      .initializePreferences(75)
      .accounts({
        preference: preferencePda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account = await program.account.riskPreference.fetch(preferencePda);

    assert.equal(account.threshold, 75);
    assert.equal(account.owner.toBase58(), user.publicKey.toBase58());
  });

  it("Fails if threshold > 100", async () => {
    try {
      await program.methods
        .initializePreferences(150)
        .accounts({
          preference: preferencePda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      assert.ok(err);
      return;
    }
    assert.fail("Should have failed for invalid threshold");
  });

  it("Updates threshold correctly", async () => {
    await program.methods
      .updateThreshold(40)
      .accounts({
        preference: preferencePda,
        user: user.publicKey,
      })
      .rpc();

    const account = await program.account.riskPreference.fetch(preferencePda);
    assert.equal(account.threshold, 40);
  });
});
