export const walletMetrics: Map<
  string,
  { risk: number; portfolio: number; updatedAt: number }
> = new Map();

let latestRisk = 0;
let latestPortfolio = 0;

export function updateMetrics(
  risk: number,
  portfolio: number,
  address?: string
) {
  latestRisk = risk;
  latestPortfolio = portfolio;

  if (address) {
    walletMetrics.set(address, {
      risk,
      portfolio,
      updatedAt: Date.now(),
    });
  }
}

export function getLatestMetrics() {
  return {
    risk: latestRisk,
    portfolio: latestPortfolio,
  };
}