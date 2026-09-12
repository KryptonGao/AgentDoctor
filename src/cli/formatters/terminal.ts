import pc from "picocolors";
import { ScanResult, FindingSeverity, Finding } from "../../core/types.js";

function getSeverityBadge(severity: FindingSeverity): string {
  switch (severity) {
    case "critical":
      return pc.bgRed(pc.white(pc.bold(" CRIT ")));
    case "high":
      return pc.red(pc.bold("▲ HIGH"));
    case "medium":
      return pc.yellow(pc.bold("● MED "));
    case "low":
      return pc.blue("▼ LOW ");
  }
}

function renderProgressBar(score: number, width: number = 16): string {
  const filledCount = Math.round((score / 100) * width);
  const emptyCount = width - filledCount;
  const filled = "█".repeat(filledCount);
  const empty = "░".repeat(emptyCount);

  let colored = pc.green(filled);
  if (score < 60) colored = pc.red(filled);
  else if (score < 75) colored = pc.yellow(filled);

  return `${colored}${pc.dim(empty)} ${score}`;
}

function formatFindingItem(finding: Finding): string[] {
  const lines: string[] = [];
  const confPercent = Math.round((finding.confidence ?? 0.85) * 100);
  const confBadge = pc.dim(`(${confPercent}% conf)`);

  lines.push(`${getSeverityBadge(finding.severity)}  ${pc.bold(finding.title)} ${confBadge}`);
  lines.push(`       ${pc.dim(finding.description)}`);

  if (finding.evidence.length > 0) {
    const ev = finding.evidence[0];
    lines.push(`       ${pc.dim("Location:")} ${pc.cyan(ev.file)}${ev.line ? `:${ev.line}` : ""}`);
  }
  if (finding.recommendation) {
    lines.push(`       ${pc.dim("Recommendation:")} ${finding.recommendation}`);
  }
  if (finding.fix) {
    lines.push(`       ${pc.green(`[Fix Available: ${finding.fix.title}]`)}`);
  }
  lines.push("");
  return lines;
}

export function formatTerminalScanResult(result: ScanResult): string {
  const lines: string[] = [];

  const width = 64;
  const divider = pc.dim("─".repeat(width));

  const profileSummary = result.projectProfile?.summary ? ` [${result.projectProfile.summary}]` : "";

  lines.push("");
  lines.push(pc.bold(pc.cyan(`┌─ AgentDoctor ${"─".repeat(width - 16)}┐`)));
  lines.push(
    pc.bold(pc.cyan(`│ `)) +
    pc.bold(`${result.repositoryName}`) +
    pc.dim(` (${result.branch})`) +
    pc.cyan(pc.dim(profileSummary)) +
    " ".repeat(Math.max(1, width - 4 - result.repositoryName.length - result.branch.length - 3 - profileSummary.length)) +
    pc.bold(pc.cyan(`│`))
  );
  lines.push(pc.cyan(`├${"─".repeat(width - 2)}┤`));
  lines.push(pc.cyan(`│`) + " ".repeat(width - 2) + pc.cyan(`│`));

  // Score display
  const scoreStr = `${result.overallScore}`;
  let coloredScore = pc.green(pc.bold(scoreStr));
  if (result.overallScore < 60) coloredScore = pc.red(pc.bold(scoreStr));
  else if (result.overallScore < 75) coloredScore = pc.yellow(pc.bold(scoreStr));

  const centerScore = `Agent Efficiency Score: ${coloredScore} / 100`;
  const paddingScore = Math.max(0, Math.floor((width - 32) / 2));
  lines.push(pc.cyan(`│`) + " ".repeat(paddingScore) + centerScore + " ".repeat(width - 2 - paddingScore - 29) + pc.cyan(`│`));

  if (result.scoreExplanation) {
    const explPadding = Math.max(0, Math.floor((width - 2 - result.scoreExplanation.length) / 2));
    lines.push(pc.cyan(`│`) + " ".repeat(explPadding) + pc.dim(result.scoreExplanation) + " ".repeat(Math.max(0, width - 2 - explPadding - result.scoreExplanation.length)) + pc.cyan(`│`));
  } else {
    lines.push(pc.cyan(`│`) + " ".repeat(width - 2) + pc.cyan(`│`));
  }

  // Category bars
  const scores = result.scores;
  lines.push(pc.cyan(`│ `) + `Context Health       ${renderProgressBar(scores.context.score)}` + " ".repeat(15) + pc.cyan(`│`));
  lines.push(pc.cyan(`│ `) + `Repository Readiness ${renderProgressBar(scores.repository.score)}` + " ".repeat(15) + pc.cyan(`│`));
  lines.push(pc.cyan(`│ `) + `Verification Loop    ${renderProgressBar(scores.verification.score)}` + " ".repeat(15) + pc.cyan(`│`));
  lines.push(pc.cyan(`│ `) + `Security Audit       ${renderProgressBar(scores.security.score)}` + " ".repeat(15) + pc.cyan(`│`));
  if (scores.runtime) {
    lines.push(pc.cyan(`│ `) + `Runtime Efficiency   ${renderProgressBar(scores.runtime.score)}` + " ".repeat(15) + pc.cyan(`│`));
  } else {
    lines.push(pc.cyan(`│ `) + pc.dim(`Runtime Efficiency   [No session data detected]      `) + pc.cyan(`│`));
  }

  // Signal Density
  const density = result.contextSignalDensity;
  lines.push(pc.cyan(`├${"─".repeat(width - 2)}┤`));
  lines.push(
    pc.cyan(`│ `) +
    pc.bold(`Context Signal Density: `) +
    pc.cyan(`${density.densityPercent}%`) +
    pc.dim(` (${density.usefulTokens.toLocaleString()} useful / ${density.totalTokens.toLocaleString()} tokens)`) +
    " ".repeat(Math.max(1, width - 40 - String(density.densityPercent).length - String(density.usefulTokens).length - String(density.totalTokens).length)) +
    pc.cyan(`│`)
  );
  lines.push(pc.cyan(`└${"─".repeat(width - 2)}┘`));
  lines.push("");

  // Filter high-confidence vs needs review
  const highConfidenceFindings = result.findings.filter((f) => (f.confidence ?? 0.85) >= 0.8);
  const needsReviewFindings = result.findings.filter((f) => (f.confidence ?? 0.85) < 0.8);

  const totalFindings = result.findings.length;
  const highCount = result.findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const medCount = result.findings.filter((f) => f.severity === "medium").length;
  const lowCount = result.findings.filter((f) => f.severity === "low").length;

  lines.push(
    pc.bold(`Issues (${totalFindings}): `) +
    (highCount > 0 ? pc.red(`${highCount} high  `) : "") +
    (medCount > 0 ? pc.yellow(`${medCount} medium  `) : "") +
    (lowCount > 0 ? pc.blue(`${lowCount} low`) : "")
  );
  lines.push(divider);

  if (totalFindings === 0) {
    lines.push(pc.green("✓ No efficiency issues detected! Repository is highly optimized for AI agents."));
  } else {
    // 1. Render Top Issues (Confidence >= 0.8)
    if (highConfidenceFindings.length > 0) {
      lines.push(pc.bold("Top Issues (Verified High Confidence):"));
      lines.push("");
      for (const finding of highConfidenceFindings.slice(0, 10)) {
        lines.push(...formatFindingItem(finding));
      }
    }

    // 2. Render Needs Review section (Confidence < 0.8)
    if (needsReviewFindings.length > 0) {
      lines.push(divider);
      lines.push(pc.bold(pc.yellow(`Needs Review (${needsReviewFindings.length} tentative findings):`)));
      lines.push(pc.dim("These items require manual review and do not heavily impact your score:"));
      lines.push("");
      for (const finding of needsReviewFindings.slice(0, 5)) {
        lines.push(...formatFindingItem(finding));
      }
    }
  }

  if (result.availableFixes.length > 0) {
    lines.push(divider);
    lines.push(
      pc.bold(pc.green(`⚡ ${result.availableFixes.length} fixes available! `)) +
      pc.dim(`Run `) + pc.cyan(`agentdoctor fix`) + pc.dim(` or `) + pc.cyan(`npx @gaochenkai/agentdoctor`) + pc.dim(` to review & apply.`)
    );
  }

  return lines.join("\n");
}
