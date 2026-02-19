import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";


const RPC_URL = "http://127.0.0.1:8899";

const keypair = anchor.web3.Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync("/home/abhi/.config/solana/id.json", "utf-8")
    )
  )
);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const wallet = new anchor.Wallet(keypair);

  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  // Load IDL
  const idl = JSON.parse(
    fs.readFileSync("../target/idl/sentra.json", "utf-8")
  );

  // Program automatically reads programId from IDL
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const programId = program.programId;

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("risk_preference"), keypair.publicKey.toBuffer()],
    programId
  );

  console.log("Initializing threshold...");

  await program.methods
    .initializePreferences(60)
    .accounts({
      preference: pda,
      user: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Threshold initialized to 60");
}

main().catch(console.error);
