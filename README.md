<div align="center">

# Sentra

**A portfolio risk engine for Solana — with a record you can verify on-chain.**

Your wallet balance tells you what you have.
Sentra tells you how much you stand to lose, and writes it down where nobody can edit it.

[**Open the dashboard →**](https://abhist17.github.io/sentra/) ·
[**Program on devnet →**](https://explorer.solana.com/address/6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj?cluster=devnet) ·
[What's new in v2](CHANGELOG.md)

[![CI](https://github.com/Abhist17/sentra/actions/workflows/ci.yml/badge.svg)](https://github.com/Abhist17/sentra/actions/workflows/ci.yml)
[![Program tests](https://github.com/Abhist17/sentra/actions/workflows/program-tests.yml/badge.svg)](https://github.com/Abhist17/sentra/actions/workflows/program-tests.yml)
[![Deploy dashboard](https://github.com/Abhist17/sentra/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Abhist17/sentra/actions/workflows/deploy-pages.yml)

</div>

![The Sentra dashboard: a blended risk dial, portfolio exposure and Value at Risk, a live risk trend with on-chain anchors marked, the holdings behind it, and the on-chain record](docs/dashboard.png)

<div align="center">
<sub>Two books holding roughly the same value — and carrying very different
risk. That gap is the product.</sub>
</div>

---

## The problem

Every Solana wallet UI answers the same question: *what is this worth right now?*

None of them answer the one that matters when the market turns: *how much of this
can disappear tomorrow?*

Two wallets can hold $50,000 each and carry completely different risk. One split
evenly across four assets with low correlation. One sitting 97% in a single
volatile token. Same balance, very different night's sleep.

Sentra measures that difference continuously, using the same model a trading desk
would use — **Value at Risk** — turns it into one number between 0 and 100, and
anchors that number on Solana so a claim about past risk is checkable rather than
trusted.

---

## What it does

Every 30 seconds, for every wallet you monitor:

1. **Prices the book.** Reads real SOL and SPL token balances from Solana
   mainnet across ten assets — SOL, JitoSOL, USDC, USDT, JUP, BONK, WIF, JTO,
   PYTH, RAY — and values them against live CoinGecko quotes.
2. **Computes Value at Risk and Expected Shortfall.** Builds an
   exponentially-weighted covariance matrix from 30 days of price history and
   derives both the 95% one-day VaR — the loss exceeded on about one day in
   twenty — and the Expected Shortfall, the average loss *given* that it is
   exceeded.
3. **Scores market stress.** Watches for volatility spikes, rapid drops, and
   assets falling together, and combines them into a systemic stress score.
4. **Blends them into one score.** VaR plus penalties for concentration, a
   falling lead asset, and market stress — capped at 100.
5. **Acts on it.** Sends a Telegram alert above your threshold, and anchors the
   score, the book's value and its VaR to the Sentra program as an immutable,
   timestamped snapshot — every hour, and the moment the score crosses a risk
   band.

```
Solana mainnet ──┐
                 ├──▶  quant engine  ──▶  blended risk score  ──▶  dashboard
CoinGecko feed ──┘           │                    │
                             │                    ├──▶  Telegram alert
                   30-day covariance              │
                   + live stress signals          └──▶  on-chain snapshot (devnet)
```

---

## Reading the score

The score is not a price prediction. It is an estimate of **downside exposure**
under current conditions.

| Band | Score | Meaning |
|:--|:--|:--|
| **Calm** | 0 – 24 | Loss potential within normal range |
| **Watch** | 25 – 44 | Above baseline — worth checking |
| **Elevated** | 45 – 69 | Meaningful downside concentration |
| **Severe** | 70 – 100 | Large modelled loss at 95% confidence |

### What goes into it

| Component | Range | What it measures |
|:--|:--|:--|
| Value at Risk | 0 – 100 | 95% one-day loss as a share of portfolio value |
| Concentration | 0 – 20 | How much of the book rides on too few positions |
| Market stress | 0 – 25 | Systemic signals scaled into the score |
| Trend | 0 / 5 | Penalty when the heaviest holding is falling |

The dashboard shows this breakdown for every wallet, so the number is never a
black box — you can always see which component moved it.

Concentration is the worse of two continuous measures: how dominant the largest
position is, and how many assets the book *effectively* holds by the
Herfindahl index. Either alone has a blind spot the other covers — the largest
weight cannot tell 50/50 from 50/10/10/10/10/10, and the Herfindahl term alone
would let a 75% position hide behind a long tail of small ones. Both ramps are
continuous on purpose: a threshold that jumps ten points the instant a holding
crosses 50% turns a rounding-error price move into an alert.

### Weight is not risk

A balance readout says *"you hold 11% BONK"*. Sentra says *"BONK is 29% of what
you stand to lose"*.

The two diverge whenever an asset's volatility differs from its size, and the
gap is the only part you can act on. Sentra splits portfolio VaR across assets
by Euler allocation, so the components sum exactly to the total — an
attribution, not a heuristic.

| Asset | Share of value | Share of risk |
|:--|--:|--:|
| SOL | 76.4% | 70.9% |
| BONK | 11.4% | **28.9%** |
| USDC | 12.2% | 0.1% |

It also reports a **diversification ratio**: weighted average standalone
volatility over portfolio volatility. At 1.0 the holdings move as one and
spreading across tickers is buying nothing.

### Why the ratio is what it is

The dashboard shows the **correlation matrix** behind the covariance — the
same exponentially-weighted estimate the loss model uses, not a prettier one
computed some other way. A wallet holding SOL and JitoSOL sees the pair at
0.99 and understands, without being told, why its five tickers behave like
one position. The selected wallet's own holdings are foregrounded and its most
correlated pair is named.

### How the loss estimate is built

Two models run on every tick, and the dashboard shows both:

| Model | How | Strength |
|:--|:--|:--|
| **Parametric** | EWMA covariance, normal tail | Reacts to the current volatility regime |
| **Historical** | Empirical quantile of compounded horizon returns | Carries the realised tail, no distribution assumed |

The headline figure is the **more conservative of the two** — reporting the
smaller of two defensible numbers would be choosing the flattering one.

Three details that matter more than they sound:

- **The horizon is measured, not assumed.** The price feed returns hourly
  observations for a 30-day window, so volatility computed from them is
  *hourly*. Sentra measures the sampling interval from the data's own
  timestamps and scales to a true one-day figure. Skipping this understates a
  one-day VaR by √24 ≈ 4.9×.
- **The EWMA decay is frequency-aware.** λ = 0.94 is RiskMetrics' default for
  *daily* data (~17 days of memory). Applied unchanged to hourly observations
  it means 17 *hours*, and the estimator measures intraday noise instead of
  volatility — on real SOL data that doubled the reported VaR. Sentra rescales
  λ so the memory stays fixed in calendar terms.
- **Sample size is reported.** Overlapping windows inflate the apparent
  observation count without adding information, so the dashboard shows the
  number of *independent* observations and says plainly when the tail rests on
  too few.

> **A note on honesty:** these are model estimates. VaR assumes tomorrow rhymes
> with the recent past, and even Expected Shortfall says nothing about what
> happens beyond the sample. When an asset has no return history behind it,
> Sentra reports the reduced coverage rather than quietly scoring it as
> riskless. Not investment advice.

---

## The on-chain record

Every other part of Sentra asks you to trust the engine. This part is where
you stop having to.

The engine anchors each wallet's score on Solana as a **snapshot account**
holding the score, the portfolio value and the Value at Risk at that second,
written by a key anyone can check. A claim like *"this wallet scored 72 on a
$50,000 book with $3,100 at risk at 14:03 on Tuesday"* becomes something you
open, not something you believe.

**Program:** [`6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj`](https://explorer.solana.com/address/6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj?cluster=devnet)
on devnet, IDL published on-chain so the explorer decodes every account, and
built reproducibly: the deployed bytes hash to
`3512e377ba6a25561983903ce9b1c193b191f36156b5676afe1538c1a1838503`, which is
what this repository produces in the standard verifiable-build container. The
verification record is on-chain at
[`E2bG6ActyMLYVWTeDUmtELnggj6gGi732rj91zyRcBVd`](https://explorer.solana.com/address/E2bG6ActyMLYVWTeDUmtELnggj6gGi732rj91zyRcBVd?cluster=devnet).

### Two roles, one trust model

| Role | Who | What they can do |
|:--|:--|:--|
| **Reporter** | The engine's signing key | Anchor a snapshot for **any** wallet, and pay its rent |
| **Owner** | A wallet being scored | Nothing required. Optionally register a threshold and name the one reporter they trust |

A snapshot permanently records which reporter wrote it, and its address is
derived from the reporter *and* the wallet *and* the second — so two
reporters can never collide, nobody can squat on another reporter's slot, and
verification is one key comparison: *is the reporter field the engine's
published key?* Anyone may write a snapshot about any wallet. Nobody can write
one as someone else.

When an owner has registered a preference naming the reporter, the reporter's
snapshots emit a `RiskScoreRecorded` event with `breached: true` whenever the
score meets the owner's threshold. That event is what an on-chain consumer —
a vault, a lending market, a bot — should subscribe to. A reporter the owner
did not name cannot invoke their threshold at all.

### What gets written, and when

Anchoring every 30-second score would rent ~2,900 accounts a day per wallet.
Instead, a snapshot is written:

- on the engine's first reading of a wallet,
- every hour after that (`ONCHAIN_ANCHOR_INTERVAL`), and
- **the moment the score crosses a risk band** — the readings worth being able
  to prove later. A crossing has to clear the boundary by two points, so a
  wallet twitching at 44.9 / 45.1 does not spend rent on noise.

Each snapshot costs about 0.0015 SOL of rent; `close_snapshot` reclaims it.
Anchored readings are marked on the dashboard's trend chart and listed in the
**On-chain record** panel with links to the transaction and the account.

### Verify one yourself

```bash
# What to verify against: program, cluster, and this engine's reporter key
curl https://your-engine/onchain
# {"enabled":true,"programId":"6n6DZhiP…","cluster":"devnet","reporter":"4u8ckM2U…",…}

# Every snapshot this engine anchored for a wallet, read back from the chain
curl "https://your-engine/snapshots?wallet=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
# {"snapshots":[{"publicKey":"5dxA6JF1…","riskScore":25,"valueUsd":972542906.93,
#   "varUsd":51756208.27,"timestamp":1789165729,"reporter":"4u8ckM2U…","trusted":true}],…}

# Or skip the engine entirely
solana account 5dxA6JF1yaLmRWbC9GoEokhYszhVLcfgSeZE9Pqf3u3n --url devnet
```

`/snapshots?wallet=…&all=1` widens the read to every reporter that has ever
scored the wallet, each row saying who.

### Verify the program itself

The bytes on devnet are the bytes this repository builds — not a claim, a
hash. With Docker and [`solana-verify`](https://solana.com/docs/programs/verified-builds)
installed:

```bash
solana-verify verify-from-repo -u devnet \
  --program-id 6n6DZhiPwhYxiBLaRn9kYSW2s7WvWiVwDmciG2jP2Aoj \
  https://github.com/Abhist17/sentra --mount-path sentra --library-name sentra
# Executable Program Hash from repo: 3512e377…
# On-chain Program Hash:             3512e377…
# Program hash matches ✅
```

(OtterSec's remote verifier, which puts the badge on the explorer, only
serves mainnet; on devnet the on-chain record and the reproducible hash are
the whole proof.)

### Instructions

| Instruction | Signer | Purpose |
|:--|:--|:--|
| `record_risk_score(wallet, score, timestamp, value_usd_cents, var_usd_cents)` | reporter | Writes a snapshot; emits `RiskScoreRecorded` |
| `close_snapshot()` | reporter | Closes a snapshot and refunds its rent |
| `initialize_preferences(threshold, reporter)` | owner | Registers a threshold and the trusted reporter |
| `update_preferences(threshold, reporter)` | owner | Changes either |
| `close_preference()` | owner | Reclaims the preference's rent |

The timestamp is client-supplied so the address is derivable before the
write, and checked against the cluster clock (±15 minutes) so nobody can mint
snapshots at arbitrary points in a wallet's history.

### Run it against your own engine

```bash
cd sentra/backend
npm run init                 # checks the program is deployed and the reporter is funded
# then in .env:
ENABLE_ONCHAIN_WRITES=true
RPC_URL=https://api.devnet.solana.com
```

To register a threshold for a wallet you hold, sign with that wallet's key:

```bash
npm run preferences -- --threshold 60 --reporter <the engine's reporter key>
npm run preferences -- --show
```

To deploy your own copy of the program: `anchor build && anchor deploy
--provider.cluster devnet` in `sentra/`, then `anchor idl init` so explorers can
decode it. For a build others can reproduce, `solana-verify build
--library-name sentra` in `sentra/` produces the binary in the standard
container; deploy that one. `anchor build` regenerates
`backend/src/idl/sentra.json`; without the SBF toolchain,
`node scripts/gen-idl.js` reproduces it byte for byte, and CI fails if the
bundled copy has drifted from the program.

---

## Try it

**Hosted dashboard:** [abhist17.github.io/sentra](https://abhist17.github.io/sentra/)

It opens with demo data — two example books holding similar value but carrying
very different risk, which is the argument the whole product makes. Everything
is labelled as synthetic; nothing pretends to be live.

For real numbers, point it at an engine. Start one locally and it connects
straight away:

```bash
git clone https://github.com/Abhist17/sentra
cd sentra/sentra/backend
npm install
npm run dev          # engine on http://localhost:4000
```

Then open the hosted dashboard and use **Connect to an engine** → `http://localhost:4000`.

No API keys, no wallet, no Solana toolchain required — the engine runs read-only
out of the box and ships with a demo wallet already monitored. The first run
fetches 30 days of history for ten assets, which takes about a minute at the
public feed's pace; prices and market stress show immediately, scoring starts
when the series land, and every later start scores at once from cache.

> Browsers block a page served over HTTPS from calling a loopback address
> unless the server opts in. The engine sends the required
> `Access-Control-Allow-Private-Network` header by default, which is what makes
> this work. If you would rather not have that, set `ALLOW_PRIVATE_NETWORK=false`
> and run the dashboard locally too — see below.

### Or run the whole stack

```bash
docker compose up
# dashboard  http://localhost:3000
# engine     http://localhost:4000
```

---

## Deploy your own

### Engine → Render

The repo includes a [`render.yaml`](render.yaml) blueprint.

1. **Render → New → Blueprint**, point it at your fork
2. Accept the defaults — every secret is optional
3. Copy the resulting URL, e.g. `https://sentra-engine.onrender.com`

The blueprint provisions the service, generates an `API_KEY` for the write
routes, and sets a health check.

> Render's free tier sleeps after inactivity, so the first request after a
> quiet period takes a few seconds and the risk history starts fresh.

**Worth setting:**

| Variable | Why |
|:--|:--|
| `MAINNET_RPC_URL` | The public Solana endpoint rate-limits hard. Use Helius or QuickNode. |
| `CORS_ORIGIN` | Lock to your dashboard's origin instead of `*`. |
| `ALLOW_PRIVATE_NETWORK` | Leave `true` only if you drive this engine from a page on another origin. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Enables alerts. |
| `COINGECKO_API_KEY` | Raises the price-feed rate limit. |
| `ENABLE_ONCHAIN_WRITES` + `SOLANA_SECRET_KEY` | Anchors scores on-chain. Costs the reporter rent — see above. |

### Dashboard → GitHub Pages

Already wired up. [`deploy-pages.yml`](.github/workflows/deploy-pages.yml)
builds the static export and publishes it on every push to `main`.

To give your deployment a default engine, set the repository variable
`NEXT_PUBLIC_API_URL` to your Render URL
(**Settings → Secrets and variables → Actions → Variables**). Without it the
dashboard simply asks each visitor which engine to connect to.

### Anywhere else

Both services have a `Dockerfile`. The dashboard is a plain static bundle, so
Vercel, Netlify, Cloudflare Pages and S3 all work — set the root directory to
`sentra/frontend` and leave `NEXT_PUBLIC_BASE_PATH` unset.

---

## The dashboard

Built as a working instrument rather than a landing page.

- **Colour carries meaning, nothing else.** The interface is monochrome; colour
  appears only for risk band and asset allocation. When something is coloured on
  screen, it is telling you something. The correlation grid is deliberately
  grey: a correlation is neither a risk nor an asset.
- **The on-chain record links out, not in.** Each anchored reading is a row
  with the score, the book, the VaR, and links to the transaction and account
  on Solana Explorer. The panel names the program and reporter to verify
  against rather than asking to be believed. Anchored points are marked on the
  trend chart.
- **Keyboard-first.** `j`/`k` or arrows move between wallets, `/` adds one. The
  trend chart takes focus too — left/right step through the series, home/end
  jump to either end.
- **The time axis is real.** Points are placed by timestamp, not by index, and
  a gap wider than the usual cadence breaks the line instead of drawing across
  it. An engine that was off for three hours looks like it was off for three
  hours.
- **Sparklines** in the wallet list: the current score says which book is worst
  now, the shape says which is getting worse.
- **Every figure is traceable.** The score breakdown shows exactly which
  component contributed what.
- **Honest states.** A degraded price feed, a stale tick, an engine error, a
  failed anchor and incomplete return coverage each say so explicitly rather
  than rendering a confident-looking number.
- **Announced, not just coloured.** Risk-band and engine-state changes reach a
  live region, so the transitions colour carries are not sighted-only.
- Light and dark, following your system preference.
- Charts are hand-rolled SVG — no charting dependency.

---

## Architecture

```mermaid
flowchart LR
    subgraph feeds["External data"]
        direction TB
        CG["CoinGecko<br/>live quotes + 30-day history<br/>for ten assets"]
        RPC["Solana mainnet RPC<br/>SOL and SPL token balances"]
    end

    subgraph engine["Sentra engine — Node, Express, TypeScript"]
        direction TB
        PRICE["price.service<br/>asset table, retry, cache,<br/>measures the sampling interval"]
        CHAIN["blockchain.service<br/>balance reads,<br/>snapshot writes as reporter"]
        LOOP["risk.engine<br/>tick loop, stress signals,<br/>blended score, anchoring policy"]
        QUANT["risk.service — quant core<br/>EWMA covariance + correlation,<br/>VaR, Expected Shortfall,<br/>Euler attribution, concentration"]
        STORE["metrics.store<br/>ring buffers: risk history,<br/>on-chain anchors"]
        REST["REST API<br/>/overview, /onchain,<br/>/snapshots, /health, /ready"]
        DISK[("DATA_DIR<br/>registry, price cache,<br/>risk history")]
    end

    subgraph out["Outputs"]
        direction TB
        DASH["Dashboard<br/>Next.js static export<br/>on GitHub Pages"]
        TG["Telegram alert"]
        PROG["Sentra program on devnet<br/>RiskSnapshot accounts,<br/>RiskScoreRecorded events"]
    end

    CG --> PRICE
    RPC --> CHAIN
    PRICE --> LOOP
    CHAIN --> LOOP
    LOOP <--> QUANT
    LOOP --> STORE
    STORE --> REST
    PRICE -.-> DISK
    STORE -.-> DISK

    REST --> DASH
    LOOP --> TG
    CHAIN --> PROG
    PROG -.->|read back| CHAIN
```

Two clusters, deliberately. Balances are **read** from mainnet, because that is
where the money is. Snapshots are **written** to devnet, because anchoring a
score should not cost mainnet rent to demonstrate — and the program is one
`anchor deploy` from either. The quant core is pure — no network, no clock,
no I/O — which is why it is the part with the most tests.

### What happens in one tick

```mermaid
sequenceDiagram
    autonumber
    participant T as risk.engine
    participant P as price.service
    participant C as blockchain.service
    participant Q as quant core
    participant S as metrics.store
    participant A as Telegram
    participant X as Sentra program

    T->>P: fetch live quotes
    P-->>T: prices, or last good ones flagged stale
    Note over T: rapid drops, volatility spikes and<br/>correlated drawdowns become a stress score
    T-)P: refresh 30-day history if stale (runs beside the tick)
    P-->>T: series + measured sampling interval + correlation

    loop each monitored wallet
        T->>C: read SOL and SPL balances
        C-->>T: holdings
        T->>Q: weights by symbol + return series
        Q-->>T: VaR, ES, attribution, concentration
        Note over T: blend into one score, 0-100
        T->>S: write metrics and one history point
        alt first reading, hourly, or band crossed
            T->>C: anchor score, value, VaR
            C->>X: record_risk_score as reporter
            X-->>C: snapshot account + signature
            C-->>S: remember the anchor
        end
    end

    alt score above threshold
        T->>A: alert, rate-limited per wallet
    end
```

A tick that overruns skips the next slot rather than overlapping it, and a
wallet removed mid-tick is discarded rather than written back. A failed
anchor is reported on the dashboard and not retried until the next scheduled
one — a problem rent can cause, a retry every 30 seconds cannot fix.

### What a user does

```mermaid
flowchart TD
    START(["Open the dashboard"]) --> CHECK{"Engine<br/>reachable?"}

    CHECK -- no --> DEMO["Clearly labelled demo data:<br/>two books, same balance,<br/>very different risk"]
    DEMO --> CONNECT["Connect an engine<br/>stored per browser"]
    CONNECT --> CHECK

    CHECK -- yes --> LIVE["Live wallets, scored"]
    LIVE --> RO{"Engine accepts<br/>changes?"}
    RO -- "no, API key set" --> BROWSE["Browse the scored book"]
    RO -- yes --> ADD["Add a Solana address"]

    ADD --> TICK["Next tick prices the wallet"]
    BROWSE --> SCORE
    TICK --> SCORE["VaR, Expected Shortfall,<br/>risk attribution, correlation,<br/>blended score"]

    SCORE --> READ["See where the risk is,<br/>not just where the value is"]
    SCORE --> ALERT{"Above the<br/>alert threshold?"}
    ALERT -- yes --> TG["Telegram alert"]
    ALERT -- no --> WATCH["Keep watching"]
    SCORE --> SNAP["Anchored on-chain:<br/>open the account, check the reporter"]
```

### Repository layout

```
sentra/
├── sentra/
│   ├── frontend/            Next.js dashboard (static export)
│   │   ├── app/                 page + design tokens
│   │   ├── components/          dial, trend chart, tables, on-chain record, correlation
│   │   └── lib/                 API client, formatting, explorer links, theming
│   │
│   ├── backend/             Express API + quant engine
│   │   ├── src/engine/          risk.engine.ts — the tick loop and anchoring policy
│   │   ├── src/services/        asset table + prices, risk math, chain, telegram, registry
│   │   ├── src/store/           in-memory metrics, risk history, anchors
│   │   ├── src/init.ts          on-chain pre-flight (npm run init)
│   │   ├── src/preferences.ts   owner CLI for thresholds (npm run preferences)
│   │   └── src/__tests__/       unit tests for the quant core, API, store, anchoring
│   │
│   ├── programs/sentra/     Anchor program (Rust)
│   ├── tests/               Anchor integration tests (20 cases on a local validator)
│   └── scripts/gen-idl.js   regenerates the bundled IDL; --check guards drift in CI
│
├── docs/                    screenshot, submission notes, capstone papers
├── render.yaml              engine blueprint
└── docker-compose.yml       full local stack
```

| Layer | Technology |
|:--|:--|
| Dashboard | Next.js 16 · React 19 · Tailwind CSS 4 |
| Engine | Node.js · Express 5 · TypeScript |
| Program | Rust · Anchor 0.32 · deployed on devnet, reproducible build |
| Price feed | CoinGecko |
| Alerts | Telegram Bot API |

---

## API

The engine is a plain REST service — the dashboard is only one possible client.

| Method | Route | Purpose |
|:--|:--|:--|
| `GET` | `/health` | Liveness, build version, engine state, on-chain summary |
| `GET` | `/ready` | Readiness — 503 with the failing checks when not scoring |
| `GET` | `/overview` | Everything the dashboard needs, in one call |
| `GET` | `/onchain` | Program id, cluster, reporter key, anchoring cadence, last error |
| `GET` | `/snapshots?wallet=&all=` | On-chain snapshots read back from the chain; `all=1` includes other reporters |
| `GET` | `/preferences?wallet=` | A wallet owner's on-chain threshold and named reporter |
| `GET` | `/risk` | Value-weighted risk across all wallets |
| `GET` | `/portfolio` | Total exposure and aggregate VaR |
| `GET` | `/prices` · `/market` | Live quotes, per-tick changes, stress signals, correlation |
| `GET` | `/history?wallet=` | Risk series, persisted across restarts |
| `GET` | `/wallets` | Monitored wallets with their latest metrics |
| `POST` | `/wallet/add` | `{ address, label? }` |
| `DELETE` | `/wallet/remove` | `{ address }` or `?address=` |
| `POST` | `/test/alert` · `/test/shock` | Send a test Telegram message |

Write routes require an `x-api-key` header whenever `API_KEY` is set. All routes
are rate-limited per IP.

`/health` and `/ready` answer different questions on purpose. `/health` is
liveness and always returns 200 if the process can respond — point platform
probes at it. `/ready` reports whether the engine has completed a recent tick
and loaded a return series, and returns 503 naming what is failing. Failing a
platform probe on readiness would restart the container every time the public
price feed rate-limits, which a restart cannot fix.

```bash
curl https://your-engine.onrender.com/risk
# {"risk":25.85,"wallets":1,"updatedAt":1787413812004}
```

---

## Development

```bash
cd sentra

npm run install:all      # backend + frontend dependencies
npm run dev:backend      # engine  → :4000
npm run dev:frontend     # dashboard → :3000

npm test                 # backend + frontend
npm run typecheck        # both packages
anchor test              # program integration tests on a local validator
```

### Tests

191 tests. The 171 off-chain ones need no network; the 20 program tests run
against a local validator that `anchor test` starts for you — and that CI
starts too, whenever the program or its tests change.

| Suite | Count | Covers |
|:--|--:|:--|
| Quant core | 44 | Horizon scaling, EWMA, VaR/ES, historical simulation, Euler attribution, concentration, correlation |
| Market signals | 19 | Drops, volatility window, correlated drawdowns that scale with the universe, stress bands |
| On-chain, off-chain | 16 | PDA seeds byte for byte, cluster naming, anchoring policy with hysteresis, the anchor store |
| Asset table | 6 | Unique ids and mints, canonical keys, derived tables agree with the source |
| HTTP API | 28 | Routing, validation, error mapping, API key, rate limiting, CORS, readiness, on-chain routes |
| Wallet registry | 7 | Address validation, limits, persistence |
| Store | 8 | History ring buffer, and what a restart is allowed to reinstate |
| Frontend | 43 | Formatting across eight orders of magnitude, risk bands, engine status, engine-URL resolution, explorer links, asset slots |
| Program | 20 | Preferences, anchoring with and without a preference, the unnamed-reporter refusal, reporter isolation, immutability, rent reclaim |

### Configuration

Everything is environment-driven — see
[`backend/.env.example`](sentra/backend/.env.example) for the full list.

| Variable | Default | Notes |
|:--|:--|:--|
| `MONITOR_INTERVAL` | `30000` | Tick interval in ms; floor of 10s |
| `RISK_ALERT_THRESHOLD` | `25` | Score that triggers a Telegram alert |
| `HISTORY_DAYS` | `30` | Days behind the covariance matrix |
| `VAR_HORIZON_DAYS` | `1` | Reporting horizon for VaR and ES |
| `VAR_CONFIDENCE` | `0.95` | One day in twenty |
| `VAR_LAMBDA` | `0.94` | Daily-equivalent EWMA decay, rescaled to the sampling rate |
| `RELEASE` | package version | Build identifier reported by `/health` |
| `MAX_WALLETS` | `25` | Each wallet costs an RPC call per tick |
| `DATA_DIR` | `./.data` | Wallet registry, price cache and risk history — mount a volume on ephemeral hosts |
| `SIMULATION_MODE` | `false` | Synthetic portfolio for empty wallets — demos only |
| `ENABLE_ONCHAIN_WRITES` | `false` | Anchors scores on-chain; costs the reporter rent |
| `ONCHAIN_ANCHOR_INTERVAL` | `3600000` | Hourly, plus every band crossing; floor 30s |

---

## Built for

Started as the **Turbin3 Builder Cohort** capstone. v2 — the reporter-based
program, on-chain anchoring for any wallet, the ten-asset universe and the
correlation view — is the Solana build challenge submission. See
[docs/SUBMISSION.md](docs/SUBMISSION.md) for the short version.

---

<div align="center">
<sub>Risk figures are model estimates, not investment advice.</sub>
</div>
