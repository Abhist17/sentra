import { updateMetrics } from "../api/routes";
export function mean(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computeReturns(prices: number[]) {
  const returns: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    returns.push(
      (prices[i] - prices[i - 1]) / prices[i - 1]
    );
  }

  return returns;
}

export function covariance(a: number[], b: number[]) {
  const meanA = mean(a);
  const meanB = mean(b);

  let sum = 0;

  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - meanA) * (b[i] - meanB);
  }

  return sum / (a.length - 1);
}

export function portfolioVariance(
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

export function calculateVaR(
  portfolioValue: number,
  weights: number[],
  returnMatrix: number[][]
) {
  const variance = portfolioVariance(weights, returnMatrix);
  const sigma = Math.sqrt(variance);

  const VaR = 1.65 * sigma * portfolioValue;

  const riskScore = Math.min(
    100,
    (VaR / portfolioValue) * 100
  );

  return {
    variance,
    sigma,
    VaR,
    riskScore,
  };
}