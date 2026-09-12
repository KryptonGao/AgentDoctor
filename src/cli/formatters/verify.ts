import pc from "picocolors";
import { formatDuration } from "../../core/eval/compare.js";
import { VerifyCheckResult, VerifyResult } from "../../core/verify/types.js";

function statusLabel(check: VerifyCheckResult): string {
  if (check.skipped) return pc.dim("skipped");
  if (check.flaky) return pc.yellow("flaky");
  if (check.passed) return pc.green("pass");
  if (check.attempts.some((attempt) => attempt.timedOut)) return pc.red("timeout");
  return pc.red("fail");
}

function formatTokens(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatVerifyResult(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    pc.bold(
      `AgentDoctor Verify ${pc.dim(`(${result.isolated ? "isolated" : "in-place"}, timeout ${result.timeoutSeconds}s, flaky-runs ${result.flakyRuns})`)}`
    )
  );
  lines.push(pc.dim(`${result.repositoryName} (${result.branch})`));
  lines.push("");

  for (const check of result.checks) {
    const command = check.command || pc.dim("n/a");
    const meta = check.skipped
      ? pc.dim(check.skipReason || "skipped")
      : `exit ${check.exitCode ?? "n/a"}  ${formatDuration(check.durationMs)}  ${formatTokens(check.outputTokens)} tok`;
    lines.push(`  ${statusLabel(check).padEnd(18)} ${check.name.padEnd(10)} ${command}`);
    lines.push(`    ${meta}`);
    if (check.failureSummary && !check.skipped) {
      for (const line of check.failureSummary.split("\n").slice(0, 8)) {
        lines.push(pc.dim(`    ${line}`));
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(pc.yellow(`! ${warning}`));
    }
  }

  lines.push("");
  if (result.passed) {
    lines.push(pc.green(pc.bold("✓ Verify PASSED.")));
  } else {
    lines.push(pc.red(pc.bold(`✕ Verify FAILED: ${result.failures.join("; ")}.`)));
  }
  lines.push(pc.dim(`Finished in ${formatDuration(result.durationMs)}.`));
  return lines.join("\n");
}
