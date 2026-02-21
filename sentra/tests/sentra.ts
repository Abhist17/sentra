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
    // Derive RiskPreference PDA
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("risk_preference"),
        user.publicKey.toBuffer(),
      ],
      program.programId
    );
    preferencePda = pda;
  });

  // -----------------------------------
  // Initialize
  // -----------------------------------
  it("Initializes preference correctly", async () => {
    await program.methods
      .initializePreferences(75)
      .accounts({
        preference: preferencePda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account =
      await program.account.riskPreference.fetch(preferencePda);

    assert.equal(account.threshold, 75);
    assert.equal(
      account.owner.toBase58(),
      user.publicKey.toBase58()
    );
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

      assert.fail("Should have failed for invalid threshold");
    } catch (err) {
      assert.ok(err);
    }
  });

  it("Fails if preference already initialized", async () => {
    try {
      await program.methods
        .initializePreferences(50)
        .accounts({
          preference: preferencePda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      assert.fail("Reinitialization should fail");
    } catch (err) {
      assert.ok(err);
    }
  });

  // -----------------------------------
  // Update Threshold
  // -----------------------------------
  it("Updates threshold correctly", async () => {
    await program.methods
      .updateThreshold(40)
      .accounts({
        preference: preferencePda,
        user: user.publicKey,
      })
      .rpc();

    const account =
      await program.account.riskPreference.fetch(preferencePda);

    assert.equal(account.threshold, 40);
  });

  it("Fails when non-owner tries to update threshold", async () => {
    const attacker = anchor.web3.Keypair.generate();

    // Airdrop SOL to attacker
    const signature = await provider.connection.requestAirdrop(
      attacker.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(signature);

    try {
      await program.methods
        .updateThreshold(10)
        .accounts({
          preference: preferencePda,
          user: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();

      assert.fail("Unauthorized update should fail");
    } catch (err) {
      assert.ok(err);
    }
  });

  // -----------------------------------
  // Record Risk Score
  // -----------------------------------
  it("Records risk score and creates snapshot", async () => {
    const timestamp = Math.floor(Date.now() / 1000);

    const [snapshotPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          new anchor.BN(timestamp).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    await program.methods
      .recordRiskScore(60, new anchor.BN(timestamp))
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const snapshot =
      await program.account.riskSnapshot.fetch(snapshotPda);

    assert.equal(snapshot.riskScore, 60);
    assert.equal(
      snapshot.owner.toBase58(),
      user.publicKey.toBase58()
    );
  });

  it("Fails if risk score > 100", async () => {
    const timestamp = Math.floor(Date.now() / 1000) + 1000;

    const [snapshotPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          new anchor.BN(timestamp).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    try {
      await program.methods
        .recordRiskScore(150, new anchor.BN(timestamp))
        .accounts({
          preference: preferencePda,
          snapshot: snapshotPda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      assert.fail("Should fail for invalid risk score");
    } catch (err) {
      assert.ok(err);
    }
  });
});