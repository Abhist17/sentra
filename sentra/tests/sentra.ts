import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sentra } from "../target/types/sentra";
import { expect } from "chai";

/** Snapshot timestamps are checked against the cluster clock, so tests must
 *  use SECONDS. Date.now() is milliseconds — ~55k years in the future — and
 *  disagrees with the backend's own unit. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Each test that writes a snapshot takes a fresh second so PDAs never
 *  collide across cases, however fast the validator runs them. */
let tick = 0;
const uniqueTimestamp = () => new anchor.BN(nowSeconds() + tick++);

describe("sentra", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Sentra as Program<Sentra>;

  // The provider wallet plays the REPORTER — the engine's signing key.
  const reporter = provider.wallet;

  // A wallet being scored. It never signs anything: being scored is not
  // something a wallet has to consent to, any more than being looked at.
  const scored = anchor.web3.Keypair.generate();

  // A wallet that registers a preference and names the reporter.
  const owner = anchor.web3.Keypair.generate();

  const preferencePdaFor = (who: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("risk_preference"), who.toBuffer()],
      program.programId
    )[0];

  const snapshotPdaFor = (
    wallet: anchor.web3.PublicKey,
    timestamp: anchor.BN,
    by: anchor.web3.PublicKey = reporter.publicKey
  ) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("risk_snapshot"),
        by.toBuffer(),
        wallet.toBuffer(),
        timestamp.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  async function fund(key: anchor.web3.PublicKey, sol = 1) {
    const sig = await provider.connection.requestAirdrop(
      key,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  /**
   * Pulls the program's own events back out of a confirmed transaction.
   *
   * Polls: `.rpc()` resolves when the transaction is confirmed, but the
   * validator's transaction index can lag that by a slot, so an immediate
   * getTransaction sometimes answers null for a transaction that landed.
   */
  async function eventsOf(signature: string) {
    const deadline = Date.now() + 10_000;
    let logs: string[] | null | undefined;

    while (Date.now() < deadline) {
      const tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      logs = tx?.meta?.logMessages;
      if (logs) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(logs, `transaction ${signature} never became readable`).to.exist;
    const parser = new anchor.EventParser(program.programId, program.coder);
    return Array.from(parser.parseLogs(logs!));
  }

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
    await fund(owner.publicKey);
  });

  // ------------------------------
  // Owner: preferences
  // ------------------------------
  describe("preferences", () => {
    it("lets a wallet owner register a threshold and a trusted reporter", async () => {
      await program.methods
        .initializePreferences(60, reporter.publicKey)
        .accounts({ owner: owner.publicKey })
        .signers([owner])
        .rpc();

      const pref = await program.account.riskPreference.fetch(
        preferencePdaFor(owner.publicKey)
      );
      expect(pref.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(pref.threshold).to.equal(60);
      expect(pref.reporter.toBase58()).to.equal(reporter.publicKey.toBase58());
      expect(pref.updatedAt.toNumber()).to.be.greaterThan(0);
    });

    it("rejects a threshold above 100", async () => {
      const someone = anchor.web3.Keypair.generate();
      // Fund the fresh payer so the failure is the threshold check, not rent.
      await fund(someone.publicKey);

      try {
        await program.methods
          .initializePreferences(120, reporter.publicKey)
          .accounts({ owner: someone.publicKey })
          .signers([someone])
          .rpc();
        expect.fail("Should have been rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? String(err)).to.contain(
          "InvalidThreshold"
        );
      }
    });

    it("refuses to reinitialise an existing preference", async () => {
      try {
        await program.methods
          .initializePreferences(50, reporter.publicKey)
          .accounts({ owner: owner.publicKey })
          .signers([owner])
          .rpc();
        expect.fail("Should not allow reinitialisation");
      } catch (err) {
        expect(err).to.exist;
      }
    });

    it("lets the owner change threshold and reporter", async () => {
      const other = anchor.web3.Keypair.generate().publicKey;

      await program.methods
        .updatePreferences(70, other)
        .accounts({ owner: owner.publicKey })
        .signers([owner])
        .rpc();

      let pref = await program.account.riskPreference.fetch(
        preferencePdaFor(owner.publicKey)
      );
      expect(pref.threshold).to.equal(70);
      expect(pref.reporter.toBase58()).to.equal(other.toBase58());

      // Put it back so the reporter tests below can use it.
      await program.methods
        .updatePreferences(70, reporter.publicKey)
        .accounts({ owner: owner.publicKey })
        .signers([owner])
        .rpc();

      pref = await program.account.riskPreference.fetch(
        preferencePdaFor(owner.publicKey)
      );
      expect(pref.reporter.toBase58()).to.equal(reporter.publicKey.toBase58());
    });

    it("blocks a non-owner from touching someone else's preference", async () => {
      const attacker = anchor.web3.Keypair.generate();

      try {
        // The PDA is seeded by the signer, so an attacker signing for another
        // wallet's preference cannot satisfy the seeds constraint.
        await program.methods
          .updatePreferences(90, attacker.publicKey)
          .accountsPartial({
            preference: preferencePdaFor(owner.publicKey),
            owner: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Unauthorised update should fail");
      } catch (err) {
        expect(err).to.exist;
      }

      const pref = await program.account.riskPreference.fetch(
        preferencePdaFor(owner.publicKey)
      );
      expect(pref.threshold).to.equal(70);
    });
  });

  // ------------------------------
  // Reporter: snapshots
  // ------------------------------
  describe("snapshots", () => {
    it("anchors a score for a wallet that has done nothing at all", async () => {
      const timestamp = uniqueTimestamp();
      const pda = snapshotPdaFor(scored.publicKey, timestamp);

      const sig = await program.methods
        .recordRiskScore(scored.publicKey, 50, timestamp)
        // The scored wallet has no preference — pass null, which the client
        // encodes as the program id, Anchor's "None" for optional accounts.
        .accountsPartial({ preference: null, reporter: reporter.publicKey })
        .rpc();

      const snapshot = await program.account.riskSnapshot.fetch(pda);
      expect(snapshot.wallet.toBase58()).to.equal(scored.publicKey.toBase58());
      expect(snapshot.reporter.toBase58()).to.equal(
        reporter.publicKey.toBase58()
      );
      expect(snapshot.riskScore).to.equal(50);
      expect(snapshot.timestamp.toNumber()).to.equal(timestamp.toNumber());

      // No preference means no threshold and no breach — the event still
      // fires so an indexer sees every reading.
      const events = await eventsOf(sig);
      expect(events).to.have.length(1);
      expect(events[0].name).to.equal("riskScoreRecorded");
      expect(events[0].data.riskScore).to.equal(50);
      expect(events[0].data.threshold).to.equal(null);
      expect(events[0].data.breached).to.equal(false);
    });

    it("declares a breach against the owner's threshold when named", async () => {
      const timestamp = uniqueTimestamp();

      const sig = await program.methods
        .recordRiskScore(owner.publicKey, 85, timestamp)
        // Omitting `preference` lets the client derive the PDA from `wallet`.
        .accounts({ reporter: reporter.publicKey })
        .rpc();

      const [event] = await eventsOf(sig);
      expect(event.data.wallet.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(event.data.threshold).to.equal(70);
      expect(event.data.breached).to.equal(true);
    });

    it("does not declare a breach below the threshold", async () => {
      const timestamp = uniqueTimestamp();

      const sig = await program.methods
        .recordRiskScore(owner.publicKey, 69, timestamp)
        .accounts({ reporter: reporter.publicKey })
        .rpc();

      const [event] = await eventsOf(sig);
      expect(event.data.threshold).to.equal(70);
      expect(event.data.breached).to.equal(false);
    });

    it("refuses an unnamed reporter the owner's threshold", async () => {
      const stranger = anchor.web3.Keypair.generate();
      await fund(stranger.publicKey);
      const timestamp = uniqueTimestamp();

      try {
        await program.methods
          .recordRiskScore(owner.publicKey, 99, timestamp)
          .accounts({ reporter: stranger.publicKey })
          .signers([stranger])
          .rpc();
        expect.fail("A reporter the owner did not name must not use their threshold");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? String(err)).to.contain(
          "UnauthorizedReporter"
        );
      }
    });

    it("still lets an unnamed reporter anchor a plain score", async () => {
      const stranger = anchor.web3.Keypair.generate();
      await fund(stranger.publicKey);
      const timestamp = uniqueTimestamp();

      // Without invoking the preference, anyone can publish their own
      // reading. The snapshot records who — that is the whole trust model.
      const sig = await program.methods
        .recordRiskScore(owner.publicKey, 99, timestamp)
        .accountsPartial({ preference: null, reporter: stranger.publicKey })
        .signers([stranger])
        .rpc();

      const snapshot = await program.account.riskSnapshot.fetch(
        snapshotPdaFor(owner.publicKey, timestamp, stranger.publicKey)
      );
      expect(snapshot.reporter.toBase58()).to.equal(
        stranger.publicKey.toBase58()
      );

      const [event] = await eventsOf(sig);
      expect(event.data.threshold).to.equal(null);
      expect(event.data.breached).to.equal(false);
    });

    it("keeps two reporters' series apart for the same wallet and second", async () => {
      const other = anchor.web3.Keypair.generate();
      await fund(other.publicKey);
      const timestamp = uniqueTimestamp();

      await program.methods
        .recordRiskScore(scored.publicKey, 10, timestamp)
        .accountsPartial({ preference: null, reporter: reporter.publicKey })
        .rpc();

      // Same wallet, same timestamp, different reporter: a different PDA, so
      // one reporter cannot squat on a slot to block another.
      await program.methods
        .recordRiskScore(scored.publicKey, 90, timestamp)
        .accountsPartial({ preference: null, reporter: other.publicKey })
        .signers([other])
        .rpc();

      const mine = await program.account.riskSnapshot.fetch(
        snapshotPdaFor(scored.publicKey, timestamp)
      );
      const theirs = await program.account.riskSnapshot.fetch(
        snapshotPdaFor(scored.publicKey, timestamp, other.publicKey)
      );
      expect(mine.riskScore).to.equal(10);
      expect(theirs.riskScore).to.equal(90);
    });

    it("rejects a risk score above 100", async () => {
      const timestamp = uniqueTimestamp();

      try {
        await program.methods
          .recordRiskScore(scored.publicKey, 150, timestamp)
          .accountsPartial({ preference: null, reporter: reporter.publicKey })
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
          .recordRiskScore(scored.publicKey, 40, timestamp)
          .accountsPartial({ preference: null, reporter: reporter.publicKey })
          .rpc();
        expect.fail("Out-of-range timestamp should fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? String(err)).to.contain(
          "TimestampOutOfRange"
        );
      }
    });

    it("refuses to overwrite an existing snapshot", async () => {
      const timestamp = uniqueTimestamp();

      await program.methods
        .recordRiskScore(scored.publicKey, 20, timestamp)
        .accountsPartial({ preference: null, reporter: reporter.publicKey })
        .rpc();

      try {
        await program.methods
          .recordRiskScore(scored.publicKey, 80, timestamp)
          .accountsPartial({ preference: null, reporter: reporter.publicKey })
          .rpc();
        expect.fail("A snapshot must be immutable once written");
      } catch (err) {
        expect(err).to.exist;
      }

      const snapshot = await program.account.riskSnapshot.fetch(
        snapshotPdaFor(scored.publicKey, timestamp)
      );
      expect(snapshot.riskScore).to.equal(20);
    });

    it("derives a distinct snapshot per timestamp", () => {
      const t1 = new anchor.BN(nowSeconds());
      const t2 = new anchor.BN(nowSeconds() + 1);

      expect(snapshotPdaFor(scored.publicKey, t1).toBase58()).to.not.equal(
        snapshotPdaFor(scored.publicKey, t2).toBase58()
      );
    });

    it("lists a wallet's snapshots by memcmp on the wallet field", async () => {
      // This is the query the engine's /snapshots route runs. Offset 8 skips
      // the account discriminator; `wallet` is the first field.
      const all = await program.account.riskSnapshot.all([
        { memcmp: { offset: 8, bytes: scored.publicKey.toBase58() } },
      ]);

      expect(all.length).to.be.greaterThan(1);
      for (const { account } of all) {
        expect(account.wallet.toBase58()).to.equal(scored.publicKey.toBase58());
      }

      // Narrowing to one reporter: `reporter` follows `wallet` at offset 40.
      const mine = await program.account.riskSnapshot.all([
        { memcmp: { offset: 8, bytes: scored.publicKey.toBase58() } },
        { memcmp: { offset: 40, bytes: reporter.publicKey.toBase58() } },
      ]);
      expect(mine.length).to.be.greaterThan(0);
      expect(mine.length).to.be.lessThan(all.length);
    });
  });

  // ------------------------------
  // Reporter: rent
  // ------------------------------
  describe("close_snapshot", () => {
    it("closes a snapshot and refunds its rent to the reporter", async () => {
      const timestamp = uniqueTimestamp();
      const pda = snapshotPdaFor(scored.publicKey, timestamp);

      await program.methods
        .recordRiskScore(scored.publicKey, 30, timestamp)
        .accountsPartial({ preference: null, reporter: reporter.publicKey })
        .rpc();

      const rent = await provider.connection.getBalance(pda);
      expect(rent).to.be.greaterThan(0);

      const before = await provider.connection.getBalance(reporter.publicKey);

      await program.methods
        .closeSnapshot()
        .accountsPartial({ snapshot: pda, reporter: reporter.publicKey })
        .rpc();

      const closed = await provider.connection.getAccountInfo(pda);
      expect(closed).to.equal(null);

      // The refund lands minus the fee for the closing transaction itself.
      const after = await provider.connection.getBalance(reporter.publicKey);
      expect(after).to.be.greaterThan(before);
    });

    it("blocks anyone but the paying reporter from closing a snapshot", async () => {
      const timestamp = uniqueTimestamp();
      const pda = snapshotPdaFor(scored.publicKey, timestamp);

      await program.methods
        .recordRiskScore(scored.publicKey, 35, timestamp)
        .accountsPartial({ preference: null, reporter: reporter.publicKey })
        .rpc();

      const attacker = anchor.web3.Keypair.generate();
      await fund(attacker.publicKey);

      try {
        await program.methods
          .closeSnapshot()
          .accountsPartial({ snapshot: pda, reporter: attacker.publicKey })
          .signers([attacker])
          .rpc();
        expect.fail("Only the reporter that paid may reclaim the rent");
      } catch (err) {
        expect(err).to.exist;
      }

      const stillThere = await provider.connection.getAccountInfo(pda);
      expect(stillThere).to.not.equal(null);
    });
  });
});
