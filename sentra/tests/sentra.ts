import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sentra } from "../target/types/sentra";
import { expect } from "chai";

/** Snapshot timestamps are checked against the cluster clock, so tests must
 *  use SECONDS. The old tests passed Date.now() (milliseconds), which is ~55k
 *  years in the future and disagreed with the backend's own unit. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("sentra", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Sentra as Program<Sentra>;
  const user = provider.wallet;

  let preferencePda: anchor.web3.PublicKey;

  const snapshotPdaFor = (timestamp: anchor.BN, owner = user.publicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("risk_snapshot"),
        owner.toBuffer(),
        timestamp.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  /**
   * `anchor test` deploys and starts the suite immediately, so the first
   * transaction could land before the program was invokable — which failed as
   * "Program is not deployed" on whichever test happened to run first.
   *
   * Two waits are needed: the account has to exist and be executable, and the
   * runtime only makes a freshly deployed program callable from the slot
   * *after* deployment, so we also let the slot advance.
   */
  async function waitForDeployment(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    while (Date.now() < deadline) {
      const info = await provider.connection.getAccountInfo(program.programId);

      if (info?.executable) {
        const deployedAt = await provider.connection.getSlot("confirmed");
        while (Date.now() < deadline) {
          const slot = await provider.connection.getSlot("confirmed");
          if (slot > deployedAt + 1) return;
          await sleep(200);
        }
      }

      await sleep(400);
    }

    throw new Error(
      `Program ${program.programId.toBase58()} was not invokable within ` +
        `${timeoutMs}ms — run \`anchor deploy\` first.`
    );
  }

  before(async () => {
    await waitForDeployment();

    [preferencePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("risk_preference"), user.publicKey.toBuffer()],
      program.programId
    );
  });

  // ------------------------------
  // Initialize Preference
  // ------------------------------
  it("initializes preference correctly", async () => {
    // The PDA survives between test runs against a persistent validator, so
    // initialize only when it is actually missing.
    const existing = await provider.connection.getAccountInfo(preferencePda);

    if (!existing) {
      await program.methods
        .initializePreferences(60)
        .accounts({
          preference: preferencePda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }

    const account = await program.account.riskPreference.fetch(preferencePda);
    expect(account.owner.toString()).to.equal(user.publicKey.toString());
    expect(account.threshold).to.be.at.most(100);
  });

  it("rejects a threshold above 100", async () => {
    const attacker = anchor.web3.Keypair.generate();
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("risk_preference"), attacker.publicKey.toBuffer()],
      program.programId
    );

    // Fund the fresh payer so the failure is the threshold check, not rent.
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    try {
      await program.methods
        .initializePreferences(120)
        .accounts({
          preference: pda,
          user: attacker.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();

      expect.fail("Should have been rejected");
    } catch (err: any) {
      expect(err.error?.errorCode?.code ?? String(err)).to.contain(
        "InvalidThreshold"
      );
    }
  });

  it("refuses to reinitialize an existing preference", async () => {
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
  it("updates threshold correctly", async () => {
    await program.methods
      .updateThreshold(70)
      .accounts({ preference: preferencePda, user: user.publicKey })
      .rpc();

    const account = await program.account.riskPreference.fetch(preferencePda);
    expect(account.threshold).to.equal(70);
  });

  it("blocks a non-owner from updating the threshold", async () => {
    const attacker = anchor.web3.Keypair.generate();

    try {
      // The PDA is seeded by the signer, so an attacker signing for someone
      // else's preference account cannot satisfy the seeds constraint.
      await program.methods
        .updateThreshold(90)
        .accounts({ preference: preferencePda, user: attacker.publicKey })
        .signers([attacker])
        .rpc();

      expect.fail("Unauthorized update should fail");
    } catch (err) {
      expect(err).to.exist;
    }

    const account = await program.account.riskPreference.fetch(preferencePda);
    expect(account.threshold).to.equal(70);
  });

  // ------------------------------
  // Record Risk Score
  // ------------------------------
  it("records a risk score and creates a snapshot", async () => {
    const timestamp = new anchor.BN(nowSeconds());
    const snapshotPda = snapshotPdaFor(timestamp);

    await program.methods
      .recordRiskScore(50, timestamp)
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const snapshot = await program.account.riskSnapshot.fetch(snapshotPda);
    expect(snapshot.riskScore).to.equal(50);
    expect(snapshot.owner.toString()).to.equal(user.publicKey.toString());
    expect(snapshot.timestamp.toNumber()).to.equal(timestamp.toNumber());

    const pref = await program.account.riskPreference.fetch(preferencePda);
    expect(pref.lastRiskScore).to.equal(50);
  });

  it("rejects a risk score above 100", async () => {
    const timestamp = new anchor.BN(nowSeconds() + 1);

    try {
      await program.methods
        .recordRiskScore(150, timestamp)
        .accounts({
          preference: preferencePda,
          snapshot: snapshotPdaFor(timestamp),
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      expect.fail("Invalid risk score should fail");
    } catch (err: any) {
      expect(err.error?.errorCode?.code ?? String(err)).to.contain(
        "InvalidRiskScore"
      );
    }
  });

  it("rejects a timestamp far from the cluster clock", async () => {
    // Guards against minting snapshots at arbitrary points in the chart.
    const timestamp = new anchor.BN(nowSeconds() + 60 * 60 * 24);

    try {
      await program.methods
        .recordRiskScore(40, timestamp)
        .accounts({
          preference: preferencePda,
          snapshot: snapshotPdaFor(timestamp),
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      expect.fail("Out-of-range timestamp should fail");
    } catch (err: any) {
      expect(err.error?.errorCode?.code ?? String(err)).to.contain(
        "TimestampOutOfRange"
      );
    }
  });

  it("derives a distinct snapshot per timestamp", async () => {
    const t1 = new anchor.BN(nowSeconds());
    const t2 = new anchor.BN(nowSeconds() + 1);

    expect(snapshotPdaFor(t1).toString()).to.not.equal(
      snapshotPdaFor(t2).toString()
    );
  });

  // ------------------------------
  // Close Snapshot
  // ------------------------------
  it("closes a snapshot and refunds its rent", async () => {
    const timestamp = new anchor.BN(nowSeconds() + 2);
    const snapshotPda = snapshotPdaFor(timestamp);

    await program.methods
      .recordRiskScore(30, timestamp)
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const rent = await provider.connection.getBalance(snapshotPda);
    expect(rent).to.be.greaterThan(0);

    await program.methods
      .closeSnapshot()
      .accounts({ snapshot: snapshotPda, user: user.publicKey })
      .rpc();

    const closed = await provider.connection.getAccountInfo(snapshotPda);
    expect(closed).to.equal(null);
  });

  it("blocks a non-owner from closing a snapshot", async () => {
    const timestamp = new anchor.BN(nowSeconds() + 3);
    const snapshotPda = snapshotPdaFor(timestamp);

    await program.methods
      .recordRiskScore(35, timestamp)
      .accounts({
        preference: preferencePda,
        snapshot: snapshotPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const attacker = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .closeSnapshot()
        .accounts({ snapshot: snapshotPda, user: attacker.publicKey })
        .signers([attacker])
        .rpc();

      expect.fail("A non-owner should not be able to close the snapshot");
    } catch (err) {
      expect(err).to.exist;
    }

    const stillThere = await provider.connection.getAccountInfo(snapshotPda);
    expect(stillThere).to.not.equal(null);
  });
});
