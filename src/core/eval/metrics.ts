import {
  EvalPricing,
  EvalReviewChurn,
  EvalRunMetrics,
  EvalTaskMetrics,
} from "./types.js";
import { SessionMetrics, SessionTimelineEvent } from "../types.js";

/**
 * Commands that count as "verification" when replaying session timelines.
 * Deliberately narrow: guessing a random `npm run x` as verification would
 * fabricate test-failure evidence.
 */
export const VERIFY_COMMAND_PATTERN =
  /\b(test|tests|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|lint|eslint|biome|ruff|flake8|typecheck|tsc|mypy|build|compile)\b/i;

/** Parse a timeline "mm:ss" (or "hh:mm:ss") offset into seconds. */
export function parseTimeOffset(offset: string | undefined): number | undefined {
  if (!offset) return undefined;
  const parts = offset.split(":").map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined;
  return parts.reduce((sum, p) => sum * 60 + p, 0);
}

export function isVerificationEvent(event: SessionTimelineEvent): boolean {
  return VERIFY_COMMAND_PATTERN.test(event.action || "");
}

/** Sort key for sessions: parseable dates first (chronological), stable otherwise. */
function sessionTimestamp(session: SessionMetrics): number {
  const parsed = Date.parse(session.date || "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function sortSessionsChronologically(sessions: SessionMetrics[]): SessionMetrics[] {
  return [...sessions].sort(
    (a, b) => sessionTimestamp(a) - sessionTimestamp(b) || a.id.localeCompare(b.id)
  );
}

export interface ReplayTaskEvidence {
  attempts: number;
  /** From the earliest matched session only: this is what "first pass" means. */
  firstPass?: boolean;
  passed?: boolean;
  timeToGreenMs?: number;
  retries: number;
  verifyCommandsTotal: number;
  verifyCommandsFailed: number;
  tokens?: { input: number; output: number; total: number };
  tokensUnknown: boolean;
}

/**
 * Derive effect metrics for one golden task from the sessions attributed to it.
 *
 * Definitions (documented in the README):
 * - firstPass: the earliest session reached a green verification command
 *   without any failed verification command before it.
 * - timeToGreen: offset of the first green verification command within the
 *   session that first went green. Sessions do not share a clock, so this is
 *   "time into the session that succeeded", never a fabricated cross-session sum.
 * - testFailureRate: failed verification commands / verification commands
 *   across all matched sessions.
 * - retries: native retriesCount when available; otherwise the number of
 *   failed verification commands (honest proxy, marked as such by callers).
 */
export function replayTaskEvidence(sessions: SessionMetrics[]): ReplayTaskEvidence {
  const ordered = sortSessionsChronologically(sessions);
  const evidence: ReplayTaskEvidence = {
    attempts: ordered.length,
    firstPass: undefined,
    passed: undefined,
    timeToGreenMs: undefined,
    retries: 0,
    verifyCommandsTotal: 0,
    verifyCommandsFailed: 0,
    tokens: undefined,
    tokensUnknown: ordered.length > 0,
  };

  let nativeRetries = 0;
  let allTokensKnown = ordered.length > 0;
  let tokensInput = 0;
  let tokensOutput = 0;

  for (const session of ordered) {
    nativeRetries += session.retriesCount || 0;

    if (session.tokenUsage && session.tokensUnknown !== true) {
      tokensInput += session.tokenUsage.input || 0;
      tokensOutput += session.tokenUsage.output || 0;
    } else {
      allTokensKnown = false;
    }

    let sawFailedVerify = false;
    let sawGreenVerify = false;
    let firstVerificationStatus: SessionTimelineEvent["status"] | undefined;
    for (const event of session.timeline) {
      if (!isVerificationEvent(event)) continue;
      firstVerificationStatus ??= event.status;
      evidence.verifyCommandsTotal += 1;
      if (event.status === "failed") {
        evidence.verifyCommandsFailed += 1;
        sawFailedVerify = true;
      } else if (event.status === "success" && !sawGreenVerify) {
        sawGreenVerify = true;
        const seconds = parseTimeOffset(event.timeOffset);
        if (seconds !== undefined && evidence.timeToGreenMs === undefined) {
          evidence.timeToGreenMs = seconds * 1000;
        }
      }
    }

    if (evidence.firstPass === undefined && firstVerificationStatus !== undefined) {
      evidence.firstPass = firstVerificationStatus === "success";
    }
    // A task's final status is the status of its latest verification evidence,
    // not whether some historical session happened to pass. This prevents a
    // later failed attempt from being hidden by an earlier green run.
    if (sawGreenVerify || sawFailedVerify) {
      const lastVerification = [...session.timeline]
        .filter((event) => isVerificationEvent(event))
        .at(-1);
      evidence.passed = lastVerification?.status === "success";
    }
  }

  evidence.tokensUnknown = !allTokensKnown;
  if (allTokensKnown) {
    evidence.tokens = {
      input: tokensInput,
      output: tokensOutput,
      total: tokensInput + tokensOutput,
    };
  }
  evidence.retries = nativeRetries > 0 ? nativeRetries : evidence.verifyCommandsFailed;

  return evidence;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeCost(
  tokens: { input: number; output: number } | undefined,
  pricing?: EvalPricing
): number | undefined {
  if (!tokens || !pricing) return undefined;
  const { inputPerMTok, outputPerMTok } = pricing;
  if (inputPerMTok === undefined && outputPerMTok === undefined) return undefined;
  const cost =
    (inputPerMTok ?? 0) * (tokens.input / 1_000_000) +
    (outputPerMTok ?? 0) * (tokens.output / 1_000_000);
  return Math.round(cost * 10000) / 10000;
}

export function sumChurn(values: (EvalReviewChurn | undefined)[]): EvalReviewChurn | undefined {
  const present = values.filter((v): v is EvalReviewChurn => Boolean(v));
  if (present.length === 0) return undefined;
  return present.reduce(
    (acc, v) => ({
      files: acc.files + v.files,
      additions: acc.additions + v.additions,
      deletions: acc.deletions + v.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
}

/** Aggregate per-task metrics into suite-level metrics (n/a stays n/a). */
export function aggregateRunMetrics(
  tasks: EvalTaskMetrics[],
  pricing?: EvalPricing
): EvalRunMetrics {
  const metrics: EvalRunMetrics = { taskCount: tasks.length };

  const firstPassKnown = tasks.filter((t) => typeof t.firstPass === "boolean");
  metrics.evaluatedTaskCount = firstPassKnown.length;
  metrics.unknownTaskCount = Math.max(0, tasks.length - firstPassKnown.length);
  if (tasks.length > 0) {
    metrics.coverageRate = Math.round((firstPassKnown.length / tasks.length) * 100);
  }
  // A partial suite must not report a deceptively high rate. The per-task
  // values remain available for diagnosis, while the suite rate is measurable
  // only when every golden task has evidence.
  if (firstPassKnown.length === tasks.length && tasks.length > 0) {
    metrics.firstPassRate = Math.round(
      (firstPassKnown.filter((t) => t.firstPass).length / firstPassKnown.length) * 100
    );
  }
  const passedKnown = tasks.filter((t) => typeof t.passed === "boolean");
  if (passedKnown.length > 0) {
    metrics.passedCount = passedKnown.filter((t) => t.passed).length;
  }

  const ttgs = tasks.map((t) => t.timeToGreenMs).filter((v): v is number => typeof v === "number");
  const medianTtg = median(ttgs);
  if (medianTtg !== undefined) metrics.medianTimeToGreenMs = Math.round(medianTtg);

  const tokensKnown = tasks.filter((t) => t.tokens && t.tokensUnknown !== true);
  if (tokensKnown.length === tasks.length && tasks.length > 0) {
    const input = tokensKnown.reduce((sum, t) => sum + (t.tokens?.input || 0), 0);
    const output = tokensKnown.reduce((sum, t) => sum + (t.tokens?.output || 0), 0);
    metrics.inputTokens = input;
    metrics.outputTokens = output;
    metrics.totalTokens = input + output;
    const cost = computeCost({ input, output }, pricing);
    if (cost !== undefined) metrics.costUsd = cost;
  } else if (tasks.length > 0) {
    metrics.tokensUnknown = true;
  }

  const retriesKnown = tasks.filter((t) => typeof t.retries === "number");
  if (retriesKnown.length > 0) {
    metrics.totalRetries = retriesKnown.reduce((sum, t) => sum + (t.retries || 0), 0);
  }

  const churn = sumChurn(tasks.map((t) => t.reviewChurn));
  if (churn) metrics.reviewChurn = churn;

  const verifyTotal = tasks.reduce((sum, t) => sum + (t.verifyCommandsTotal || 0), 0);
  const verifyFailed = tasks.reduce((sum, t) => sum + (t.verifyCommandsFailed || 0), 0);
  if (verifyTotal > 0) {
    metrics.testFailureRate = Math.round((verifyFailed / verifyTotal) * 100) / 100;
  }

  return metrics;
}
