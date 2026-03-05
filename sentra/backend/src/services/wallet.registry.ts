import { PublicKey } from "@solana/web3.js";

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

for (const w of DEMO_WALLETS) {
  registry.set(w.address, { ...w, addedAt: Date.now() });
}

export function addWallet(
  address: string,
  label?: string,
  isOwned = false
): WalletEntry {
  try {
    new PublicKey(address);
  } catch {
    throw new Error(`Invalid Solana address: ${address}`);
  }

  if (registry.has(address)) {
    throw new Error(`Wallet ${address} is already being monitored`);
  }

  const entry: WalletEntry = {
    address,
    label: label?.trim() || `${address.slice(0, 6)}...${address.slice(-4)}`,
    addedAt: Date.now(),
    isDemo: false,
    isOwned,
  };

  registry.set(address, entry);
  console.log(`📥 Wallet added: ${entry.label} (owned: ${isOwned})`);
  return entry;
}

export function removeWallet(address: string): boolean {
  const entry = registry.get(address);
  if (!entry) return false;
  if (entry.isDemo) throw new Error(`Cannot remove demo wallet: ${entry.label}`);
  registry.delete(address);
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
  return registry.get(address)?.label ?? `${address.slice(0, 6)}...${address.slice(-4)}`;
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