# Sentra — submission notes

*The two-minute version of the [README](../README.md), for reviewers.*

## One line

A portfolio risk engine for Solana that tells you how much of your wallet
can disappear tomorrow — and anchors that number on-chain so the claim is
verifiable, not trusted.

## The problem

Every wallet UI shows *what you have*. None shows *what you stand to lose*.
Two wallets holding $50,000 each can carry completely different risk: one
spread across uncorrelated assets, one 97% in a single volatile token. A
balance cannot tell them apart. A trading desk's risk model can.

## What Sentra does

Every 30 seconds, for every monitored wallet:

| Step | What happens |
|:--|:--|
| Price | Real SOL + SPL balances from mainnet across ten assets, valued at live quotes |
| Model | 95% one-day **Value at Risk** and **Expected Shortfall** from an EWMA covariance of 30 days of returns — parametric and historical, the more conservative one headlines |
| Attribute | Euler allocation splits the VaR across assets: "BONK is 11% of value and 29% of risk" — and **what-if** re-scores the book with a share of any position sold into USDC |
| Score | VaR + concentration + market stress + trend → one number, 0–100, with the breakdown always visible |
| Act | Telegram alert above threshold; **on-chain snapshot** hourly and on every band crossing |

## Where Solana is load-bearing

**Reads:** balances come from mainnet RPC (SPL Token and Token-2022).

**Writes:** the [Sentra program](https://explorer.solana.com/address/6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj?cluster=devnet)
on devnet stores each anchored reading as a `RiskSnapshot` account — score,
portfolio value, VaR, timestamp, and **which reporter wrote it**. The PDA is
seeded by reporter + wallet + second, so:

- the engine can anchor **any** wallet without the owner doing anything,
- two reporters can never collide, and
- verification is one comparison: *is the reporter field the engine's key?*

Owners may register a preference (threshold + trusted reporter); only that
reporter's snapshots then emit `RiskScoreRecorded { breached: true }` — the
event an on-chain consumer (a vault, a lending market, a bot) subscribes to.

The IDL is published on-chain, so Solana Explorer decodes every account,
and the deployed program is a **reproducible build**: `solana-verify
verify-from-repo` against this repository reports a matching hash
(`3512e377…`), and the verification record lives on-chain at
`E2bG6ActyMLYVWTeDUmtELnggj6gGi732rj91zyRcBVd`.
A first real snapshot is [`5dxA6JF1…`](https://explorer.solana.com/address/5dxA6JF1yaLmRWbC9GoEokhYszhVLcfgSeZE9Pqf3u3n?cluster=devnet)
— score 25 on a $972M stake-pool wallet with $51.8M at risk.

## Try it in 60 seconds

1. Open **https://abhist17.github.io/sentra/** — demo data, clearly labelled.
2. `git clone https://github.com/Abhist17/sentra && cd sentra/sentra/backend && npm install && npm run dev`
3. In the dashboard, **Connect to an engine** → `http://localhost:4000`.
   Prices and stress appear immediately; scoring starts once ten 30-day
   series have loaded (~1 minute on the public feed, instant on later runs).
4. To see anchoring: `npm run init`, then set `ENABLE_ONCHAIN_WRITES=true`
   in `.env` (the program's cluster, devnet, is already the default). The
   **On-chain record** panel fills with rows that link to Explorer.

## Verify a claim without trusting us

```bash
curl https://<engine>/onchain                       # program, cluster, reporter key
curl "https://<engine>/snapshots?wallet=<address>"  # read back from the chain
solana account <snapshot pda> --url devnet          # or skip the engine
```

## What is honest about it

- The horizon is **measured** from the feed's timestamps, not assumed —
  skipping this understates a one-day VaR by √24.
- The EWMA decay is rescaled to the sampling rate so its memory stays 17
  *days*, not 17 hours.
- Sample size is reported, and the dashboard says when the historical tail
  rests on too few independent observations.
- Uncovered assets reduce the reported coverage rather than scoring as
  riskless.
- A degraded feed, a stale tick, a failed anchor: each says so.
- Anchoring has hysteresis, so noise at a band boundary does not spend rent.

## Numbers

- 198 tests: 135 engine, 43 dashboard, 20 program (local validator, also in CI)
- 10 assets priced; 5 program instructions; 1 event
- Dashboard: static export, hand-rolled SVG, no charting dependency,
  keyboard-first, light and dark, screen-reader announcements

## What's next

- Mainnet deployment of the program (one `anchor deploy`; the engine reads
  mainnet already)
- A reporter registry so owners can pick from known engines
- Free-form what-ifs: any target asset, partial rebalances across several
  positions at once
- More assets, gated by the price feed's budget

## Links

- Dashboard: https://abhist17.github.io/sentra/
- Repository: https://github.com/Abhist17/sentra
- Program (devnet): `6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj`
- Changelog: [CHANGELOG.md](../CHANGELOG.md)
