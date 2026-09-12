import pc from "picocolors";
import { EffectiveContextReport } from "../../analyzers/context/effectiveTypes.js";

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function status(value: string): string {
  if (value === "loaded" || value === "selected" || value === "matched" || value === "available") return pc.green(`✓ ${value}`);
  if (value === "invalid" || value === "disabled") return pc.red(`✕ ${value}`);
  if (value === "truncated" || value === "overridden") return pc.yellow(`! ${value}`);
  return pc.dim(`○ ${value}`);
}

export function formatEffectiveContextReport(report: EffectiveContextReport): string {
  const lines: string[] = [];
  const budget = report.budget;
  lines.push(pc.bold(`Effective Context — ${report.profile.name}`));
  lines.push(pc.dim(`${report.query.repositoryRoot} · ${report.profile.surface}`));
  lines.push("");
  lines.push(pc.bold("Summary"));
  lines.push(`  Prompt       ${number(report.prompt.length)} sources · ${number(budget.promptTokens)} estimated tokens · ${number(budget.promptBytes)} bytes`);
  lines.push(`  Candidates   ${number(report.candidates.length)} sources · ${number(budget.candidateTokens)} estimated tokens`);
  lines.push(`  Capabilities ${number(report.capabilities.length)}`);
  lines.push(`  Window       ${budget.contextWindowTokens === null ? pc.dim("unknown") : `${number(budget.usagePercent || 0)}% used · ${number(budget.remainingTokens || 0)} remaining`}`);

  for (const limit of budget.knownLimits) {
    lines.push(`  Limit        ${limit.name}: ${number(limit.used)}/${number(limit.limit)} ${limit.unit}${limit.exceeded ? pc.yellow(" (exceeded)") : ""}`);
  }

  lines.push("");
  lines.push(pc.bold(`Loading chain (${report.prompt.length})`));
  if (report.prompt.length === 0) lines.push(pc.dim("  No prompt instructions were deterministically loaded."));
  report.prompt.forEach((entry, index) => {
    lines.push(`  ${String(index + 1).padStart(2)}  ${status(entry.status)}  ${pc.cyan(entry.source)}${entry.line ? `:${entry.line}` : ""}`);
    lines.push(pc.dim(`      ${entry.kind} · ${entry.scope} · ${number(entry.estimatedTokens)} tokens · ${entry.matchReason}`));
  });

  lines.push("");
  lines.push(pc.bold(`Candidates (${report.candidates.length})`));
  if (report.candidates.length === 0) lines.push(pc.dim("  None."));
  report.candidates.forEach((entry) => {
    lines.push(`  ${status(entry.status)}  ${pc.cyan(entry.source)}${entry.name ? ` · ${entry.name}` : ""}`);
    lines.push(pc.dim(`      ${entry.matchReason}${entry.condition ? ` · condition: ${entry.condition}` : ""}`));
  });

  lines.push("");
  lines.push(pc.bold(`Relationships (${report.relationships.length})`));
  if (report.relationships.length === 0) lines.push(pc.dim("  No provable relationships."));
  report.relationships.forEach((relationship) => {
    lines.push(`  ${relationship.type}  ${pc.dim(`${relationship.from} → ${relationship.to}`)}`);
    lines.push(pc.dim(`      ${relationship.reason}`));
  });

  lines.push("");
  lines.push(pc.bold(`Capabilities (${report.capabilities.length})`));
  if (report.capabilities.length === 0) lines.push(pc.dim("  None discovered."));
  report.capabilities.forEach((capability) => {
    lines.push(`  ${status(capability.status)}  ${capability.kind.padEnd(13)} ${pc.cyan(capability.name)} · ${capability.source}`);
    lines.push(pc.dim(`      ${capability.reason}`));
  });

  if (report.diagnostics.length > 0) {
    lines.push("");
    lines.push(pc.bold(`Diagnostics (${report.diagnostics.length})`));
    report.diagnostics.forEach((diagnostic) => {
      const marker = diagnostic.severity === "error" ? pc.red("✕") : diagnostic.severity === "warning" ? pc.yellow("!") : pc.blue("i");
      lines.push(`  ${marker} ${diagnostic.code}: ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source})` : ""}`);
    });
  }

  lines.push("");
  lines.push(pc.bold("Final Prompt"));
  lines.push(report.finalInstructions || pc.dim("(empty)"));
  return lines.join("\n");
}
