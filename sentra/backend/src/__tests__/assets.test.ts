/**
 * The asset table is data, and data drifts. A mint one character off is a
 * valid-looking base58 string that simply never matches a token account, so
 * a wallet's whole position in that asset silently reads as zero. These pin
 * what can be checked without a network; the mints themselves were verified
 * against mainnet by hand when added.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

import {
  ASSETS,
  ASSET_SYMBOLS,
  TRACKED_ASSETS,
  STABLE_ASSETS,
  isAssetSymbol,
} from "../services/price.service";
import { TOKEN_MINTS } from "../services/blockchain.service";

test("every symbol, CoinGecko id and mint is unique", () => {
  const symbols = ASSETS.map((a) => a.symbol);
  const ids = ASSETS.map((a) => a.coingeckoId);
  const mints = ASSETS.map((a) => a.mint as string | null).filter(
    (m): m is string => m !== null
  );

  assert.equal(new Set(symbols).size, symbols.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(mints).size, mints.length);
});

test("SOL is the only native asset and comes first", () => {
  assert.equal(ASSETS[0].symbol, "SOL");
  assert.equal(ASSETS[0].mint, null);
  assert.equal(ASSETS.filter((a) => a.mint === null).length, 1);
});

test("every mint is a canonical base58 public key", () => {
  for (const asset of ASSETS) {
    if (asset.mint === null) continue;
    // Round-tripping catches a truncated or mistyped address that base58
    // still decodes, which `new PublicKey` alone would accept.
    assert.equal(
      new PublicKey(asset.mint).toBase58(),
      asset.mint,
      `${asset.symbol} mint is not canonical`
    );
  }
});

test("the derived tables agree with the source", () => {
  assert.deepEqual(
    ASSET_SYMBOLS,
    ASSETS.map((a) => a.symbol)
  );
  for (const asset of ASSETS) {
    assert.equal(TRACKED_ASSETS[asset.symbol], asset.coingeckoId);
    assert.equal(STABLE_ASSETS.has(asset.symbol), asset.stable);
    if (asset.mint) assert.equal(TOKEN_MINTS[asset.symbol], asset.mint);
  }
  assert.equal(Object.keys(TOKEN_MINTS).length, ASSETS.length - 1);
});

test("stablecoins are the dollar tokens and nothing else", () => {
  assert.deepEqual([...STABLE_ASSETS].sort(), ["USDC", "USDT"]);
});

test("symbols are upper-case tickers", () => {
  for (const symbol of ASSET_SYMBOLS) {
    assert.match(symbol, /^[A-Z0-9]{2,10}$/);
    assert.ok(isAssetSymbol(symbol));
  }
  assert.equal(isAssetSymbol("sol"), false);
  assert.equal(isAssetSymbol("DOGE"), false);
});
