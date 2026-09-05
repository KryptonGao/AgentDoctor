import { CheckResult } from "../types.js";

export const AGENTDOCTOR_REPORT_MARKER = "<!-- agentdoctor-report -->";

function escapeMarkdown(value: string): string {
  return value.replace(/[|\\]/g, "\\$&").replace(/\r?\n/g, " ");
}

export function formatAgentDoctorMarkdown(result: CheckResult): string {
  const lines: string[] = [AGENTDOCTOR_REPORT_MARKER, "## AgentDoctor Report", ""];

  if (result.comparison) {
    const comparison = result.comparison;
    const delta = comparison.scoreDelta === 0
      ? "→0"
      : comparison.scoreDelta > 0
      ? `↑${comparison.scoreDelta}`
      : `↓${Math.abs(comparison.scoreDelta)}`;

    lines.push("| | Score |", "| --- | ---: |", `| ${escapeMarkdown(comparison.baselineRef)} | ${comparison.baselineScore} |`, `| HEAD | ${comparison.headScore} ${delta} |`, "");
    lines.push("### New regressions", "");
    if (comparison.regressions.length === 0) {
      lines.push("No new regressions detected.", "");
    } else {
      for (const regression of comparison.regressions.slice(0, 12)) {
        lines.push(`- **${regression.severity.toUpperCase()}**: ${escapeMarkdown(regression.title)}`);
      }
      if (comparison.regressions.length > 12) {
        lines.push(`- _and ${comparison.regressions.length - 12} more_`);
      }
      lines.push("");
    }
  } else {
    lines.push(`**Agent Efficiency: ${result.result.overallScore}/100**`, "");
  }

  if (result.failures.length > 0) {
    lines.push(`**Status: ❌ Failed** — ${escapeMarkdown(result.failures.join("; "))}`, "");
  } else {
    lines.push("**Status: ✅ Passed**", "");
  }

  lines.push(`<sub>Scanned ${result.result.repositoryName} in ${result.result.metadata.scanDurationMs} ms · AgentDoctor schema v${result.result.schemaVersion}</sub>`);
  return lines.join("\n");
}
