import pc from "picocolors";
import { CheckResult, FindingSeverity } from "../../core/types.js";
import { flattenFindings } from "../../core/findings/identity.js";

const severityOrder: FindingSeverity[] = ["critical", "high", "medium", "low"];

function formatScoreDelta(delta: number): string {
  if (delta < 0) return pc.red(`↓${Math.abs(delta)}`);
  if (delta > 0) return pc.green(`↑${delta}`);
  return pc.dim("→0");
}

function formatSeverity(severity: FindingSeverity): string {
  if (severity === "critical" || severity === "high") return pc.red(severity.toUpperCase());
  if (severity === "medium") return pc.yellow(severity.toUpperCase());
  return pc.blue(severity.toUpperCase());
}

export function formatCheckResult(result: CheckResult, minScore?: string | number): string {
  const lines: string[] = [];
  const threshold = minScore === undefined || minScore === "" ? 75 : Number(minScore);

  lines.push("");
  lines.push(pc.bold(`Agent Efficiency Check for ${pc.cyan(result.result.repositoryName)}`));

  if (result.comparison) {
    const comparison = result.comparison;
    lines.push("");
    lines.push(pc.bold("Agent Efficiency"));
    lines.push(`${comparison.baselineRef}  ${comparison.baselineScore}`);
    lines.push(`HEAD  ${comparison.headScore} ${formatScoreDelta(comparison.scoreDelta)}`);
    lines.push("");
    lines.push(pc.bold("New regressions:"));

    if (comparison.regressions.length === 0) {
      lines.push(pc.green("- none"));
    } else {
      for (const regression of comparison.regressions.slice(0, 20)) {
        lines.push(`- ${formatSeverity(regression.severity)}: ${regression.title}`);
      }
      if (comparison.regressions.length > 20) {
        lines.push(pc.dim(`- ...and ${comparison.regressions.length - 20} more`));
      }
    }
  } else {
    lines.push(`Current Score: ${result.result.overallScore} / 100 (Threshold: ${threshold})`);
    const highIssues = flattenFindings(result.result.findings).filter((finding) =>
      severityOrder.indexOf(finding.severity) <= severityOrder.indexOf("high") && finding.confidence >= 0.8
    );
    if (highIssues.length > 0) {
      lines.push(pc.red(`\nFound ${highIssues.length} high/critical severity issues:`));
      for (const issue of highIssues.slice(0, 20)) {
        lines.push(`  - ${issue.title} (${issue.evidence[0]?.file || "repo"})`);
      }
    }
  }

  if (result.failures.length > 0) {
    lines.push("");
    lines.push(pc.red(pc.bold(`✕ Check FAILED: ${result.failures.join("; ")}.`)));
    lines.push(pc.dim("Run 'agentdoctor scan' to view the full breakdown."));
  } else {
    lines.push("");
    lines.push(pc.green(pc.bold("✓ Check PASSED.")));
  }

  return lines.join("\n");
}
