import * as path from "node:path";
import { Finding } from "../types.js";
import { getGitBranch, getGitRoot } from "../../shared/git.js";
import { detectProjectProfile } from "../project/profile.js";
import { analyzeVerification } from "../../analyzers/verification/verificationAnalyzer.js";
import { executeRunnableChecks } from "../../analyzers/verification/execute.js";
import { parseOnlyOption, resolveRunnableChecks } from "../../analyzers/verification/runnable.js";
import { createVerifyWorkspace } from "../../analyzers/verification/workspace.js";
import { ensureFindingFingerprints } from "../findings/identity.js";
import {
  VERIFY_SCHEMA_VERSION,
  VerifyCheckName,
  VerifyCheckResult,
  VerifyConfigurationError,
  VerifyResult,
} from "./types.js";

export interface VerifyOptions {
  cwd?: string;
  only?: string | VerifyCheckName[];
  timeoutSeconds?: string | number;
  flakyRuns?: string | number;
  isolate?: boolean;
  offline?: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_FLAKY_RUNS = 2;

function parsePositiveInt(value: string | number | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new VerifyConfigurationError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function findingsFromChecks(checks: VerifyCheckResult[]): Finding[] {
  const findings: Finding[] = [];
  for (const check of checks) {
    if (check.skipped || check.passed) continue;
    if (check.flaky) {
      findings.push({
        id: `verif-flaky-${check.name}`,
        ruleId: "verification/flaky-test",
        category: "verification",
        severity: "high",
        confidence: 0.9,
        title: `${check.name} command is flaky`,
        description: `${check.command || check.name} passed on some isolated attempts and failed on others. Agents cannot trust a verification loop that is non-deterministic.`,
        evidence: [
          {
            file: check.cwd || ".",
            snippet: check.failureSummary,
            source: check.command,
          },
        ],
        recommendation: "Stabilize the test (isolate shared state, freeze time, drop order dependence) and re-run agentdoctor verify --only test.",
      });
      continue;
    }
    const timedOut = check.attempts.some((attempt) => attempt.timedOut);
    findings.push({
      id: timedOut ? `verif-timeout-${check.name}` : `verif-failed-${check.name}`,
      ruleId: timedOut ? "verification/command-timeout" : "verification/command-failed",
      category: "verification",
      severity: "high",
      confidence: 0.95,
      title: timedOut ? `${check.name} command timed out` : `${check.name} command failed`,
      description: timedOut
        ? `${check.command || check.name} exceeded the verify timeout. Agents waiting on this loop will stall or retry endlessly.`
        : `${check.command || check.name} exited ${check.exitCode ?? "non-zero"}. Static discovery would have marked this loop healthy because the command exists.`,
      evidence: [
        {
          file: check.cwd || ".",
          snippet: check.failureSummary,
          source: check.command,
        },
      ],
      recommendation: timedOut
        ? "Raise --timeout only if the suite is legitimately slow; otherwise split or cache the check the agent is expected to run."
        : "Fix the failing command so agents get a reliable green/red signal.",
    });
  }
  return ensureFindingFingerprints(findings).sort((a, b) => a.id.localeCompare(b.id));
}

export async function runVerify(options: VerifyOptions = {}): Promise<VerifyResult> {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const timeoutSeconds = parsePositiveInt(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, "--timeout");
  const flakyRuns = parsePositiveInt(options.flakyRuns, DEFAULT_FLAKY_RUNS, "--flaky-runs");

  let only: VerifyCheckName[] | undefined;
  try {
    only = Array.isArray(options.only) ? options.only : parseOnlyOption(options.only);
  } catch (error) {
    throw new VerifyConfigurationError(error instanceof Error ? error.message : String(error));
  }

  const projectProfile = detectProjectProfile(repoRoot);
  const discovered = await analyzeVerification(repoRoot, projectProfile);
  const runnable = resolveRunnableChecks(repoRoot, projectProfile, discovered.verificationStatus, only);

  let executionRoot = repoRoot;
  let workspace: ReturnType<typeof createVerifyWorkspace> | undefined;
  if (options.isolate) {
    workspace = createVerifyWorkspace(repoRoot);
    executionRoot = workspace.root;
  }

  try {
    const checks = await executeRunnableChecks(runnable, {
      repoRoot: executionRoot,
      timeoutSeconds,
      flakyRuns,
      offline: options.offline,
    });
    const findings = findingsFromChecks(checks);
    const failedChecks = checks.filter((check) => !check.skipped && !check.passed);
    const failures = failedChecks.map((check) =>
      check.flaky
        ? `${check.name} is flaky`
        : check.attempts.some((attempt) => attempt.timedOut)
          ? `${check.name} timed out`
          : `${check.name} failed (exit ${check.exitCode ?? "n/a"})`
    );
    const warnings = checks
      .filter((check) => check.skipped && check.skipReason)
      .map((check) => `${check.name}: ${check.skipReason}`);

    const passed = failedChecks.length === 0;
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      repositoryName: path.basename(repoRoot),
      repositoryRoot: repoRoot,
      branch: getGitBranch(repoRoot),
      timestamp: new Date(startedAt).toISOString(),
      isolated: Boolean(options.isolate),
      offline: Boolean(options.offline),
      timeoutSeconds,
      flakyRuns,
      checks,
      findings,
      passed,
      failures,
      warnings,
      durationMs: Math.max(0, Date.now() - startedAt),
      exitCode: passed ? 0 : 1,
    };
  } finally {
    workspace?.cleanup();
  }
}
