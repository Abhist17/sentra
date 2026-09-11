import type { ClusterName } from "./types";

/**
 * Links into Solana Explorer, so a reader can check a snapshot without
 * trusting this page. Localnet and custom endpoints get no link: the
 * explorer cannot reach the first, and for the second the engine deliberately
 * does not reveal its RPC URL (hosted endpoints carry API keys in the path).
 */
const EXPLORER = "https://explorer.solana.com";

export function explorerUrl(
  kind: "address" | "tx",
  id: string,
  cluster: ClusterName
): string | null {
  if (!id) return null;
  if (cluster === "localnet" || cluster === "custom") return null;

  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `${EXPLORER}/${kind}/${encodeURIComponent(id)}${suffix}`;
}

/** Human label for a cluster, as the explorer and CLI spell it. */
export function clusterLabel(cluster: ClusterName): string {
  switch (cluster) {
    case "mainnet-beta":
      return "mainnet";
    case "custom":
      return "custom RPC";
    default:
      return cluster;
  }
}

/** Anchoring cadence as a phrase: "every hour", "every 10 min". */
export function intervalLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 60_000) return `every ${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes === 60) return "every hour";
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  return `every ${minutes} min`;
}
