import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config/env";

export interface WalletEntry {
  address: string;
  label: string;
  addedAt: number;
  isDemo: boolean;
  isOwned: boolean; // true = server keypair owns this wallet → can write on-chain
}

const registry: Map<string, WalletEntry> = new Map();

// ── Demo wallets — monitored but NOT owned ───────────────────────
// We read their balances and calculate risk but cannot sign for them
const DEMO_WALLETS: Omit<WalletEntry, "addedAt">[] = [
  {
    address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    label: "Solana Stake Pool (Foundation)",
    isDemo: true,
    isOwned: false,
  },
];

const REGISTRY_FILE = path.join(CONFIG.DATA_DIR, "wallets.json");

function shortLabel(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Throws unless `address` is a real, on-curve Solana public key. */
function assertValidAddress(address: string) {
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    throw new Error(`Invalid Solana address: ${address}`);
  }

  // `new PublicKey` accepts any 32 bytes, including PDAs and truncated base58
  // that happens to decode. Re-encoding catches inputs that are not canonical.
  if (key.toBase58() !== address) {
    throw new Error(`Invalid Solana address: ${address}`);
  }
}

// ── Persistence ──────────────────────────────────────────────────
// Wallets used to live only in memory, so every restart silently dropped
// whatever the user had added.

function persist() {
  try {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    const userWallets = Array.from(registry.values()).filter((w) => !w.isDemo);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(userWallets, null, 2));
  } catch (err) {
    console.warn(
      "⚠️  Could not persist wallet registry:",
      err instanceof Error ? err.message : err
    );
  }
}

function restore() {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    if (!Array.isArray(raw)) return;

    let restored = 0;
    for (const entry of raw) {
      if (typeof entry?.address !== "string") continue;
      try {
        assertValidAddress(entry.address);
      } catch {
        continue;
      }
      if (registry.has(entry.address)) continue;

      registry.set(entry.address, {
        address: entry.address,
        label:
          typeof entry.label === "string" && entry.label.trim()
            ? entry.label.trim().slice(0, 64)
            : shortLabel(entry.address),
        addedAt: Number(entry.addedAt) || Date.now(),
        isDemo: false,
        isOwned: Boolean(entry.isOwned),
      });
      restored++;
    }

    if (restored) console.log(`💾 Restored ${restored} monitored wallet(s)`);
  } catch (err) {
    console.warn(
      "⚠️  Could not restore wallet registry:",
      err instanceof Error ? err.message : err
    );
  }
}

for (const w of DEMO_WALLETS) {
  registry.set(w.address, { ...w, addedAt: Date.now() });
}
restore();

export function addWallet(
  address: string,
  label?: string,
  isOwned = false
): WalletEntry {
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("address is required");
  }

  const trimmed = address.trim();
  assertValidAddress(trimmed);

  if (registry.has(trimmed)) {
    throw new Error(`Wallet ${trimmed} is already being monitored`);
  }

  // Every monitored wallet costs an RPC round-trip on every tick, so the list
  // is capped rather than letting an open endpoint grow it without bound.
  if (registry.size >= CONFIG.MAX_WALLETS) {
    throw new Error(
      `Wallet limit reached (${CONFIG.MAX_WALLETS}) — remove one first`
    );
  }

  const entry: WalletEntry = {
    address: trimmed,
    label: label?.trim().slice(0, 64) || shortLabel(trimmed),
    addedAt: Date.now(),
    isDemo: false,
    isOwned,
  };

  registry.set(trimmed, entry);
  persist();
  console.log(`📥 Wallet added: ${entry.label} (owned: ${isOwned})`);
  return entry;
}

export function removeWallet(address: string): boolean {
  const entry = registry.get(address);
  if (!entry) return false;
  if (entry.isDemo) throw new Error(`Cannot remove demo wallet: ${entry.label}`);
  registry.delete(address);
  persist();
  console.log(`📤 Wallet removed: ${entry.label}`);
  return true;
}

export function getWallets(): WalletEntry[] {
  return Array.from(registry.values());
}

export function getWalletPublicKeys(): PublicKey[] {
  return Array.from(registry.keys()).map((a) => new PublicKey(a));
}

export function getWalletLabel(address: string): string {
  return registry.get(address)?.label ?? shortLabel(address);
}

export function isWalletOwned(address: string): boolean {
  return registry.get(address)?.isOwned ?? false;
}

export function hasWallet(address: string): boolean {
  return registry.has(address);
}

export function getWalletCount(): number {
  return registry.size;
}

export { assertValidAddress };
