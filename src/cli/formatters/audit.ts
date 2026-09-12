import pc from "picocolors";
import { AuditResult, Finding } from "../../core/types.js";
import { flattenFindings } from "../../core/findings/identity.js";

function formatFinding(finding: Finding): string {
  const loc = finding.evidence[0];
  const where = loc ? `${loc.file}${loc.line ? `:${loc.line}` : ""}` : "";
  return `  ${finding.severity.toUpperCase().padEnd(8)} ${finding.title}${where ? `\n           ${pc.dim(where)}` : ""}`;
}

export function formatAuditResult(result: AuditResult): string {
  const lines: string[] = [];
  const flat = flattenFindings(result.findings);
  lines.push("");
  lines.push(pc.bold(`AgentDoctor Security Audit  ${pc.cyan(result.repositoryName)} ${pc.dim(`(${result.branch})`)}`));
  lines.push(`Security score: ${result.score} / 100`);
  lines.push("");

  if (flat.length === 0) {
    lines.push(pc.green("✓ No agent security issues detected in instructions, MCP, or hooks."));
  } else {
    const grouped = new Map<string, Finding[]>();
    for (const finding of result.findings) {
      const list = grouped.get(finding.ruleId) || [];
      list.push(finding);
      grouped.set(finding.ruleId, list);
    }
    for (const [ruleId, items] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(pc.bold(ruleId));
      for (const item of items) {
        lines.push(formatFinding(item));
      }
      lines.push("");
    }
  }

  if (result.failures.length > 0) {
    lines.push(pc.red(pc.bold(`✕ Audit FAILED: ${result.failures.join("; ")}.`)));
  } else {
    lines.push(pc.green(pc.bold("✓ Audit PASSED.")));
  }
  return lines.join("\n");
}
