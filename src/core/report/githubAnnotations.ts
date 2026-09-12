import { Finding, FindingSeverity, ScanResult } from "../types.js";
import { flattenFindings } from "../findings/identity.js";
import { toRepoRelative } from "../fix/paths.js";

function annotationLevel(severity: FindingSeverity): "error" | "warning" | "notice" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "notice";
}

function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function formatGitHubAnnotation(finding: Finding, repoRoot: string): string {
  const evidence = finding.evidence[0];
  const file = escapeProperty(toRepoRelative(repoRoot, evidence?.file || "."));
  const title = escapeProperty(finding.title);
  const level = annotationLevel(finding.severity);
  const parts = [`${level} file=${file}`, `title=${title}`];
  if (evidence?.line) {
    parts.push(`line=${evidence.line}`);
    if (evidence.endLine && evidence.endLine >= evidence.line) parts.push(`endLine=${evidence.endLine}`);
  }
  const message = escapeData(`${finding.ruleId}: ${finding.description}`);
  return `::${parts.join(",")}::${message}`;
}

export function formatGitHubAnnotations(result: ScanResult, options: { limit?: number } = {}): string[] {
  const limit = options.limit ?? 50;
  return flattenFindings(result.findings)
    .slice(0, limit)
    .map((finding) => formatGitHubAnnotation(finding, result.repositoryRoot));
}

export function shouldEmitGitHubAnnotations(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  return process.env.GITHUB_ACTIONS === "true";
}
