import {
  BaselineComparison,
  Finding,
  FindingSeverity,
  Regression,
  ScanResult,
  VerificationItem,
} from "../types.js";
import { createFindingFingerprint, flattenFindings } from "../findings/identity.js";

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const VERIFICATION_STATUS_RANK: Record<VerificationItem["status"], number> = {
  not_applicable: -1,
  healthy: 0,
  warning: 1,
  // Unknown is an absence of evidence, not proof that a previously healthy
  // loop became broken. It therefore does not create a CI regression by
  // itself; a concrete warning or broken status does.
  unknown: 0,
  broken: 2,
};

function severityAtLeast(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

export function isSeverityAtLeast(
  severity: FindingSeverity,
  threshold?: FindingSeverity
): boolean {
  return threshold ? severityAtLeast(severity, threshold) : false;
}

function wastefulTokens(result: ScanResult): number {
  if (typeof result.contextSignalDensity.wastefulTokens === "number") {
    return result.contextSignalDensity.wastefulTokens;
  }

  const density = result.contextSignalDensity;
  return density.duplicateTokens + density.inferableTokens + density.staleTokens + density.lowValueTokens;
}

function findingTitle(finding: Finding): string {
  if (finding.ruleId === "context/stale-path" || finding.ruleId === "context/unresolved-path") {
    return "stale instruction";
  }
  if (finding.ruleId === "verification/command-consistency" || finding.ruleId === "verification/ecosystem-command-mismatch") {
    return "verification mismatch";
  }
  return finding.title;
}

function findingRegression(finding: Finding, reason: string): Regression {
  const fingerprint = finding.fingerprint || createFindingFingerprint(finding);
  return {
    kind: "new-finding",
    severity: finding.severity,
    title: findingTitle(finding),
    detail: reason,
    fingerprint,
    evidence: finding.evidence,
  };
}

function compareFindings(baseline: ScanResult, head: ScanResult): Regression[] {
  const baselineFindings = new Map<string, Finding>();
  for (const finding of flattenFindings(baseline.findings)) {
    if (finding.category === "runtime") continue;
    baselineFindings.set(finding.fingerprint || createFindingFingerprint(finding), finding);
  }

  const regressions: Regression[] = [];
  for (const finding of flattenFindings(head.findings)) {
    if (finding.category === "runtime") continue;
    const fingerprint = finding.fingerprint || createFindingFingerprint(finding);
    const previous = baselineFindings.get(fingerprint);

    if (!previous) {
      regressions.push(findingRegression(finding, finding.description));
      continue;
    }

    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[previous.severity]) {
      regressions.push(findingRegression(
        finding,
        `Severity increased from ${previous.severity.toUpperCase()} to ${finding.severity.toUpperCase()}.`
      ));
    }
  }

  return regressions;
}

function compareVerification(
  baseline: ScanResult,
  head: ScanResult
): Regression[] {
  const baselineItems = new Map(baseline.verificationStatus.map((item) => [item.name, item]));
  const regressions: Regression[] = [];

  for (const current of head.verificationStatus) {
    const previous = baselineItems.get(current.name);
    if (!previous) continue;
    if (previous.status === "not_applicable" || current.status === "not_applicable") continue;

    if (VERIFICATION_STATUS_RANK[current.status] > VERIFICATION_STATUS_RANK[previous.status]) {
      const severity: FindingSeverity = current.status === "broken" ? "high" : "medium";
      regressions.push({
        kind: "verification",
        severity,
        title: "verification mismatch",
        detail: `${current.name} changed from ${previous.status} to ${current.status}${current.command ? ` (${current.command})` : ""}.`,
        evidence: current.source ? [{ file: current.source, snippet: current.detail }] : undefined,
      });
    }
  }

  return regressions;
}

function compareContext(
  baseline: ScanResult,
  head: ScanResult
): { regression?: Regression; delta: BaselineComparison["contextDelta"] } {
  const totalTokens = head.contextSignalDensity.totalTokens - baseline.contextSignalDensity.totalTokens;
  const wastefulTokenDelta = wastefulTokens(head) - wastefulTokens(baseline);
  const densityPercent = Number(
    (head.contextSignalDensity.densityPercent - baseline.contextSignalDensity.densityPercent).toFixed(1)
  );

  const shouldReport = totalTokens >= 100 || wastefulTokenDelta > 0 || densityPercent <= -1;
  if (!shouldReport) {
    return {
      delta: { totalTokens, wastefulTokens: wastefulTokenDelta, densityPercent },
    };
  }

  const tokenDetail = wastefulTokenDelta > 0
    ? `+${wastefulTokenDelta.toLocaleString()} redundant context tokens`
    : `${totalTokens >= 0 ? "+" : ""}${totalTokens.toLocaleString()} context tokens`;

  return {
    delta: { totalTokens, wastefulTokens: wastefulTokenDelta, densityPercent },
    regression: {
      kind: "context-bloat",
      severity: "medium",
      title: tokenDetail,
      detail: `Context changed by ${totalTokens >= 0 ? "+" : ""}${totalTokens.toLocaleString()} total tokens; signal density changed by ${densityPercent >= 0 ? "+" : ""}${densityPercent} points.`,
    },
  };
}

export function compareScanResults(
  baseline: ScanResult,
  head: ScanResult,
  baselineRef: string
): BaselineComparison {
  const context = compareContext(baseline, head);
  const regressions = [
    ...compareFindings(baseline, head),
    ...compareVerification(baseline, head),
    ...(context.regression ? [context.regression] : []),
  ].sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.kind.localeCompare(b.kind) ||
    a.title.localeCompare(b.title) ||
    (a.fingerprint || "").localeCompare(b.fingerprint || "")
  );

  return {
    baselineRef,
    baselineScore: baseline.overallScore,
    headScore: head.overallScore,
    scoreDelta: head.overallScore - baseline.overallScore,
    regressions,
    contextDelta: context.delta,
  };
}

export function hasRegressionAtLeast(
  regressions: Regression[],
  threshold?: FindingSeverity
): boolean {
  return Boolean(threshold && regressions.some((regression) => severityAtLeast(regression.severity, threshold)));
}
