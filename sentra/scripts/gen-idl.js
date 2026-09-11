// Regenerates backend/src/idl/sentra.json to match programs/sentra/src/lib.rs.
// Normally `anchor build` emits this; discriminators are just
// sha256("<namespace>:<name>")[0..8], so it can be rebuilt deterministically
// when the SBF toolchain is unavailable. `node scripts/gen-idl.js --check`
// exits non-zero if the bundled file has drifted from the program.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const disc = (ns, name) =>
  Array.from(crypto.createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8));

const constSeed = (s) => ({ kind: "const", value: Array.from(Buffer.from(s)) });
const accountSeed = (p, account) =>
  account ? { kind: "account", path: p, account } : { kind: "account", path: p };
const argSeed = (p) => ({ kind: "arg", path: p });

const SYSTEM_PROGRAM = {
  name: "system_program",
  address: "11111111111111111111111111111111",
};

const PREFERENCE_SEED = constSeed("risk_preference");
const SNAPSHOT_SEED = constSeed("risk_snapshot");

const idl = {
  address: "6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj",
  metadata: {
    name: "sentra",
    version: "2.0.0",
    spec: "0.1.0",
    description: "Sentra — on-chain risk snapshots for Solana wallets",
  },
  // Anchor emits instructions, accounts, events and types sorted by name.
  instructions: [
    {
      name: "close_preference",
      discriminator: disc("global", "close_preference"),
      accounts: [
        {
          name: "preference",
          writable: true,
          pda: { seeds: [PREFERENCE_SEED, accountSeed("owner")] },
        },
        { name: "owner", writable: true, signer: true },
      ],
      args: [],
    },
    {
      name: "close_snapshot",
      discriminator: disc("global", "close_snapshot"),
      accounts: [
        {
          name: "snapshot",
          writable: true,
          pda: {
            seeds: [
              SNAPSHOT_SEED,
              accountSeed("reporter"),
              accountSeed("snapshot.wallet", "RiskSnapshot"),
              accountSeed("snapshot.timestamp", "RiskSnapshot"),
            ],
          },
        },
        { name: "reporter", writable: true, signer: true },
      ],
      args: [],
    },
    {
      name: "initialize_preferences",
      docs: [
        "Creates the caller's preference PDA. `reporter` is the key whose",
        "snapshots are allowed to declare a breach against this wallet.",
      ],
      discriminator: disc("global", "initialize_preferences"),
      accounts: [
        {
          name: "preference",
          writable: true,
          pda: { seeds: [PREFERENCE_SEED, accountSeed("owner")] },
        },
        { name: "owner", writable: true, signer: true },
        SYSTEM_PROGRAM,
      ],
      args: [
        { name: "threshold", type: "u8" },
        { name: "reporter", type: "pubkey" },
      ],
    },
    {
      name: "record_risk_score",
      docs: [
        "Writes an immutable snapshot of `wallet`'s risk at `timestamp`: the",
        "0–100 score, and the portfolio value and Value at Risk behind it in",
        "USD cents, so the record says not just \"72\" but \"72 on a $50,000 book",
        "with $3,100 at risk\".",
        "",
        "The reporter signs and pays. When the wallet's owner has registered a",
        "preference, it is passed in read-only and the event says whether the",
        "score breaches their threshold; when they have not, the event still",
        "fires with no threshold attached.",
      ],
      discriminator: disc("global", "record_risk_score"),
      accounts: [
        {
          name: "snapshot",
          writable: true,
          pda: {
            seeds: [
              SNAPSHOT_SEED,
              accountSeed("reporter"),
              argSeed("wallet"),
              argSeed("timestamp"),
            ],
          },
        },
        {
          name: "preference",
          optional: true,
          pda: { seeds: [PREFERENCE_SEED, argSeed("wallet")] },
        },
        { name: "reporter", writable: true, signer: true },
        SYSTEM_PROGRAM,
      ],
      args: [
        { name: "wallet", type: "pubkey" },
        { name: "risk_score", type: "u8" },
        { name: "timestamp", type: "i64" },
        { name: "value_usd_cents", type: "u64" },
        { name: "var_usd_cents", type: "u64" },
      ],
    },
    {
      name: "update_preferences",
      discriminator: disc("global", "update_preferences"),
      accounts: [
        {
          name: "preference",
          writable: true,
          pda: { seeds: [PREFERENCE_SEED, accountSeed("owner")] },
        },
        { name: "owner", signer: true },
      ],
      args: [
        { name: "threshold", type: "u8" },
        { name: "reporter", type: "pubkey" },
      ],
    },
  ],
  accounts: [
    { name: "RiskPreference", discriminator: disc("account", "RiskPreference") },
    { name: "RiskSnapshot", discriminator: disc("account", "RiskSnapshot") },
  ],
  events: [
    { name: "RiskScoreRecorded", discriminator: disc("event", "RiskScoreRecorded") },
  ],
  errors: [
    { code: 6000, name: "InvalidThreshold", msg: "Threshold must be between 0 and 100" },
    { code: 6001, name: "InvalidRiskScore", msg: "Risk score must be between 0 and 100" },
    {
      code: 6002,
      name: "TimestampOutOfRange",
      msg: "Timestamp is too far from the cluster clock",
    },
    {
      code: 6003,
      name: "UnauthorizedReporter",
      msg: "This reporter is not the one the wallet owner named",
    },
  ],
  types: [
    {
      name: "RiskPreference",
      docs: ["A wallet owner's alert settings. One per wallet, owner-controlled."],
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          {
            name: "threshold",
            docs: ["Score at or above which a snapshot counts as a breach."],
            type: "u8",
          },
          {
            name: "reporter",
            docs: ["The only reporter allowed to declare a breach for this wallet."],
            type: "pubkey",
          },
          { name: "updated_at", type: "i64" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "RiskScoreRecorded",
      type: {
        kind: "struct",
        fields: [
          { name: "wallet", type: "pubkey" },
          { name: "reporter", type: "pubkey" },
          { name: "risk_score", type: "u8" },
          { name: "value_usd_cents", type: "u64" },
          { name: "var_usd_cents", type: "u64" },
          {
            name: "threshold",
            docs: [
              "The owner's threshold when they have registered one and named this",
              "reporter; otherwise absent, and `breached` is false.",
            ],
            type: { option: "u8" },
          },
          { name: "breached", type: "bool" },
          { name: "timestamp", type: "i64" },
        ],
      },
    },
    {
      name: "RiskSnapshot",
      docs: [
        "One immutable reading: this wallet scored this much at this second,",
        "according to this reporter, on a book of this size with this much at risk.",
      ],
      type: {
        kind: "struct",
        fields: [
          { name: "wallet", type: "pubkey" },
          { name: "reporter", type: "pubkey" },
          { name: "risk_score", type: "u8" },
          { name: "timestamp", type: "i64" },
          {
            name: "value_usd_cents",
            docs: ["Portfolio value when scored, in USD cents. 0 when not reported."],
            type: "u64",
          },
          {
            name: "var_usd_cents",
            docs: ["Headline Value at Risk when scored, in USD cents. 0 when not reported."],
            type: "u64",
          },
          { name: "bump", type: "u8" },
        ],
      },
    },
  ],
};

const out = path.join(__dirname, "..", "backend", "src", "idl", "sentra.json");
const rendered = JSON.stringify(idl, null, 2);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf-8").trimEnd() : "";
  if (current !== rendered) {
    console.error(`${out} is out of date — run \`node scripts/gen-idl.js\``);
    process.exit(1);
  }
  console.log("IDL is up to date");
} else {
  fs.writeFileSync(out, rendered);
  console.log("wrote", out);
}
