/**
 * Quant core.
 *
 * Two things matter here and both were wrong or missing before:
 *
 *  1. HORIZON. Returns arrive at whatever cadence the price feed provides
 *     (CoinGecko gives hourly data for a 30-day window). Volatility computed
 *     from those is per-period, not per-day, so it must be scaled explicitly.
 *     Nothing infers the horizon — callers pass `periodsPerDay` derived from
 *     the data's own timestamps.
 *
 *  2. TAILS. Parametric normal VaR structurally understates crypto downside.
 *     Every figure is therefore reported two ways — parametric (responsive,
 *     via EWMA) and historical simulation (fat-tail aware) — plus Expected
 *     Shortfall, which describes the loss *given* a breach rather than just
 *     the threshold at which one starts.
 */

// ── Basic statistics ─────────────────────────────────────────────

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

/**
 * Exponentially weighted covariance (RiskMetrics).
 *
 * Equal weighting treats a return from 30 days ago as being as informative as
 * yesterday's, which makes the model slow exactly when a risk number needs to
 * move. lambda = 0.94 is the RiskMetrics daily default; effective memory is
 * about 1/(1-lambda) ~= 17 observations.
 *
 * Zero-mean by convention: over short horizons the sample mean is
 * indistinguishable from noise, and estimating it adds variance to the
 * estimator without adding information.
 */
export const DEFAULT_LAMBDA = 0.94;

/**
 * Rescales a DAILY decay factor to the series' actual sampling frequency.
 *
 * lambda = 0.94 is RiskMetrics' daily default, giving an effective memory of
 * 1/(1-lambda) ~= 17 days. Applied unchanged to hourly observations it means
 * 17 *hours*, and the estimator stops measuring volatility and starts
 * measuring intraday noise — on real SOL data that inflated a one-day VaR
 * from ~4.3% to ~9.2%, more than double the realised figure.
 *
 * Holding the memory constant in calendar terms:
 *   lambdaPeriod = 1 - (1 - lambdaDaily) / periodsPerDay
 * so hourly data (24/day) turns 0.94 into 0.9975.
 */
export function scaleLambdaToFrequency(
  dailyLambda: number,
  periodsPerDay: number
): number {
  if (!(periodsPerDay > 0) || !(dailyLambda > 0 && dailyLambda < 1)) {
    return dailyLambda;
  }
  if (periodsPerDay <= 1) return dailyLambda;

  const scaled = 1 - (1 - dailyLambda) / periodsPerDay;
  // Guard the numerical edge — a very high frequency pushes lambda toward 1.
  return Math.min(0.99999, Math.max(0.5, scaled));
}

export function ewmaCovariance(
  a: number[],
  b: number[],
  lambda = DEFAULT_LAMBDA
): number {
  if (!a || !b) return 0;

  const len = Math.min(a.length, b.length);
  if (len < 2) return 0;
  if (!(lambda > 0 && lambda < 1)) return covariance(a, b);

  const seriesA = a.slice(a.length - len);
  const seriesB = b.slice(b.length - len);

  let weighted = 0;
  let weightSum = 0;

  for (let i = 0; i < len; i++) {
    // Newest observation (i = len-1) gets weight 1, decaying backwards.
    const weight = Math.pow(lambda, len - 1 - i);
    weighted += weight * seriesA[i] * seriesB[i];
    weightSum += weight;
  }

  // Normalising by the realised weight sum removes the truncation bias from
  // using a finite window of a nominally infinite series.
  return weightSum > 0 ? weighted / weightSum : 0;
}

export function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  return Math.sqrt(Math.max(0, covariance(arr, arr)));
}

export function portfolioVariance(
  weights: number[],
  returnMatrix: number[][],
  estimator: (a: number[], b: number[]) => number = covariance
): number {
  const n = Math.min(weights.length, returnMatrix.length);

  let variance = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!returnMatrix[i] || !returnMatrix[j]) continue;
      variance +=
        weights[i] * weights[j] * estimator(returnMatrix[i], returnMatrix[j]);
    }
  }

  return variance;
}

// ── Normal distribution helpers ──────────────────────────────────

/** Standard normal probability density. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation), accurate to
 * ~1.15e-9 — far beyond what a 30-day sample of crypto prices can justify.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Empirical quantile by linear interpolation on a sorted sample. */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ── Horizon aggregation ──────────────────────────────────────────

/**
 * Compounds a per-period return series into overlapping k-period returns.
 *
 * Using this rather than scaling a per-period quantile by sqrt(k) is the point
 * of historical simulation: multi-period compounding preserves the fat tails
 * and skew that the square-root rule assumes away.
 */
export function aggregateReturns(returns: number[], k: number): number[] {
  const periods = Math.max(1, Math.round(k));
  if (periods === 1) return returns.slice();
  if (returns.length < periods) return [];

  const out: number[] = [];
  for (let end = periods; end <= returns.length; end++) {
    let growth = 1;
    for (let i = end - periods; i < end; i++) growth *= 1 + returns[i];
    out.push(growth - 1);
  }
  return out;
}

// ── Portfolio risk ───────────────────────────────────────────────

export interface RiskInputs {
  portfolioValue: number;
  weightsBySymbol: Record<string, number>;
  returnsBySymbol: Record<string, number[]>;
  /** Observations per day, derived from the price series' own timestamps. */
  periodsPerDay: number;
  /** Reporting horizon. 1 = one-day VaR. */
  horizonDays?: number;
  /** Confidence level for VaR, e.g. 0.95. */
  confidence?: number;
  /** DAILY-equivalent EWMA decay; rescaled internally to the sampling rate. */
  lambda?: number;
}

/**
 * Per-asset decomposition of portfolio risk (Euler allocation).
 *
 * Weight is not risk. A position can be 97% of a book's value and 99.4% of its
 * risk, or 20% of value and 60% of risk — and only the second number tells you
 * what to sell. Component VaRs sum exactly to portfolio VaR, so the split is a
 * true attribution rather than a heuristic.
 */
export interface RiskContribution {
  symbol: string;
  /** Share of portfolio VALUE, 0-1. */
  weight: number;
  /** Share of portfolio RISK, 0-1. Sums to 1 across assets. */
  riskShare: number;
  /** This asset's slice of the headline VaR, in USD. */
  componentVarUsd: number;
  /** dVaR/dw: the VaR change from adding one unit of this asset. */
  marginalVar: number;
  /** Standalone volatility at the reporting horizon. */
  volHorizon: number;
}

export interface PortfolioRisk {
  /** Per-period portfolio volatility (EWMA). */
  sigmaPeriod: number;
  /** Volatility scaled to the reporting horizon. */
  sigmaHorizon: number;

  /** Parametric (normal, EWMA) figures as a share of portfolio value. */
  varPct: number;
  varUsd: number;
  esPct: number;
  esUsd: number;

  /** Historical simulation over compounded horizon returns. */
  histVarPct: number;
  histVarUsd: number;
  histEsPct: number;
  histEsUsd: number;

  /**
   * Headline loss estimate: the more conservative of the two models.
   * Reporting the smaller of two defensible numbers would be choosing the
   * flattering one.
   */
  headlineVarPct: number;
  headlineVarUsd: number;
  headlineEsUsd: number;
  headlineModel: "parametric" | "historical";

  /** Score fed into the blended risk number, 0-100. */
  riskScore: number;

  /** Per-asset risk attribution, largest contributor first. */
  contributions: RiskContribution[];
  /**
   * Weighted average of standalone volatilities divided by portfolio
   * volatility. 1.0 means the assets move as one and diversification is
   * buying nothing; higher is better.
   */
  diversificationRatio: number;

  /** Share of portfolio value with a return series behind it, 0-1. */
  coverage: number;
  uncovered: string[];
  /** Overlapping horizon-return samples behind the historical figures. */
  observations: number;
  /**
   * Non-overlapping equivalents. Overlapping windows inflate the apparent
   * sample size without adding information, so this is what actually governs
   * how much the historical tail can be trusted.
   */
  independentObservations: number;
  /** Decay actually applied, after rescaling to the sampling frequency. */
  lambdaApplied: number;
  horizonDays: number;
  confidence: number;
}

const EMPTY: PortfolioRisk = {
  sigmaPeriod: 0,
  sigmaHorizon: 0,
  varPct: 0,
  varUsd: 0,
  esPct: 0,
  esUsd: 0,
  histVarPct: 0,
  histVarUsd: 0,
  histEsPct: 0,
  histEsUsd: 0,
  headlineVarPct: 0,
  headlineVarUsd: 0,
  headlineEsUsd: 0,
  headlineModel: "parametric",
  riskScore: 0,
  contributions: [],
  diversificationRatio: 1,
  coverage: 0,
  uncovered: [],
  observations: 0,
  independentObservations: 0,
  lambdaApplied: DEFAULT_LAMBDA,
  horizonDays: 1,
  confidence: 0.95,
};

/**
 * Below this the empirical tail is a handful of points and the quantile is
 * noise rather than an estimate, so historical simulation is not reported.
 */
export const MIN_HISTORICAL_OBSERVATIONS = 30;

export function calculatePortfolioRisk(inputs: RiskInputs): PortfolioRisk {
  const {
    portfolioValue,
    weightsBySymbol,
    returnsBySymbol,
    periodsPerDay,
    horizonDays = 1,
    confidence = 0.95,
    lambda = DEFAULT_LAMBDA,
  } = inputs;

  if (portfolioValue <= 0 || !(periodsPerDay > 0)) {
    return { ...EMPTY, horizonDays, confidence };
  }

  // Align weights to return series by SYMBOL. Positional alignment silently
  // pairs one asset's weight with another asset's returns whenever a series
  // is missing.
  const symbols: string[] = [];
  const weights: number[] = [];
  const matrix: number[][] = [];
  const uncovered: string[] = [];
  let coveredWeight = 0;

  for (const [symbol, weight] of Object.entries(weightsBySymbol)) {
    if (!Number.isFinite(weight) || weight <= 0) continue;

    const series = returnsBySymbol[symbol];
    if (series && series.length >= 2) {
      symbols.push(symbol);
      weights.push(weight);
      matrix.push(series);
      coveredWeight += weight;
    } else {
      uncovered.push(symbol);
    }
  }

  if (!symbols.length) {
    return { ...EMPTY, uncovered, horizonDays, confidence };
  }

  // ── Parametric: EWMA covariance, scaled by sqrt of time ────────
  // lambda arrives as a daily-equivalent and is rescaled to the observation
  // frequency, so the estimator's memory is a fixed number of DAYS whatever
  // cadence the feed happens to deliver.
  const lambdaApplied = scaleLambdaToFrequency(lambda, periodsPerDay);
  const variance = portfolioVariance(weights, matrix, (a, b) =>
    ewmaCovariance(a, b, lambdaApplied)
  );
  const sigmaPeriod = Math.sqrt(Math.max(0, variance));
  const periodsInHorizon = periodsPerDay * horizonDays;
  const sigmaHorizon = sigmaPeriod * Math.sqrt(periodsInHorizon);

  const z = normalQuantile(confidence);
  const varPct = Math.min(100, sigmaHorizon * z * 100);
  // ES for a normal loss distribution: sigma * phi(z) / (1 - c).
  const esPct = Math.min(
    100,
    sigmaHorizon * (normalPdf(z) / (1 - confidence)) * 100
  );

  // ── Historical simulation over compounded horizon returns ──────
  const aligned = Math.min(...matrix.map((s) => s.length));
  const portfolioReturns: number[] = [];

  for (let i = 0; i < aligned; i++) {
    let r = 0;
    for (let a = 0; a < matrix.length; a++) {
      const series = matrix[a];
      r += weights[a] * series[series.length - aligned + i];
    }
    portfolioReturns.push(r);
  }

  const horizonReturns = aggregateReturns(
    portfolioReturns,
    Math.round(periodsInHorizon)
  );

  let histVarPct = 0;
  let histEsPct = 0;

  if (horizonReturns.length >= MIN_HISTORICAL_OBSERVATIONS) {
    const sorted = [...horizonReturns].sort((a, b) => a - b);
    const cutoff = quantile(sorted, 1 - confidence);

    histVarPct = Math.min(100, Math.max(0, -cutoff) * 100);

    // ES is the mean of the losses at or beyond the VaR cutoff.
    const tail = sorted.filter((r) => r <= cutoff);
    if (tail.length > 0) {
      histEsPct = Math.min(100, Math.max(0, -mean(tail)) * 100);
    }
  }

  const useHistorical = histVarPct > varPct;
  const headlineVarPct = useHistorical ? histVarPct : varPct;
  const headlineEsPct = useHistorical ? histEsPct : esPct;
  const headlineVarUsd = (headlineVarPct / 100) * portfolioValue;

  // ── Risk attribution (Euler decomposition) ─────────────────────
  // Component VaR_i = w_i * (Sigma w)_i / sigma_p * VaR, and the components
  // sum to VaR exactly. This is what turns "you hold a lot of SOL" into
  // "SOL is 99% of what you stand to lose".
  const contributions: RiskContribution[] = [];
  let weightedStandaloneVol = 0;

  if (sigmaPeriod > 0) {
    const horizonScale = Math.sqrt(periodsInHorizon);

    for (let i = 0; i < symbols.length; i++) {
      // (Sigma w)_i — this asset's row of the covariance matrix times weights.
      let covRow = 0;
      for (let j = 0; j < symbols.length; j++) {
        covRow += weights[j] * ewmaCovariance(matrix[i], matrix[j], lambdaApplied);
      }

      const marginal = covRow / sigmaPeriod;
      const componentSigma = weights[i] * marginal;
      const riskShare = componentSigma / sigmaPeriod;

      const standaloneVol =
        Math.sqrt(Math.max(0, ewmaCovariance(matrix[i], matrix[i], lambdaApplied))) *
        horizonScale;
      weightedStandaloneVol += weights[i] * standaloneVol;

      contributions.push({
        symbol: symbols[i],
        weight: weights[i],
        riskShare,
        componentVarUsd: riskShare * headlineVarUsd,
        marginalVar: marginal * horizonScale,
        volHorizon: standaloneVol,
      });
    }

    contributions.sort((a, b) => b.riskShare - a.riskShare);
  }

  const diversificationRatio =
    sigmaHorizon > 0 && weightedStandaloneVol > 0
      ? weightedStandaloneVol / sigmaHorizon
      : 1;

  return {
    sigmaPeriod,
    sigmaHorizon,
    varPct,
    varUsd: (varPct / 100) * portfolioValue,
    esPct,
    esUsd: (esPct / 100) * portfolioValue,
    histVarPct,
    histVarUsd: (histVarPct / 100) * portfolioValue,
    histEsPct,
    histEsUsd: (histEsPct / 100) * portfolioValue,
    headlineVarPct,
    headlineVarUsd,
    headlineEsUsd: (headlineEsPct / 100) * portfolioValue,
    headlineModel: useHistorical ? "historical" : "parametric",
    riskScore: Math.min(100, headlineVarPct),
    contributions,
    diversificationRatio,
    coverage: coveredWeight,
    uncovered,
    observations: horizonReturns.length,
    independentObservations: Math.floor(
      horizonReturns.length / Math.max(1, Math.round(periodsInHorizon))
    ),
    lambdaApplied,
    horizonDays,
    confidence,
  };
}
