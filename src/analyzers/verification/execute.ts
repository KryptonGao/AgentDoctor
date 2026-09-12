import * as path from "node:path";
import { estimateTokens } from "../context/tokenCounter.js";
import { VerifyAttempt, VerifyCheckResult } from "../../core/verify/types.js";
import { RunnableCheck } from "./runnable.js";
import { runSandboxedCommand } from "./sandbox.js";
import { summarizeFailure } from "./summary.js";

export interface ExecuteVerificationOptions {
  repoRoot: string;
  timeoutSeconds: number;
  flakyRuns: number;
  offline?: boolean;
}

function jailCwd(repoRoot: string, relative: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const candidate = path.resolve(resolvedRoot, relative || ".");
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (candidate !== resolvedRoot && !candidate.startsWith(prefix)) {
    throw new Error("Verify command cwd escaped the repository root");
  }
  return candidate;
}

function toAttempt(index: number, durationMs: number, result: Awaited<ReturnType<typeof runSandboxedCommand>>): VerifyAttempt {
  const outputTokens = estimateTokens(`${result.stdout}\n${result.stderr}`);
  const failureSummary =
    result.timedOut || result.spawnFailed || result.exitCode !== 0
      ? summarizeFailure(
          result.stdout,
          result.stderr,
          result.timedOut
            ? "Command timed out"
            : result.spawnFailed
              ? result.spawnError || "Command failed to start"
              : `Exit code ${result.exitCode}`
        )
      : undefined;
  return {
    attempt: index,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs || durationMs,
    timedOut: result.timedOut,
    spawnFailed: result.spawnFailed,
    outputTokens,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    truncated: result.truncated,
    failureSummary,
  };
}

function attemptPassed(attempt: VerifyAttempt): boolean {
  return !attempt.spawnFailed && !attempt.timedOut && attempt.exitCode === 0;
}

async function runOnce(
  check: RunnableCheck,
  cwd: string,
  timeoutMs: number,
  offline: boolean
): Promise<VerifyAttempt> {
  const argv = check.argv[0] === "cargo" && offline && !check.argv.includes("--offline")
    ? [check.argv[0], check.argv[1], "--offline", ...check.argv.slice(2)].filter(
        (part): part is string => part !== undefined
      )
    : check.argv;

  const startedAt = Date.now();
  const result = await runSandboxedCommand({
    argv,
    cwd,
    timeoutMs,
    offline,
  });
  return toAttempt(1, Date.now() - startedAt, result);
}

export async function executeRunnableChecks(
  checks: RunnableCheck[],
  options: ExecuteVerificationOptions
): Promise<VerifyCheckResult[]> {
  const timeoutMs = Math.max(1, options.timeoutSeconds) * 1000;
  const results: VerifyCheckResult[] = [];

  for (const check of checks) {
    if (check.skipped || check.argv.length === 0) {
      results.push({
        name: check.name,
        command: check.displayCommand || undefined,
        skipped: true,
        skipReason: check.skipReason || "Skipped",
        passed: true,
        flaky: false,
        status: "skipped",
        durationMs: 0,
        exitCode: null,
        outputTokens: 0,
        attempts: [],
      });
      continue;
    }

    const cwd = jailCwd(options.repoRoot, check.cwdRelative);
    const runs = check.name === "test" ? Math.max(1, options.flakyRuns) : 1;
    const attempts: VerifyAttempt[] = [];

    for (let index = 0; index < runs; index += 1) {
      const attempt = await runOnce(check, cwd, timeoutMs, Boolean(options.offline));
      attempt.attempt = index + 1;
      attempts.push(attempt);
    }

    const passCount = attempts.filter(attemptPassed).length;
    const flaky = runs > 1 && passCount > 0 && passCount < attempts.length;
    const passed = passCount === attempts.length;
    const last = attempts[attempts.length - 1];
    const timedOut = attempts.some((attempt) => attempt.timedOut);
    const status = flaky ? "warning" : passed ? "healthy" : "broken";

    results.push({
      name: check.name,
      command: check.displayCommand,
      argv: check.argv,
      cwd: check.cwdRelative,
      skipped: false,
      passed,
      flaky,
      status,
      durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
      exitCode: last?.exitCode ?? null,
      outputTokens: attempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
      failureSummary: flaky
        ? `Flaky: ${passCount}/${attempts.length} attempts passed. ${attempts.find((a) => !attemptPassed(a))?.failureSummary || ""}`.trim()
        : timedOut
          ? last?.failureSummary || "Command timed out"
          : passed
            ? undefined
            : last?.failureSummary,
      attempts,
    });
  }

  return results;
}
