# Changelog

## 2.0.0 — 2026-09-12

The release where the on-chain half of the product became real.

### The program, redesigned

v1 only let a wallet record its *own* score, so the engine could anchor
exactly one wallet — the one holding its signing key — and the API had no
way to mark any other wallet as writable. v2 separates two roles:

- A **reporter** (the engine) anchors a snapshot for **any** wallet and pays
  its rent. The snapshot records which reporter wrote it, and its address is
  derived from reporter + wallet + second, so verification is one key
  comparison and no reporter can collide with or squat on another.
- An **owner** may register a preference — a threshold and the one reporter
  they trust — after which only that reporter's snapshots emit a
  `RiskScoreRecorded { breached: true }` event for their wallet. Owners never
  need to do anything to be scored.

Snapshots now carry the **portfolio value and Value at Risk** in USD cents
beside the score, so the record says "72 on a $50,000 book with $3,100 at
risk", not just "72". `close_preference` lets an owner reclaim rent, as
`close_snapshot` already did for the reporter.

Deployed to **devnet** as `6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj`,
with the IDL published on-chain so explorers decode every account. The v1
id was never deployed. 20 Anchor tests on a local validator.

### Anchoring that costs what it should

Scores are anchored on the engine's first reading, hourly
(`ONCHAIN_ANCHOR_INTERVAL`), and the moment the score crosses a risk band —
with two points of hysteresis, so a wallet twitching at 44.9 / 45.1 does not
spend rent every tick. Anchors are remembered per wallet and rehydrated from
the chain after a restart. A failed write is shown on the dashboard and not
retried until the next scheduled one.

### The dashboard shows the record

A new **On-chain record** panel lists each anchored reading with the score,
the book, the VaR, and links to the transaction and account on Solana
Explorer, and names the program and reporter to verify against. Anchored
points are marked on the trend chart. Demo mode shows labelled synthetic
rows.

### Ten assets, not four

SOL, JitoSOL, USDC, USDT, JUP, BONK, WIF, JTO, PYTH, RAY — one table of
symbol, CoinGecko id, mainnet mint and stable flag, verified against
CoinGecko and then mainnet itself (which caught a mint one character off).
The correlated-drawdown signal now needs a clear majority of volatile assets
falling rather than a fixed three. The history refresh runs beside the tick
rather than inside it, and a cache younger than the refresh interval is used
without a request, so restarts score immediately and the first run shows
prices and stress while the series load.

### The correlation behind the model

`/overview` carries the EWMA correlation matrix of the volatile assets on
the same decay the VaR uses; the dashboard draws it in monochrome, with the
selected wallet's holdings foregrounded and its most correlated pair named.

### API

- `GET /onchain` — program id, cluster, reporter, cadence, last error
- `GET /snapshots?wallet=&all=` — read back from the chain, `trusted` per row
- `GET /preferences?wallet=` — an owner's threshold and named reporter
- `/health` and `/overview` carry an `onchain` summary; each wallet lists
  its `anchors`
- `npm run init` is a pre-flight (deployment, funding, rent budget);
  `npm run preferences` is the owner-side CLI

### Housekeeping

Everything reports 2.0.0. CI fails if the bundled IDL drifts from the
program. The capstone papers moved from the repository root to
`docs/capstone/`.

## 1.0.0 — 2026-08-26

First public release: the quant engine, the dashboard on GitHub Pages, demo
mode, Telegram alerts, and a self-anchoring program that never left localnet.
