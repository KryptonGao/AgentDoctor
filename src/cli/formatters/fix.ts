import pc from "picocolors";
import { FixLoopResult } from "../../core/fix/loop.js";

export function formatFixLoopResult(result: FixLoopResult): string {
  const lines: string[] = [""];

  if (result.applied.length === 0 && result.failed.length === 0) {
    lines.push(pc.green("✓ No fixes available. Repository instructions are up-to-date!"));
    lines.push("");
    return lines.join("\n");
  }

  for (const fix of result.applied) {
    lines.push(pc.green(`  ✓ Applied: ${fix.title}`));
  }
  for (const item of result.failed) {
    lines.push(pc.red(`  ✕ Failed: ${item.fix.title} - ${item.error}`));
  }

  if (result.generatedShims.length > 0) {
    lines.push(pc.cyan(`  Shims: ${result.generatedShims.join(", ")}`));
  }

  if (result.verify) {
    if (result.verify.passed) {
      lines.push(pc.green("  ✓ Post-fix verification passed"));
    } else {
      lines.push(pc.red(`  ✕ Post-fix verification failed: ${result.verify.failures.join("; ")}`));
    }
  }

  if (result.rolledBack) {
    lines.push(pc.yellow(`  ↺ Rolled back last transaction (${result.rollbackReason || "verification failed"})`));
  }

  if (result.final) {
    lines.push("");
    lines.push(pc.bold(`Score: ${result.initial.overallScore} → ${result.final.overallScore}`));
  }

  if (result.pullRequest) {
    const pr = result.pullRequest;
    lines.push(pr.url
      ? pc.green(`  ✓ Pull request: ${pr.url}`)
      : pc.cyan(`  Branch ${pr.branch}${pr.detail ? ` — ${pr.detail}` : ""}`));
  }

  if (result.journalId && !result.rolledBack) {
    lines.push(pc.dim(`  Journal ${result.journalId}. Restore with: agentdoctor fix --rollback`));
  }

  lines.push("");
  return lines.join("\n");
}
