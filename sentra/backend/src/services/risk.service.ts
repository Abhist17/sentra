export function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computeReturns(prices: number[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  return returns;
}

export function covariance(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;

  const len  = Math.min(a.length, b.length);
  const meanA = mean(a.slice(0, len));
  const meanB = mean(b.slice(0, len));

  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += (a[i] - meanA) * (b[i] - meanB);
  }

  return sum / (len - 1);
}

export function portfolioVariance(
  weights: number[],
  returnMatrix: number[][]
): number {
  // Only use assets that have both a weight and a return series
  const n = Math.min(weights.length, returnMatrix.length);

  let variance = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!returnMatrix[i] || !returnMatrix[j]) continue;
      variance += weights[i] * weights[j] * covariance(returnMatrix[i], returnMatrix[j]);
    }
  }

  return variance;
}

export function calculateVaR(
  portfolioValue: number,
  weights: number[],
  returnMatrix: number[][]
): { variance: number; sigma: number; VaR: number; riskScore: number } {
  // Guard against empty or mismatched inputs
  if (
    !weights.length ||
    !returnMatrix.length ||
    portfolioValue <= 0
  ) {
    return { variance: 0, sigma: 0, VaR: 0, riskScore: 0 };
  }

  const variance  = portfolioVariance(weights, returnMatrix);
  const sigma     = Math.sqrt(Math.max(0, variance)); // clamp negative variance
  const VaR       = 1.65 * sigma * portfolioValue;
  const riskScore = Math.min(100, (VaR / portfolioValue) * 100);

  return { variance, sigma, VaR, riskScore };
}