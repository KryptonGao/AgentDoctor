import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { EvalRun, EvalSuite, EvalTask, EvalTaskMetrics } from "./types.js";
import { aggregateRunMetrics, computeCost, replayTaskEvidence } from "./metrics.js";
import { analyzeRuntimeSessions, collectSessionsInRange } from "../../analyzers/runtime/runtimeAnalyzer.js";
import { SessionMetrics } from "../types.js";
import { materializeInstructionsFromRef } from "./instructions.js";
import { createEvalWorkspace } from "./workspace.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 900;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 600;

export interface EvalRunnerContext {
  repoRoot: string;
  suite: EvalSuite;
  suitePath?: string;
  sessionPath?: string;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
  maxGlobalSessions?: number;
  /** Only run/evaluate the task with this id (--only). */
  only?: string;
  /** Run each task in a disposable copy so tasks cannot contaminate each other. */
  isolateTasks?: boolean;
  /** Baseline instruction ref to materialize inside an isolated task copy. */
  instructionRef?: string;
  /** Where attempt logs should be persisted; defaults to the execution root. */
  artifactsRoot?: string;
  /** Immutable git ref used to measure edits, including agent commits. */
  reviewBaselineRef?: string;
}

export interface EvalRunOutput {
  run: EvalRun;
  warnings: string[];
}

function selectTasks(ctx: EvalRunnerContext): EvalTask[] {
  if (!ctx.only) return ctx.suite.tasks;
  const tasks = ctx.suite.tasks.filter((t) => t.id === ctx.only);
  if (tasks.length === 0) {
    throw new Error(`--only "${ctx.only}" matches no task in the eval suite.`);
  }
  return tasks;
}

function sessionMatchesTask(session: SessionMetrics, task: EvalTask, singleTaskSuite: boolean): boolean {
  if (task.match?.sessionRegex) {
    const regex = new RegExp(task.match.sessionRegex, "i");
    const haystack = [session.taskTitle, session.nativeId, session.id].filter(Boolean).join(" ");
    return regex.test(haystack);
  }
  if (singleTaskSuite) return true;
  return typeof session.taskTitle === "string" && session.taskTitle.includes(task.id);
}

/**
 * Replay runner (default, offline): attribute already-collected runtime
 * sessions to golden tasks and derive effect metrics from real traces.
 * Deterministic and network-free; churn/wall-duration are n/a because traces
 * do not record them.
 */
export async function runReplayEval(ctx: EvalRunnerContext): Promise<EvalRunOutput> {
  const startedAt = Date.now();
  const tasks = selectTasks(ctx);
  const warnings: string[] = [];

  const { sessions } = await analyzeRuntimeSessions(ctx.repoRoot, ctx.sessionPath, {
    includeGlobal: ctx.includeGlobal,
    allowSensitive: ctx.allowSensitive,
    maxGlobalSessions: ctx.maxGlobalSessions,
  });

  const singleTaskSuite = tasks.length === 1;
  const sessionBuckets: SessionMetrics[][] = tasks.map(() => []);
  let unmatched = 0;

  for (const session of sessions) {
    const index = tasks.findIndex((task) => sessionMatchesTask(session, task, singleTaskSuite));
    if (index === -1) {
      unmatched += 1;
      continue;
    }
    sessionBuckets[index].push(session);
  }

  const taskMetrics: EvalTaskMetrics[] = tasks.map((task, index) => {
    const metrics: EvalTaskMetrics = { taskId: task.id };
    const sessionsForTask = sessionBuckets[index];
    metrics.sessionsMatched = sessionsForTask.length;
    if (sessionsForTask.length === 0) return metrics;

    const evidence = replayTaskEvidence(sessionsForTask);
    metrics.attempts = evidence.attempts;
    metrics.passed = evidence.passed;
    metrics.firstPass = evidence.firstPass;
    metrics.timeToGreenMs = evidence.timeToGreenMs;
    metrics.retries = evidence.retries;
    metrics.tokens = evidence.tokens;
    metrics.tokensUnknown = evidence.tokensUnknown;
    const replayCost = computeCost(evidence.tokens, ctx.suite.pricing);
    if (replayCost !== undefined) metrics.costUsd = replayCost;
    metrics.verifyCommandsTotal = evidence.verifyCommandsTotal;
    metrics.verifyCommandsFailed = evidence.verifyCommandsFailed;
    if (evidence.verifyCommandsTotal > 0) {
      metrics.testFailureRate =
        Math.round((evidence.verifyCommandsFailed / evidence.verifyCommandsTotal) * 100) / 100;
    }
    return metrics;
  });

  if (unmatched > 0) {
    warnings.push(
      `${unmatched} session(s) matched no golden task; add match.sessionRegex to the relevant task.`
    );
  }

  const run: EvalRun = {
    schemaVersion: 1,
    repositoryName: path.basename(ctx.repoRoot),
    repositoryRoot: ctx.repoRoot,
    branch: "",
    timestamp: new Date(startedAt).toISOString(),
    mode: "replay",
    suiteName: ctx.suite.name,
    suitePath: ctx.suitePath,
    tasks: taskMetrics,
    metrics: aggregateRunMetrics(taskMetrics, ctx.suite.pricing),
    unmatchedSessions: unmatched,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  return { run, warnings };
}

interface NumstatSnapshot {
  [file: string]: { additions: number; deletions: number };
}

function isEvalArtifact(file: string): boolean {
  const normalized = file.replaceAll(path.sep, "/");
  return normalized === ".agentdoctor/eval" || normalized.startsWith(".agentdoctor/eval/");
}

function countTextLines(filePath: string): number {
  try {
    const data = fs.readFileSync(filePath);
    if (data.length === 0 || data.includes(0)) return 0;
    let lines = 1;
    for (const byte of data) if (byte === 0x0a) lines += 1;
    return data[data.length - 1] === 0x0a ? lines - 1 : lines;
  } catch {
    return 0;
  }
}

function captureNumstat(repoRoot: string, baselineRef?: string): NumstatSnapshot {
  // HEAD diff covers staged + unstaged; without any commit, fall back to the
  // working-tree diff. Add text line counts for untracked files so a new
  // source file contributes to review churn too. Eval artifacts themselves
  // are intentionally excluded.
  const snapshot: NumstatSnapshot = {};
  let diffRead = false;
  const diffArgs = baselineRef
    ? [["diff", "--numstat", baselineRef], ["diff", "--numstat"]]
    : [["diff", "--numstat", "HEAD"], ["diff", "--numstat"]];
  for (const args of diffArgs) {
    try {
      const out = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
      if (out.status !== 0) continue;
      for (const line of out.stdout.split("\n")) {
        const [additions, deletions, ...rest] = line.trim().split("\t");
        const file = rest.join("\t");
        if (!file || isEvalArtifact(file)) continue;
        snapshot[file] = {
          additions: additions === "-" ? 0 : Number(additions) || 0,
          deletions: deletions === "-" ? 0 : Number(deletions) || 0,
        };
      }
      diffRead = true;
      break;
    } catch {
      // try next variant
    }
  }

  try {
    const untracked = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repoRoot, encoding: "utf-8" }
    );
    if (untracked.status === 0) {
      for (const file of untracked.stdout.split("\0").filter(Boolean)) {
        if (isEvalArtifact(file)) continue;
        const absolute = path.join(repoRoot, file);
        try {
          if (fs.statSync(absolute).isFile()) {
            snapshot[file] = { additions: countTextLines(absolute), deletions: 0 };
          }
        } catch {
          // The file may disappear while the agent is running.
        }
      }
    }
  } catch {
    // A non-git workspace can still report tracked diff data when available.
  }

  if (diffRead || Object.keys(snapshot).length > 0) return snapshot;
  return {};
}

function churnBetween(before: NumstatSnapshot, after: NumstatSnapshot) {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  const allFiles = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const file of allFiles) {
    const beforeStat = before[file] || { additions: 0, deletions: 0 };
    const afterStat = after[file] || { additions: 0, deletions: 0 };
    const addDelta = afterStat.additions - beforeStat.additions;
    const delDelta = afterStat.deletions - beforeStat.deletions;
    if (addDelta !== 0 || delDelta !== 0) {
      files += 1;
      additions += Math.max(0, addDelta);
      deletions += Math.max(0, delDelta);
    }
  }
  return { files, additions, deletions };
}

function substitute(template: string, task: EvalTask): string {
  return template.split("{prompt}").join(task.prompt).split("{task}").join(task.id);
}

interface ShellOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Command could not be started at all (ENOENT, ...). */
  spawnFailed: boolean;
  timedOut: boolean;
}

function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): ShellOutcome {
  const result = spawnSync(command, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    shell: true,
    env: { ...process.env, ...env },
  });
  const spawnFailed = Boolean(result.error) && result.status === null && !result.signal;
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    spawnFailed,
    timedOut: Boolean(result.error) && !spawnFailed,
  };
}

function writeAttemptLog(
  repoRoot: string,
  name: string,
  command: string,
  outcome: ShellOutcome
): void {
  try {
    const logDir = path.join(repoRoot, ".agentdoctor", "eval", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const body = [
      `$ ${command}`,
      `exit=${outcome.exitCode} signal=${outcome.signal} timedOut=${outcome.timedOut}`,
      "--- stdout ---",
      outcome.stdout,
      "--- stderr ---",
      outcome.stderr,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(logDir, `${name}.log`), body);
  } catch {
    // Logging must never fail the eval itself.
  }
}

function isGreen(outcome: ShellOutcome, expectPass: boolean): boolean {
  if (outcome.spawnFailed) return false;
  return expectPass ? outcome.exitCode === 0 : outcome.exitCode !== 0;
}

/**
 * Command runner: execute a real agent command per task, verify the result,
 * and measure first-pass rate, time-to-green, retries, review churn, and
 * test failures. Token usage is correlated from trace files modified during
 * the task window (n/a when the agent writes no trace).
 */
async function runCommandTask(
  ctx: EvalRunnerContext,
  task: EvalTask,
  commandTemplate: string
): Promise<EvalTaskMetrics> {
  const metrics: EvalTaskMetrics = { taskId: task.id };
  const setupStartMs = Date.now();
  const artifactsRoot = ctx.artifactsRoot || ctx.repoRoot;

  if (task.setup) {
    const setupCommand = substitute(task.setup, task);
    const setupOutcome = runShellCommand(
      setupCommand,
      ctx.repoRoot,
      (task.timeoutSeconds || DEFAULT_AGENT_TIMEOUT_SECONDS) * 1000,
      {
        AGENTDOCTOR_TASK_ID: task.id,
        AGENTDOCTOR_TASK_PROMPT: task.prompt,
      }
    );
    writeAttemptLog(artifactsRoot, `${task.id}-setup`, setupCommand, setupOutcome);
    if (!isGreen(setupOutcome, true)) {
      metrics.error = `task setup failed: ${setupOutcome.stderr.trim() || `exit ${setupOutcome.exitCode}`}`;
      metrics.attempts = 0;
      metrics.passed = false;
      metrics.firstPass = false;
      metrics.retries = 0;
      metrics.totalDurationMs = Date.now() - setupStartMs;
      metrics.tokensUnknown = true;
      return metrics;
    }
  }

  const taskStartMs = Date.now();
  const before = captureNumstat(ctx.repoRoot, ctx.reviewBaselineRef);
  const maxAttempts = Math.max(1, Math.floor(task.maxAttempts || 1));
  const agentTimeoutMs = (task.timeoutSeconds || DEFAULT_AGENT_TIMEOUT_SECONDS) * 1000;
  const verifyTimeoutMs = (task.verify?.timeoutSeconds || DEFAULT_VERIFY_TIMEOUT_SECONDS) * 1000;

  let attempts = 0;
  let green = false;

  while (attempts < maxAttempts && !green) {
    attempts += 1;
    const agentCommand = substitute(commandTemplate, task);
    const agentOutcome = runShellCommand(agentCommand, ctx.repoRoot, agentTimeoutMs, {
      AGENTDOCTOR_TASK_ID: task.id,
      AGENTDOCTOR_TASK_PROMPT: task.prompt,
    });
    writeAttemptLog(artifactsRoot, `${task.id}-attempt${attempts}`, agentCommand, agentOutcome);
    // A shell reports a missing command as exit 127; treat it as a run
    // infrastructure problem instead of a silently measured 0% pass rate.
    const commandMissing =
      agentOutcome.exitCode === 127 && /not found|not recognized/i.test(agentOutcome.stderr);
    if (agentOutcome.spawnFailed || commandMissing) {
      metrics.error = commandMissing
        ? `agent command not found: ${agentCommand}`
        : `agent command failed to start: ${agentOutcome.stderr.trim() || "unknown error"}`;
      break;
    }

    let verifyPassed = agentOutcome.exitCode === 0;
    if (task.verify) {
      metrics.verifyCommandsTotal = (metrics.verifyCommandsTotal || 0) + 1;
      const verifyOutcome = runShellCommand(task.verify.command, ctx.repoRoot, verifyTimeoutMs, {
        AGENTDOCTOR_TASK_ID: task.id,
      });
      writeAttemptLog(
        artifactsRoot,
        `${task.id}-attempt${attempts}-verify`,
        task.verify.command,
        verifyOutcome
      );
      verifyPassed = isGreen(verifyOutcome, task.verify.expectPass !== false);
      if (!verifyPassed) {
        metrics.verifyCommandsFailed = (metrics.verifyCommandsFailed || 0) + 1;
      }
    }
    if (verifyPassed) {
      metrics.timeToGreenMs = Date.now() - taskStartMs;
      green = true;
    }
  }

  metrics.attempts = attempts;
  metrics.passed = green;
  metrics.firstPass = attempts === 1 && green;
  metrics.retries = Math.max(0, attempts - 1);
  metrics.totalDurationMs = Date.now() - taskStartMs;

  const after = captureNumstat(ctx.repoRoot, ctx.reviewBaselineRef);
  const churn = churnBetween(before, after);
  // In command mode the task runs against a known git baseline, so zero edits
  // are measurable evidence rather than an unknown value. Keeping the zero
  // record also lets before/after comparisons detect newly introduced churn.
  metrics.reviewChurn = churn;

  // Best-effort token correlation: traces appended during the task window.
  try {
    const sessions = await collectSessionsInRange(
      ctx.repoRoot,
      taskStartMs,
      Date.now(),
      { includeGlobal: ctx.includeGlobal, allowSensitive: ctx.allowSensitive }
    );
    const input = sessions.reduce((sum, s) => sum + (s.tokenUsage?.input || 0), 0);
    const output = sessions.reduce((sum, s) => sum + (s.tokenUsage?.output || 0), 0);
    const knownTokens = sessions.length > 0 && sessions.every((s) => !s.tokensUnknown);
    if (knownTokens) {
      metrics.tokens = { input, output, total: input + output };
      metrics.tokensUnknown = false;
      const liveCost = computeCost(metrics.tokens, ctx.suite.pricing);
      if (liveCost !== undefined) metrics.costUsd = liveCost;
    } else {
      metrics.tokensUnknown = true;
    }
  } catch {
    metrics.tokensUnknown = true;
  }

  if ((metrics.verifyCommandsTotal || 0) > 0) {
    metrics.testFailureRate =
      Math.round(((metrics.verifyCommandsFailed || 0) / (metrics.verifyCommandsTotal || 1)) * 100) / 100;
  }

  return metrics;
}

export async function runCommandEval(
  ctx: EvalRunnerContext,
  commandTemplate: string
): Promise<EvalRunOutput> {
  const startedAt = Date.now();
  const tasks = selectTasks(ctx);
  const taskMetrics: EvalTaskMetrics[] = [];
  const isolateTasks = ctx.isolateTasks ?? true;

  for (const task of tasks) {
    if (!isolateTasks) {
      taskMetrics.push(await runCommandTask(ctx, task, commandTemplate));
      continue;
    }

    const workspace = createEvalWorkspace(ctx.repoRoot);
    try {
      if (ctx.instructionRef) {
        materializeInstructionsFromRef(ctx.repoRoot, ctx.instructionRef, workspace.root);
      }
      taskMetrics.push(
        await runCommandTask(
          {
            ...ctx,
            repoRoot: workspace.root,
            artifactsRoot: ctx.artifactsRoot || ctx.repoRoot,
            reviewBaselineRef: workspace.baselineRef,
          },
          task,
          commandTemplate
        )
      );
    } finally {
      workspace.cleanup();
    }
  }

  const run: EvalRun = {
    schemaVersion: 1,
    repositoryName: path.basename(ctx.repoRoot),
    repositoryRoot: ctx.repoRoot,
    branch: "",
    timestamp: new Date(startedAt).toISOString(),
    mode: "command",
    suiteName: ctx.suite.name,
    suitePath: ctx.suitePath,
    tasks: taskMetrics,
    metrics: aggregateRunMetrics(taskMetrics, ctx.suite.pricing),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  return { run, warnings: [] };
}
