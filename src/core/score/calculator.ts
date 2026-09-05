import {
  Finding,
  ContextSignalDensity,
  ScanResult,
  FindingCategory,
  VerificationItem,
} from "../types.js";
import { flattenFindings } from "../findings/identity.js";

export const SEVERITY_DEDUCTIONS: Record<string, number> = {
  critical: 25,
  high: 12,
  medium: 6,
  low: 2,
};

const DEFAULT_CONFIDENCE = 1;
const DEFAULT_GROUP_CAP = 35;
const OVERSIZED_GROUP_CAP = 25;

function effectiveConfidence(finding: Finding): number {
  if (typeof finding.confidence !== "number" || Number.isNaN(finding.confidence)) {
    return DEFAULT_CONFIDENCE;
  }

  return Math.min(1, Math.max(0, finding.confidence));
}

function findingImpact(finding: Finding): number {
  return (SEVERITY_DEDUCTIONS[finding.severity] || 0) * effectiveConfidence(finding);
}

function groupCap(groupKey: string): number {
  return groupKey.includes("large-file") || groupKey.includes("oversized-source-file")
    ? OVERSIZED_GROUP_CAP
    : DEFAULT_GROUP_CAP;
}

export function countFindingsBySeverity(findings: Finding[], category: FindingCategory) {
  const flatFindings = flattenFindings(findings).filter((finding) => finding.category === category);

  return {
    critical: flatFindings.filter((f) => f.severity === "critical").length,
    high: flatFindings.filter((f) => f.severity === "high").length,
    medium: flatFindings.filter((f) => f.severity === "medium").length,
    low: flatFindings.filter((f) => f.severity === "low").length,
  };
}

/**
 * Calculate a category score using severity × confidence and diminishing
 * returns for findings from the same rule. The first finding has full impact;
 * later findings are weighted by 1/sqrt(rank), then the rule group is capped.
 */
export function calculateCategoryScore(
  category: FindingCategory,
  findings: Finding[],
  signalDensity?: ContextSignalDensity
): number {
  const grouped = new Map<string, Finding[]>();

  for (const finding of flattenFindings(findings)) {
    if (finding.category !== category) continue;
    const key = finding.groupKey || finding.ruleId;
    const group = grouped.get(key) || [];
    group.push(finding);
    grouped.set(key, group);
  }

  let deductions = 0;
  for (const [key, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const weightedDeduction = [...group]
      .sort((a, b) => findingImpact(b) - findingImpact(a) || (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id))
      .reduce((sum, finding, index) => {
        const rank = index + 1;
        return sum + findingImpact(finding) / Math.sqrt(rank);
      }, 0);

    deductions += Math.min(groupCap(key), weightedDeduction);
  }

  const rawScore = Math.max(0, 100 - deductions);

  if (category === "context" && signalDensity && signalDensity.totalTokens > 0) {
    const blended = 0.5 * rawScore + 0.5 * signalDensity.densityPercent;
    return Math.min(100, Math.max(0, Math.round(blended)));
  }

  return Math.min(100, Math.max(0, Math.round(rawScore)));
}

function hasApplicableVerificationItems(items?: VerificationItem[]): boolean {
  return Boolean(items?.some((item) => item.status !== "not_applicable"));
}

export function calculateEfficiencyScore(
  findings: Finding[],
  signalDensity: ContextSignalDensity,
  hasRuntimeData: boolean,
  verificationStatus?: VerificationItem[]
): {
  overallScore: number;
  scoreExplanation: string;
  scores: ScanResult["scores"];
} {
  const contextScoreVal = calculateCategoryScore("context", findings, signalDensity);
  const repoScoreVal = calculateCategoryScore("repository", findings);
  const verifScoreVal = calculateCategoryScore("verification", findings);
  const runtimeScoreVal = hasRuntimeData
    ? calculateCategoryScore("runtime", findings)
    : undefined;

  let contextWeight = 0.35;
  let repoWeight = 0.2;
  let verifWeight = 0.2;
  const runtimeWeight = 0.25;

  let overallScore: number;
  let scoreExplanation: string;

  if (hasRuntimeData && runtimeScoreVal !== undefined) {
    overallScore =
      contextScoreVal * contextWeight +
      repoScoreVal * repoWeight +
      verifScoreVal * verifWeight +
      runtimeScoreVal * runtimeWeight;
    scoreExplanation = "Full assessment (4 of 4 dimensions evaluated)";
  } else {
    const totalStaticWeight = contextWeight + repoWeight + verifWeight;
    contextWeight /= totalStaticWeight;
    repoWeight /= totalStaticWeight;
    verifWeight /= totalStaticWeight;

    overallScore =
      contextScoreVal * contextWeight +
      repoScoreVal * repoWeight +
      verifScoreVal * verifWeight;
    scoreExplanation = "Based on 3 of 4 dimensions (Runtime session data unavailable)";
  }

  const scores: ScanResult["scores"] = {
    context: {
      score: contextScoreVal,
      weight: Number(contextWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "context"),
    },
    repository: {
      score: repoScoreVal,
      weight: Number(repoWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "repository"),
    },
    verification: {
      score: verifScoreVal,
      weight: Number(verifWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "verification"),
      metrics: {
        applicableChecks: verificationStatus?.filter((item) => item.status !== "not_applicable").length ?? 0,
        notApplicableChecks: verificationStatus?.filter((item) => item.status === "not_applicable").length ?? 0,
      },
    },
    runtime: hasRuntimeData && runtimeScoreVal !== undefined
      ? {
          score: runtimeScoreVal,
          weight: Number(runtimeWeight.toFixed(3)),
          findingsCount: countFindingsBySeverity(findings, "runtime"),
        }
      : null,
  };

  // Keep this explicit so N/A-only verification scans cannot accidentally
  // become a future score deduction when verification metrics evolve.
  if (!hasApplicableVerificationItems(verificationStatus)) {
    scores.verification.metrics = {
      ...(scores.verification.metrics || {}),
      applicableChecks: 0,
      notApplicableChecks: verificationStatus?.length ?? 0,
    };
  }

  return {
    overallScore: Math.round(overallScore),
    scoreExplanation,
    scores,
  };
}
