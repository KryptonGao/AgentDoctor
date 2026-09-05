import {
  CHECK_SCHEMA_VERSION,
  CheckResult,
  FindingSeverity,
  ScanResult,
} from "../types.js";
import { createFindingFingerprint, flattenFindings } from "../findings/identity.js";
import {
  archiveGitRef,
  getGitRoot,
  removeTemporaryDirectory,
  resolveGitRef,
} from "../../shared/git.js";
import { scanRepository } from "../scan/scanner.js";
import {
  compareScanResults,
  hasRegressionAtLeast,
  isSeverityAtLeast,
} from "./comparator.js";

export interface CheckOptions {
  cwd?: string;
  minScore?: string | number;
  maxRegression?: string | number;
  failOn?: string | FindingSeverity;
  baseline?: string;
  session?: string;
}

export class CheckConfigurationError extends Error {
  readonly exitCode = 2 as const;
}

function parseNumber(value: string | number | undefined, name: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new CheckConfigurationError(`${name} must be a number between 0 and 100.`);
  }
  return parsed;
}

function parseSeverity(value: string | FindingSeverity | undefined): FindingSeverity | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const severity = value.trim().toLowerCase() as FindingSeverity;
  if (!["critical", "high", "medium", "low"].includes(severity)) {
    throw new CheckConfigurationError("fail-on must be one of: critical, high, medium, low.");
  }
  return severity;
}

function currentFindingsAtOrAbove(result: ScanResult, threshold?: FindingSeverity): boolean {
  if (!threshold) return false;
  return flattenFindings(result.findings)
    .filter((finding) => finding.confidence >= 0.8)
    .some((finding) => isSeverityAtLeast(finding.severity, threshold));
}

export async function evaluateCheck(options: CheckOptions = {}): Promise<CheckResult> {
  const minScore = parseNumber(options.minScore, "min-score", 75);
  const maxRegression = parseNumber(options.maxRegression, "max-regression", 0);
  const failOn = parseSeverity(options.failOn);
  const baselineRef = options.baseline?.trim() || undefined;
  const cwd = options.cwd || process.cwd();

  const gitRoot = baselineRef ? getGitRoot(cwd) : undefined;
  const resolvedBaselineRef = baselineRef && gitRoot
    ? resolveGitRef(gitRoot, baselineRef)
    : undefined;
  if (baselineRef && !resolvedBaselineRef) {
    throw new CheckConfigurationError(`Could not resolve baseline ref "${baselineRef}".`);
  }

  const current = await scanRepository({
    cwd,
    sessionPath: options.session,
    // Runtime traces are ephemeral and are not part of a committed baseline.
    includeRuntime: !baselineRef,
  });

  let baseline: ScanResult | null = null;
  let comparison: CheckResult["comparison"] = null;
  let baselineTree: string | undefined;

  if (baselineRef && gitRoot && resolvedBaselineRef) {
    try {
      baselineTree = archiveGitRef(gitRoot, resolvedBaselineRef);
      baseline = await scanRepository({
        cwd: baselineTree,
        includeRuntime: false,
        gitHistoryRoot: gitRoot,
        gitRef: resolvedBaselineRef,
      });
      comparison = compareScanResults(baseline, current, baselineRef);
    } finally {
      if (baselineTree) removeTemporaryDirectory(baselineTree);
    }
  }

  const failures: string[] = [];
  if (current.overallScore < minScore) {
    failures.push(`score ${current.overallScore} is below minimum ${minScore}`);
  }

  if (comparison && comparison.scoreDelta < -maxRegression) {
    failures.push(`score regressed by ${Math.abs(comparison.scoreDelta)} points (allowed ${maxRegression})`);
  }

  if (failOn) {
    const severityFailure = comparison
      ? hasRegressionAtLeast(
          comparison.regressions.filter((regression) => {
            if (!regression.fingerprint) return true;
            const finding = flattenFindings(current.findings).find(
              (candidate) => (candidate.fingerprint || createFindingFingerprint(candidate)) === regression.fingerprint
            );
            return !finding || finding.confidence >= 0.8;
          }),
          failOn
        )
      : currentFindingsAtOrAbove(current, failOn);

    if (severityFailure) {
      failures.push(`found a ${failOn.toUpperCase()} or higher severity issue`);
    }
  }

  return {
    schemaVersion: CHECK_SCHEMA_VERSION,
    result: current,
    baseline,
    comparison,
    passed: failures.length === 0,
    failures,
    exitCode: failures.length === 0 ? 0 : 1,
  };
}
