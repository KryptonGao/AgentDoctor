import { Finding, FindingSeverity } from "../types.js";
import { flattenFindings } from "../findings/identity.js";
import { SEVERITY_RANK } from "../regression/comparator.js";

export function countSecurityFindings(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of flattenFindings(findings)) {
    if (finding.category !== "security") continue;
    counts[finding.ruleId] = (counts[finding.ruleId] || 0) + 1;
  }
  return counts;
}

export function auditFailures(
  findings: Finding[],
  failOn?: FindingSeverity
): string[] {
  if (!failOn) return [];
  const hits = flattenFindings(findings).filter((finding) =>
    finding.category === "security" &&
    finding.confidence >= 0.8 &&
    SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn]
  );
  if (hits.length === 0) return [];
  return [`${hits.length} security finding(s) at or above ${failOn}`];
}
