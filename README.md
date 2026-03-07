# Sentra 
### On-Chain Portfolio Risk Engine for Solana

> *Your wallet balance tells you what you have. Sentra tells you how much you stand to lose.*

---

## What is Sentra?

**Sentra** (from *Sentinel*) is a 24/7 on-chain portfolio risk monitoring system built on Solana. Instead of just showing your portfolio value, Sentra quantifies your actual risk exposure using **Value at Risk (VaR)** — a quant finance model used by institutional investors — and converts it into a real-time risk score stored immutably on-chain.

No more finding out what went wrong after the dump.

---

## The Problem

Crypto moves fast. Most users just refresh their wallet balance — but that tells you nothing about *how risky* your current exposure is. There's no automated on-chain system that continuously calculates portfolio risk and warns you before things go sideways.

Until now.

---

## How It Works

```
Wallet Portfolio → Backend Processing → CoinGecko Price Feed
       ↓
Quant Engine (Variance + VaR Calculation)
       ↓
Risk Score → Stored On-Chain (Solana Smart Contract)
       ↓
Threshold Crossed? → Telegram Alert Fired 🚨
```

1. **Real-Time VaR Calculation** — Portfolio variance and Value at Risk computed on every update
2. **On-Chain Risk Snapshots** — Risk scores stored as immutable records via a Solana smart contract
3. **Telegram Alerts** — Instant notifications when your portfolio crosses a risk threshold

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js / TypeScript |
| Smart Contract | Rust / Anchor (Solana) |
| Price Feed | CoinGecko API |
| Alerts | Telegram Bot API |
| Chain | Solana |

---

## Project Structure

```
sentra/
├── sentra/
│   ├── app/          # Next.js frontend
│   ├── programs/     # Anchor smart contracts (Rust)
│   ├── utils/        # Quant engine (VaR calculations)
│   └── ...
├── .gitignore
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js v18+
- Rust + Anchor CLI
- Solana CLI
- A Solana wallet (Phantom / Backpack)

### Installation

```bash
# Clone the repo
git clone https://github.com/Abhist17/sentra.git
cd sentra/sentra

# Install dependencies
npm install

# Run the frontend
npm run dev
```

### Smart Contract Deployment

```bash
# Build the Anchor program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

---

## Built For

**Turbin3 Builder Cohort** — Capstone Project

---


