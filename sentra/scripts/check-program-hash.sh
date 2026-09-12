#!/usr/bin/env bash
# Refuses to let a non-reproducible binary reach the cluster.
#
# `anchor build` and `anchor test` write target/deploy/sentra.so with the
# local platform tools; `solana-verify build` writes it from the standard
# container. Only the second matches what is on devnet, and only the second
# should ever be deployed. Run this before `anchor deploy` or
# `solana program deploy`:
#
#   npm run program:check            # local binary vs devnet
#   npm run program:check -- mainnet # or another cluster
set -euo pipefail

cluster="${1:-devnet}"
program_id="$(node -e 'console.log(require("./backend/src/idl/sentra.json").address)')"
so="target/deploy/sentra.so"

if ! command -v solana-verify >/dev/null; then
  echo "solana-verify is not installed: cargo install solana-verify" >&2
  exit 2
fi
if [ ! -f "$so" ]; then
  echo "$so not found — run: solana-verify build --library-name sentra" >&2
  exit 2
fi

local_hash="$(solana-verify get-executable-hash "$so")"
chain_hash="$(solana-verify get-program-hash -u "$cluster" "$program_id")"

echo "program   $program_id ($cluster)"
echo "local     $local_hash"
echo "on-chain  $chain_hash"

if [ "$local_hash" = "$chain_hash" ]; then
  echo "match — the local binary is the deployed, reproducible build"
else
  echo "MISMATCH — do not deploy this binary. Rebuild reproducibly first:" >&2
  echo "  solana-verify build --library-name sentra" >&2
  exit 1
fi
