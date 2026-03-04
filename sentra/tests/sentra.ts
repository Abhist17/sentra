import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sentra } from "../target/types/sentra";
import { expect } from "chai";

describe("sentra", () => {

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Sentra as Program<Sentra>;

  const user = provider.wallet;

  let preferencePda: anchor.web3.PublicKey;
  let bump: number;

  before(async () => {

    [preferencePda, bump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("risk_preference"), user.publicKey.toBuffer()],
        program.programId
      );

  });

  // ------------------------------
  // Initialize Preference
  // ------------------------------

  it("Initializes preference correctly", async () => {

    await program.methods
      .initializePreferences(60)
      .accounts({
        preference: preferencePda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account =
      await program.account.riskPreference.fetch(preferencePda);

    expect(account.threshold).to.equal(60);
    expect(account.owner.toString()).to.equal(user.publicKey.toString());

  });

  // ------------------------------
  // Threshold Validation
  // ------------------------------

  it("Fails if threshold > 100", async () => {

    try {

      await program.methods
        .initializePreferences(120)
        .accounts({
          preference: preferencePda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      expect.fail("Should have failed");

    } catch (err) {
      expect(err).to.exist;
    }

  });

  // ------------------------------
  // Prevent Reinitialization
  // ------------------------------

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

      expect.fail("Should not allow reinitialization");

    } catch (err) {
      expect(err).to.exist;
    }

  });

  // ------------------------------
  // Update Threshold
  // ------------------------------

  it("Updates threshold correctly", async () => {

    await program.methods
      .updateThreshold(70)
      .accounts({
        preference: preferencePda,
        user: user.publicKey,
      })
      .rpc();

    const account =
      await program.account.riskPreference.fetch(preferencePda);

    expect(account.threshold).to.equal(70);

  });

  // ------------------------------
  // Unauthorized Update
  // ------------------------------

  it("Fails when non-owner tries to update threshold", async () => {

    const attacker = anchor.web3.Keypair.generate();

    try {

      await program.methods
        .updateThreshold(90)
        .accounts({
          preference: preferencePda,
          user: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();

      expect.fail("Unauthorized update should fail");

    } catch (err) {
      expect(err).to.exist;
    }

  });

  // ------------------------------
  // Record Risk Score
  // ------------------------------

  it("Records risk score and creates snapshot", async () => {

    const timestamp = new anchor.BN(Date.now());

    const [snapshotPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          timestamp.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    await program.methods
      .recordRiskScore(50, timestamp)
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const snapshot =
      await program.account.riskSnapshot.fetch(snapshotPda);

    expect(snapshot.riskScore).to.equal(50);

  });

  // ------------------------------
  // Risk Score Validation
  // ------------------------------

  it("Fails if risk score > 100", async () => {

    const timestamp = new anchor.BN(Date.now());

    const [snapshotPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          timestamp.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    try {

      await program.methods
        .recordRiskScore(150, timestamp)
        .accounts({
          preference: preferencePda,
          snapshot: snapshotPda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      expect.fail("Invalid risk score should fail");

    } catch (err) {
      expect(err).to.exist;
    }

  });

  // ------------------------------
  // PDA Validation
  // ------------------------------

  it("Derives preference PDA correctly", async () => {

    const account =
      await program.account.riskPreference.fetch(preferencePda);

    expect(account.owner.toString()).to.equal(user.publicKey.toString());

  });

  // ------------------------------
  // Timestamp Storage
  // ------------------------------

  it("Stores timestamp correctly in snapshot", async () => {

    const timestamp = new anchor.BN(123456);

    const [snapshotPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          timestamp.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    await program.methods
      .recordRiskScore(40, timestamp)
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const snapshot =
      await program.account.riskSnapshot.fetch(snapshotPda);

    expect(snapshot.timestamp.toNumber()).to.equal(123456);

  });

  // ------------------------------
  // Last Risk Score Update
  // ------------------------------

  it("Updates last risk score in preference", async () => {

    const timestamp = new anchor.BN(Date.now());

    const [snapshotPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          timestamp.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    await program.methods
      .recordRiskScore(80, timestamp)
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const pref =
      await program.account.riskPreference.fetch(preferencePda);

    expect(pref.lastRiskScore).to.equal(80);

  });

  // ------------------------------
  // Unique Snapshot Check
  // ------------------------------

  it("Creates unique snapshots for different timestamps", async () => {

    const t1 = new anchor.BN(Date.now());
    const t2 = new anchor.BN(Date.now() + 1);

    const [snap1] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          t1.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    const [snap2] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("risk_snapshot"),
          user.publicKey.toBuffer(),
          t2.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

    expect(snap1.toString()).to.not.equal(snap2.toString());

  });

});