import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/* ==========================
   CONFIG
========================== */

const RPC_URL = "http://127.0.0.1:8899";

const MONITOR_INTERVAL = 60 * 1000; // 1 min
const HISTORY_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour
const SHOCK_THRESHOLD = 5; // %
const RISK_ALERT_THRESHOLD = 25; // Risk %
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 min

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const COINGECKO_SIMPLE =
  "https://api.coingecko.com/api/v3/simple/price";

const COINGECKO_HISTORY =
  "https://api.coingecko.com/api/v3/coins";

/* ==========================
   TRACKED ASSETS
========================== */

const TRACKED_ASSETS = {
  SOL: "solana",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
  USDC: "usd-coin",
};

/* ==========================
   WALLET
========================== */

const keypair = anchor.web3.Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync(
        "/home/abhi/.config/solana/id.json",
        "utf-8"
      )
    )
  )
);

/* ==========================
   TELEGRAM
========================== */

async function sendTelegramAlert(message: string) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }
    );
    console.log("📩 Alert sent");
  } catch (err) {
    console.log("Telegram error (ignored)");
  }
}

/* ==========================
   MATH
========================== */

function mean(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeReturns(prices: number[]) {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(
      (prices[i] - prices[i - 1]) / prices[i - 1]
    );
  }
  return returns;
}

function covariance(a: number[], b: number[]) {
  const meanA = mean(a);
  const meanB = mean(b);
  let sum = 0;

  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - meanA) * (b[i] - meanB);
  }

  return sum / (a.length - 1);
}

function portfolioVariance(
  weights: number[],
  returnMatrix: number[][]
) {
  let variance = 0;

  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) {
      variance +=
        weights[i] *
        weights[j] *
        covariance(returnMatrix[i], returnMatrix[j]);
    }
  }

  return variance;
}

/* ==========================
   DATA FETCH
========================== */

async function fetchLivePrices() {
  const ids = Object.values(TRACKED_ASSETS).join(",");

  const res = await axios.get(COINGECKO_SIMPLE, {
    params: {
      ids,
      vs_currencies: "usd",
    },
  });

  const data = res.data;

  return {
    SOL: data["solana"]?.usd || 0,
    BONK: data["bonk"]?.usd || 0,
    JUP: data["jupiter-exchange-solana"]?.usd || 0,
    USDC: data["usd-coin"]?.usd || 1,
  };
}

async function fetchHistory(coinId: string) {
  const res = await axios.get(
    `${COINGECKO_HISTORY}/${coinId}/market_chart`,
    {
      params: {
        vs_currency: "usd",
        days: 30,
      },
    }
  );

  if (!res.data?.prices) return [];

  return res.data.prices.map((p: any) => p[1]);
}

/* ==========================
   ENGINE
========================== */

async function startEngine() {
  console.log("🚀 Sentra Quant Engine Running\n");

  const connection = new Connection(RPC_URL, "confirmed");

  const wallet = new anchor.Wallet(keypair);
  const provider =
    new anchor.AnchorProvider(connection, wallet, {});

  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      "../target/idl/sentra.json",
      "utf-8"
    )
  );

  const program = new anchor.Program(
    idl as anchor.Idl,
    provider
  );

  const user = keypair.publicKey;

  let cachedReturnMatrix: number[][] = [];
  let lastHistoryFetch = 0;

  let lastPrice = 0;
  let lastAlertTime = 0;

  setInterval(async () => {
    try {
      /* ===== Live Prices ===== */

      const prices = await fetchLivePrices();

      const solBalance =
        (await connection.getBalance(user)) /
        1e9;

      const portfolio = [
        { symbol: "SOL", amount: solBalance },
        { symbol: "BONK", amount: 0 },
        { symbol: "JUP", amount: 0 },
        { symbol: "USDC", amount: 0 },
      ];

      const portfolioValue = portfolio.reduce(
        (sum, asset) =>
          sum +
          asset.amount *
            prices[
              asset.symbol as keyof typeof prices
            ],
        0
      );

      /* ===== Shock Detection ===== */

      const currentPrice = prices.SOL;

      if (lastPrice !== 0) {
        const change =
          ((currentPrice - lastPrice) /
            lastPrice) *
          100;

        if (
          change <= -SHOCK_THRESHOLD &&
          Date.now() - lastAlertTime >
            ALERT_COOLDOWN
        ) {
          await sendTelegramAlert(
            `⚠️ MARKET SHOCK\nSOL dropped ${change.toFixed(
              2
            )}%`
          );
          lastAlertTime = Date.now();
        }
      }

      lastPrice = currentPrice;

      /* ===== Historical Cache ===== */

      if (
        cachedReturnMatrix.length === 0 ||
        Date.now() - lastHistoryFetch >
          HISTORY_REFRESH_INTERVAL
      ) {
        console.log("Refreshing historical data...");

        const newMatrix: number[][] = [];

        for (const coinId of Object.values(
          TRACKED_ASSETS
        )) {
          try {
            const history =
              await fetchHistory(coinId);

            if (history.length > 2) {
              newMatrix.push(
                computeReturns(history)
              );
            }
          } catch {
            console.log(
              `History failed for ${coinId}`
            );
          }
        }

        cachedReturnMatrix = newMatrix;
        lastHistoryFetch = Date.now();
      }

      if (cachedReturnMatrix.length === 0) {
        console.log(
          "Waiting for historical data..."
        );
        return;
      }

      /* ===== VaR Calculation ===== */

      const weights = portfolio.map(
        (asset) =>
          (asset.amount *
            prices[
              asset.symbol as keyof typeof prices
            ]) /
          portfolioValue
      );

      const variance = portfolioVariance(
        weights,
        cachedReturnMatrix
      );

      const sigma = Math.sqrt(variance);

      const VaR =
        1.65 * sigma * portfolioValue;

      const riskScore = Math.min(
        100,
        (VaR / portfolioValue) * 100
      );

      console.log(
        `Portfolio: $${portfolioValue.toFixed(
          2
        )} | Risk: ${riskScore.toFixed(2)}`
      );

      /* ===== Risk Alert ===== */

      if (
        riskScore >= RISK_ALERT_THRESHOLD &&
        Date.now() - lastAlertTime >
          ALERT_COOLDOWN
      ) {
        await sendTelegramAlert(
          `⚠️ HIGH RISK\nScore: ${riskScore.toFixed(
            2
          )}`
        );
        lastAlertTime = Date.now();
      }

      /* ===== On-Chain Record ===== */

      const [preferencePda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from(
              "risk_preference"
            ),
            user.toBuffer(),
          ],
          program.programId
        );

      const timestamp =
        Math.floor(Date.now() / 1000);

      const timestampBN =
        new anchor.BN(timestamp);

      const [snapshotPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from(
              "risk_snapshot"
            ),
            user.toBuffer(),
            timestampBN.toArrayLike(
              Buffer,
              "le",
              8
            ),
          ],
          program.programId
        );

      await program.methods
        .recordRiskScore(
          Math.floor(riskScore),
          timestampBN
        )
        .accounts({
          preference: preferencePda,
          snapshot: snapshotPda,
          user: user,
          systemProgram:
            anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      console.log("Engine error (ignored)");
    }
  }, MONITOR_INTERVAL);
}

startEngine();
