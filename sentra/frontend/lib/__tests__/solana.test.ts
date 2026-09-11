import { describe, expect, it } from "vitest";
import { explorerUrl, clusterLabel, intervalLabel } from "../solana";

const PDA = "5dxA6JF1yaLmRWbC9GoEokhYszhVLcfgSeZE9Pqf3u3n";
const SIG =
  "3RKThPXcJWpRHezymDNKSugiFNWnCCVg7HTtx5EqMtvgaDHc5qRSao5ZowoUyzgknJd6Cv5imUEwgcaTWqPayiKf";

describe("explorerUrl", () => {
  it("links accounts and transactions on the named cluster", () => {
    expect(explorerUrl("address", PDA, "devnet")).toBe(
      `https://explorer.solana.com/address/${PDA}?cluster=devnet`
    );
    expect(explorerUrl("tx", SIG, "testnet")).toBe(
      `https://explorer.solana.com/tx/${SIG}?cluster=testnet`
    );
  });

  it("omits the cluster parameter on mainnet, which is the explorer default", () => {
    expect(explorerUrl("address", PDA, "mainnet-beta")).toBe(
      `https://explorer.solana.com/address/${PDA}`
    );
  });

  it("returns no link where the explorer could not resolve one", () => {
    // Localnet is unreachable from the explorer; a custom endpoint is never
    // revealed by the engine, so there is nothing to point the explorer at.
    expect(explorerUrl("address", PDA, "localnet")).toBeNull();
    expect(explorerUrl("tx", SIG, "custom")).toBeNull();
    // A snapshot restored from chain after a restart has no signature.
    expect(explorerUrl("tx", "", "devnet")).toBeNull();
  });
});

describe("clusterLabel", () => {
  it("uses the short names people say", () => {
    expect(clusterLabel("mainnet-beta")).toBe("mainnet");
    expect(clusterLabel("devnet")).toBe("devnet");
    expect(clusterLabel("localnet")).toBe("localnet");
    expect(clusterLabel("custom")).toBe("custom RPC");
  });
});

describe("intervalLabel", () => {
  it("phrases the anchoring cadence", () => {
    expect(intervalLabel(3_600_000)).toBe("every hour");
    expect(intervalLabel(7_200_000)).toBe("every 2 hours");
    expect(intervalLabel(600_000)).toBe("every 10 min");
    expect(intervalLabel(30_000)).toBe("every 30s");
    expect(intervalLabel(0)).toBe("—");
  });
});
