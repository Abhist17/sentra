export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computeReturns(prices: number[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    // A zero or missing previous price makes the return infinite and poisons
    // every downstream variance figure — skip the sample instead.
    if (!Number.isFinite(prev) || prev === 0) continue;
    if (!Number.isFinite(prices[i])) continue;
    returns.push((prices[i] - prev) / prev);
  }

  return returns;
}

/**
 * Sample covariance. Needs at least two paired observations — with one the
 * (len - 1) denominator is zero and the result is Infinity/NaN.
 */
export function covariance(a: number[], b: number[]): number {
  if (!a || !b) return 0;

  const len = Math.min(a.length, b.length);
  if (len < 2) return 0;

  // Compare the most RECENT len observations. Slicing from the start pairs a
  // long series' oldest samples against a short series' newest ones.
  const seriesA = a.slice(a.length - len);
  const seriesB = b.slice(b.length - len);

  const meanA = mean(seriesA);
  const meanB = mean(seriesB);

  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += (seriesA[i] - meanA) * (seriesB[i] - meanB);
  }

  return sum / (len - 1);
}

export function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  return Math.sqrt(Math.max(0, covariance(arr, arr)));
}

export function portfolioVariance(
  weights: number[],
  returnMatrix: number[][]
): number {
  const n = Math.min(weights.length, returnMatrix.length);

  let variance = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!returnMatrix[i] || !returnMatrix[j]) continue;
      variance +=
        weights[i] * weights[j] * covariance(returnMatrix[i], returnMatrix[j]);
    }
  }

  return variance;
}

export function calculateVaR(
  portfolioValue: number,
  weights: number[],
  returnMatrix: number[][],
  confidenceZ = 1.65
): { variance: number; sigma: number; VaR: number; riskScore: number } {
  if (!weights.length || !returnMatrix.length || portfolioValue <= 0) {
    return { variance: 0, sigma: 0, VaR: 0, riskScore: 0 };
  }

  const variance = portfolioVariance(weights, returnMatrix);
  const sigma = Math.sqrt(Math.max(0, variance)); // clamp negative variance
  const VaR = confidenceZ * sigma * portfolioValue;
  const riskScore = Math.min(100, (VaR / portfolioValue) * 100);

  return { variance, sigma, VaR, riskScore };
}

// ── Symbol-keyed API ─────────────────────────────────────────────
// The positional API above is easy to misuse: it pairs weights[i] with
// returnMatrix[i], so if one asset's history fetch fails and its row is
// dropped, every later asset is scored against the wrong asset's returns.
// Callers should use this instead, where alignment is done by symbol.

export interface PortfolioRisk {
  variance: number;
  sigma: number;
  VaR: number;
  riskScore: number;
  /** Share of portfolio value that actually had return data behind it. */
  coverage: number;
  /** Assets holding value but missing a return series. */
  uncovered: string[];
}

export function calculatePortfolioRisk(
  portfolioValue: number,
  weightsBySymbol: Record<string, number>,
  returnsBySymbol: Record<string, number[]>,
  confidenceZ = 1.65
): PortfolioRisk {
  const empty: PortfolioRisk = {
    variance: 0,
    sigma: 0,
    VaR: 0,
    riskScore: 0,
    coverage: 0,
    uncovered: [],
  };

  if (portfolioValue <= 0) return empty;

  const symbols: string[] = [];
  const weights: number[] = [];
  const returnMatrix: number[][] = [];
  const uncovered: string[] = [];
  let coveredWeight = 0;

  for (const [symbol, weight] of Object.entries(weightsBySymbol)) {
    if (!Number.isFinite(weight) || weight <= 0) continue;

    const series = returnsBySymbol[symbol];
    if (series && series.length >= 2) {
      symbols.push(symbol);
      weights.push(weight);
      returnMatrix.push(series);
      coveredWeight += weight;
    } else {
      uncovered.push(symbol);
    }
  }

  if (!symbols.length) return { ...empty, uncovered };

  const { variance, sigma, VaR, riskScore } = calculateVaR(
    portfolioValue,
    weights,
    returnMatrix,
    confidenceZ
  );

  return { variance, sigma, VaR, riskScore, coverage: coveredWeight, uncovered };
}
