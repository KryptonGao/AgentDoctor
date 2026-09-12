import pc from "picocolors";
import { EvalResult, EvalRun, EvalTaskMetrics } from "../../core/eval/types.js";
import { formatDuration } from "../../core/eval/compare.js";

function formatTokens(value: number | undefined): string {
  if (value === undefined) return pc.dim("n/a");
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatRate01(value: number | undefined): string {
  return value === undefined ? pc.dim("n/a") : `${Math.round(value * 100)}%`;
}

function formatChurn(metrics: EvalTaskMetrics): string {
  const churn = metrics.reviewChurn;
  return churn ? `+${churn.additions}/-${churn.deletions}` : pc.dim("n/a");
}

function formatPassed(metrics: EvalTaskMetrics): string {
  if (metrics.error) return pc.red("error");
  if (metrics.passed === undefined) return pc.dim("n/a");
  return metrics.passed ? pc.green("✓") : pc.red("✗");
}

function formatOptionalNumber(value: number | undefined, suffix = ""): string {
  return value === undefined ? pc.dim("n/a") : `${value}${suffix}`;
}

function formatTaskLine(metrics: EvalTaskMetrics): string {
  const parts = [
    formatPassed(metrics),
    metrics.taskId.padEnd(30),
    `attempts ${formatOptionalNumber(metrics.attempts)}`,
    `time-to-green ${metrics.timeToGreenMs === undefined ? pc.dim("n/a") : formatDuration(metrics.timeToGreenMs)}`,
    `tokens ${formatTokens(metrics.tokens?.total)}`,
    `cost ${metrics.costUsd === undefined ? pc.dim("n/a") : `$${metrics.costUsd}`}`,
    `retries ${formatOptionalNumber(metrics.retries)}`,
    `churn ${formatChurn(metrics)}`,
    `test-fail ${formatRate01(metrics.testFailureRate)}`,
  ];
  let line = parts.join("  ");
  if (metrics.error) line += `\n    ${pc.red(metrics.error)}`;
  return line;
}

function formatMetricsBlock(title: string, run: EvalRun): string[] {
  const m = run.metrics;
  const row = (label: string, value: string) => `  ${label.padEnd(21)}${value}`;
  return [
    pc.bold(title),
    row("tasks", `${m.taskCount}${m.passedCount !== undefined ? ` (passed ${m.passedCount})` : ""}`),
    row(
      "evidence coverage",
      m.coverageRate === undefined
        ? pc.dim("n/a")
        : `${m.coverageRate}% (${m.evaluatedTaskCount || 0}/${m.taskCount})`
    ),
    row("first-pass rate", m.firstPassRate === undefined ? pc.dim("n/a") : `${m.firstPassRate}%`),
    row("median time-to-green", m.medianTimeToGreenMs === undefined ? pc.dim("n/a") : formatDuration(m.medianTimeToGreenMs)),
    row("tokens", `${formatTokens(m.totalTokens)}${m.costUsd !== undefined ? pc.dim(` (~$${m.costUsd})`) : ""}`),
    row("retries", formatOptionalNumber(m.totalRetries)),
    row("review churn", m.reviewChurn ? `+${m.reviewChurn.additions}/-${m.reviewChurn.deletions} across ${m.reviewChurn.files} files` : pc.dim("n/a")),
    row("test failure rate", formatRate01(m.testFailureRate)),
  ];
}

function formatComparison(result: EvalResult): string[] {
  const comparison = result.comparison;
  if (!comparison) return [];
  const lines: string[] = [""];
  lines.push(pc.bold(`Comparison against ${comparison.baselineRef}`));
  const verdictText =
    comparison.verdict === "improved"
      ? pc.green("IMPROVED")
      : comparison.verdict === "regressed"
        ? pc.red("REGRESSED")
        : pc.yellow("NEUTRAL");
  lines.push(`verdict: ${verdictText}`);
  const render = (items: string[], marker: string, color: (s: string) => string) => {
    for (const item of items) lines.push(`  ${color(marker)} ${item}`);
  };
  render(comparison.regressions, "↓", pc.red);
  render(comparison.improvements, "↑", pc.green);
  render(comparison.neutralDeltas, "→", pc.dim);
  if (
    comparison.regressions.length === 0 &&
    comparison.improvements.length === 0 &&
    comparison.neutralDeltas.length === 0
  ) {
    lines.push(pc.dim("  no comparable metrics (n/a on either side)"));
  }
  return lines;
}

export function formatEvalResult(result: EvalResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    pc.bold(
      `AgentDoctor Eval — ${result.suite.name || "golden tasks"} ` +
        `${pc.dim(`(${result.mode}, ${result.suite.taskCount} ${result.suite.taskCount === 1 ? "task" : "tasks"})`)}`
    )
  );

  const primaryRuns: { label: string; run: EvalRun }[] = [];
  if (result.before && result.after) {
    primaryRuns.push({ label: `Before (${result.before.instructionsRef || "baseline"})`, run: result.before });
    primaryRuns.push({ label: "After (current instructions)", run: result.after });
  } else if (result.run) {
    primaryRuns.push({ label: "Run", run: result.run });
  }

  for (const { label, run } of primaryRuns) {
    lines.push("");
    lines.push(pc.bold(label));
    for (const metrics of run.tasks) {
      lines.push(`  ${formatTaskLine(metrics)}`);
    }
    lines.push(...formatMetricsBlock("Metrics:", run));
  }

  lines.push(...formatComparison(result));

  if (result.warnings.length > 0) {
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(pc.yellow(`! ${warning}`));
    }
  }

  if (result.failures.length > 0) {
    lines.push("");
    lines.push(pc.red(pc.bold(`✕ Eval FAILED: ${result.failures.join("; ")}.`)));
    lines.push(pc.dim(result.runPath ? `Run record saved to ${result.runPath}.` : ""));
  } else {
    lines.push("");
    lines.push(pc.green(pc.bold("✓ Eval PASSED.")));
    lines.push(pc.dim(result.runPath ? `Run record saved to ${result.runPath}.` : ""));
  }

  return lines.filter((line, index) => !(line === "" && index === lines.length - 1)).join("\n");
}
