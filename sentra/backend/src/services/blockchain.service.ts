import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import { CONFIG } from "../config/env";

const keypair = anchor.web3.Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync(
        "/home/abhi/.config/solana/id.json",
        "utf-8"
      )
    )
  )
);

export function createProvider() {
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(keypair);

  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  return provider;
}

export function getProgram(provider: anchor.AnchorProvider) {
  const idl = JSON.parse(
    fs.readFileSync("../target/idl/sentra.json", "utf-8")
  );

  return new anchor.Program(idl as anchor.Idl, provider);
}

export function derivePreferencePda(
  user: PublicKey,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("risk_preference"), user.toBuffer()],
    programId
  );
}

export function deriveSnapshotPda(
  user: PublicKey,
  timestampBN: anchor.BN,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("risk_snapshot"),
      user.toBuffer(),
      timestampBN.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

export async function recordRiskScoreOnChain(
  program: anchor.Program,
  user: PublicKey,
  riskScore: number
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const timestampBN = new anchor.BN(timestamp);

  const [preferencePda] = derivePreferencePda(
    user,
    program.programId
  );

  const [snapshotPda] = deriveSnapshotPda(
    user,
    timestampBN,
    program.programId
  );

  await program.methods
    .recordRiskScore(riskScore, timestampBN)
    .accounts({
      preference: preferencePda,
      snapshot: snapshotPda,
      user,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
}
export async function fetchUserSnapshots(
  program: anchor.Program,
  user: PublicKey
) {
  const snapshots = await (program as any).account.riskSnapshot.all([
    {
      memcmp: {
        offset: 8, // Skip discriminator
        bytes: user.toBase58(),
      },
    },
  ]);

  return snapshots
  .map((s: any) => ({
    publicKey: s.publicKey.toBase58(),
    riskScore: s.account.riskScore,
    timestamp: s.account.timestamp.toNumber(),
  }))
  .sort((a: any, b: any) => a.timestamp - b.timestamp);
}