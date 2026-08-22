// Regenerates backend/src/idl/sentra.json to match programs/sentra/src/lib.rs.
// Normally `anchor build` emits this; discriminators are just
// sha256("<namespace>:<name>")[0..8], so it can be rebuilt deterministically
// when the SBF toolchain is unavailable.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const disc = (ns, name) =>
  Array.from(crypto.createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8));

const constSeed = (s) => ({ kind: "const", value: Array.from(Buffer.from(s)) });
const accountSeed = (p) => ({ kind: "account", path: p });
const argSeed = (p) => ({ kind: "arg", path: p });

const SYSTEM_PROGRAM = {
  name: "system_program",
  address: "11111111111111111111111111111111",
};

const idl = {
  address: "35PirCKfyFFPYR3nLUGmpTs8YRyhfz9CAUpHVwVhiLi4",
  metadata: {
    name: "sentra",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Created with Anchor",
  },
  instructions: [
    {
      name: "close_snapshot",
      discriminator: disc("global", "close_snapshot"),
      accounts: [
        {
          name: "snapshot",
          writable: true,
          pda: {
            seeds: [
              constSeed("risk_snapshot"),
              accountSeed("user"),
              { kind: "account", path: "snapshot.timestamp", account: "RiskSnapshot" },
            ],
          },
        },
        { name: "user", writable: true, signer: true },
      ],
      args: [],
    },
    {
      name: "initialize_preferences",
      discriminator: disc("global", "initialize_preferences"),
      accounts: [
        {
          name: "preference",
          writable: true,
          pda: { seeds: [constSeed("risk_preference"), accountSeed("user")] },
        },
        { name: "user", writable: true, signer: true },
        SYSTEM_PROGRAM,
      ],
      args: [{ name: "threshold", type: "u8" }],
    },
    {
      name: "record_risk_score",
      discriminator: disc("global", "record_risk_score"),
      accounts: [
        {
          name: "preference",
          writable: true,
          pda: { seeds: [constSeed("risk_preference"), accountSeed("user")] },
        },
        {
          name: "snapshot",
          writable: true,
          pda: {
            seeds: [constSeed("risk_snapshot"), accountSeed("user"), argSeed("timestamp")],
          },
        },
        { name: "user", writable: true, signer: true },
        SYSTEM_PROGRAM,
      ],
      args: [
        { name: "risk_score", type: "u8" },
        { name: "timestamp", type: "i64" },
      ],
    },
    {
      name: "update_threshold",
      discriminator: disc("global", "update_threshold"),
      accounts: [
        {
          name: "preference",
          writable: true,
          pda: { seeds: [constSeed("risk_preference"), accountSeed("user")] },
        },
        { name: "user", signer: true },
      ],
      args: [{ name: "new_threshold", type: "u8" }],
    },
  ],
  accounts: [
    { name: "RiskPreference", discriminator: disc("account", "RiskPreference") },
    { name: "RiskSnapshot", discriminator: disc("account", "RiskSnapshot") },
  ],
  events: [
    { name: "RiskAlertEvent", discriminator: disc("event", "RiskAlertEvent") },
  ],
  errors: [
    { code: 6000, name: "InvalidThreshold", msg: "Threshold must be between 0 and 100" },
    { code: 6001, name: "Unauthorized", msg: "Unauthorized access" },
    { code: 6002, name: "InvalidRiskScore", msg: "Risk score must be between 0 and 100" },
    {
      code: 6003,
      name: "TimestampOutOfRange",
      msg: "Timestamp is too far from the cluster clock",
    },
  ],
  types: [
    {
      name: "RiskAlertEvent",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "risk_score", type: "u8" },
          { name: "threshold", type: "u8" },
          { name: "breached", type: "bool" },
          { name: "timestamp", type: "i64" },
        ],
      },
    },
    {
      name: "RiskPreference",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "threshold", type: "u8" },
          { name: "last_risk_score", type: "u8" },
          { name: "last_updated", type: "i64" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "RiskSnapshot",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "risk_score", type: "u8" },
          { name: "timestamp", type: "i64" },
          { name: "bump", type: "u8" },
        ],
      },
    },
  ],
};

const out = path.join(__dirname, "..", "backend", "src", "idl", "sentra.json");
fs.writeFileSync(out, JSON.stringify(idl, null, 2) + "\n");
console.log("wrote", out);
