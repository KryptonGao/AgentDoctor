import { EvalComparison, EvalRun, EvalRunMetrics, EvalVerdict } from "./types.js";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest > 0 ? ` ${rest}s` : ""}`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value)}%`;
}

function formatRate01(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatMoney(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function formatChurn(churn: EvalRunMetrics["reviewChurn"]): string {
  return churn ? `+${churn.additions}/-${churn.deletions}` : "n/a";
}

interface MetricDelta {
  label: string;
  before: string;
  after: string;
  /** true when "after" is better than "before". */
  better: boolean;
  worse: boolean;
  primary: boolean;
}

/**
 * Relative tolerance for noisy continuous metrics (time, tokens, churn):
 * a 3% jitter must not flip a verdict; a real 2x jump must. First-pass rate,
 * retries, and test failure rate are exact counts and never tolerated.
 */
const RELATIVE_TOLERANCE = 0.1;
/** Absolute floor for millisecond metrics: tiny absolute jitter is noise. */
const MS_NOISE_FLOOR = 250;

function tolerated(before: number, after: number, lowerIsBetter: boolean, noiseFloor = 0) {
  const tolerance = Math.max(before * RELATIVE_TOLERANCE, noiseFloor);
  if (lowerIsBetter) {
    return {
      better: after < before - tolerance,
      worse: after > before + tolerance,
    };
  }
  return {
    better: after > before + tolerance,
    worse: after < before - tolerance,
  };
}

function exact(before: number, after: number, lowerIsBetter: boolean) {
  return lowerIsBetter
    ? { better: after < before, worse: after > before }
    : { better: after > before, worse: after < before };
}

function collectDeltas(before: EvalRunMetrics, after: EvalRunMetrics): MetricDelta[] {
  const deltas: MetricDelta[] = [];

  if (before.firstPassRate !== undefined && after.firstPassRate !== undefined) {
    const { better, worse } = exact(before.firstPassRate, after.firstPassRate, false);
    deltas.push({
      label: "first-pass rate",
      before: formatPercent(before.firstPassRate),
      after: formatPercent(after.firstPassRate),
      better,
      worse,
      primary: true,
    });
  }

  if (before.medianTimeToGreenMs !== undefined && after.medianTimeToGreenMs !== undefined) {
    const { better, worse } = tolerated(
      before.medianTimeToGreenMs,
      after.medianTimeToGreenMs,
      true,
      MS_NOISE_FLOOR
    );
    deltas.push({
      label: "median time-to-green",
      before: formatDuration(before.medianTimeToGreenMs),
      after: formatDuration(after.medianTimeToGreenMs),
      better,
      worse,
      primary: true,
    });
  }

  if (before.testFailureRate !== undefined && after.testFailureRate !== undefined) {
    const { better, worse } = exact(before.testFailureRate, after.testFailureRate, true);
    deltas.push({
      label: "test failure rate",
      before: formatRate01(before.testFailureRate),
      after: formatRate01(after.testFailureRate),
      better,
      worse,
      primary: false,
    });
  }

  if (before.totalTokens !== undefined && after.totalTokens !== undefined) {
    const { better, worse } = tolerated(before.totalTokens, after.totalTokens, true);
    deltas.push({
      label: "tokens",
      before: formatTokens(before.totalTokens),
      after: formatTokens(after.totalTokens),
      better,
      worse,
      primary: false,
    });
  }

  if (before.totalRetries !== undefined && after.totalRetries !== undefined) {
    const { better, worse } = exact(before.totalRetries, after.totalRetries, true);
    deltas.push({
      label: "retries",
      before: String(before.totalRetries),
      after: String(after.totalRetries),
      better,
      worse,
      primary: false,
    });
  }

  if (before.reviewChurn && after.reviewChurn) {
    const beforeLines = before.reviewChurn.additions + before.reviewChurn.deletions;
    const afterLines = after.reviewChurn.additions + after.reviewChurn.deletions;
    const { better, worse } = tolerated(beforeLines, afterLines, true);
    deltas.push({
      label: "review churn",
      before: formatChurn(before.reviewChurn),
      after: formatChurn(after.reviewChurn),
      better,
      worse,
      primary: false,
    });
  }

  if (before.costUsd !== undefined && after.costUsd !== undefined) {
    const { better, worse } = tolerated(before.costUsd, after.costUsd, true);
    deltas.push({
      label: "cost",
      before: formatMoney(before.costUsd),
      after: formatMoney(after.costUsd),
      better,
      worse,
      primary: false,
    });
  }

  return deltas;
}

/**
 * Compare the "before" (instructions from a baseline ref) and "after" runs.
 *
 * Verdict rule, kept deliberately strict and explainable: a regression on a
 * primary metric (first-pass rate, median time-to-green) means regressed; a
 * primary improvement with no primary regression means improved; everything
 * else (secondary-only moves, unknown metrics) is neutral.
 */
export function compareEvalRuns(before: EvalRun, after: EvalRun, baselineRef: string): EvalComparison {
  const deltas = collectDeltas(before.metrics, after.metrics);

  const regressions = deltas.filter((d) => d.worse);
  const improvements = deltas.filter((d) => d.better);
  const neutralDeltas = deltas.filter((d) => !d.worse && !d.better);

  const primaryRegressed = regressions.some((d) => d.primary);
  const primaryImproved = improvements.some((d) => d.primary);
  const verdict: EvalVerdict = primaryRegressed
    ? "regressed"
    : primaryImproved
      ? "improved"
      : "neutral";

  const formatDelta = (d: MetricDelta) =>
    `${d.label}: ${d.before} -> ${d.after}`;

  return {
    baselineRef,
    before: before.metrics,
    after: after.metrics,
    verdict,
    regressions: regressions.map(formatDelta),
    improvements: improvements.map(formatDelta),
    neutralDeltas: neutralDeltas.map(formatDelta),
  };
}
