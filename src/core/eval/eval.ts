import * as fs from "node:fs";
import * as path from "node:path";
import {
  EvalComparison,
  EvalResult,
  EvalRun,
  EVAL_SCHEMA_VERSION,
} from "./types.js";
import {
  EvalConfigurationError,
  loadEvalSuite,
} from "./tasks.js";
import { EvalRunnerContext, runCommandEval, runReplayEval } from "./runner.js";
import { compareEvalRuns } from "./compare.js";
import { getInstructionPathsAtRef, swapInstructionsFromRef } from "./instructions.js";
import { getGitBranch, getGitRoot } from "../../shared/git.js";

export { EvalConfigurationError } from "./tasks.js";

export interface EvalOptions {
  cwd?: string;
  /** --tasks: explicit golden-task file (default .agentdoctor/eval/golden-tasks.json). */
  tasks?: string;
  /** --command: agent command template; presence switches to command mode. */
  command?: string;
  session?: string;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
  maxGlobalSessions?: number;
  /**
   * --baseline <ref>: instruction files (AGENTS.md/CLAUDE.md/Cursor/Copilot)
   * are taken from this ref for the "before" run. Command mode only: replayed
   * traces cannot be re-executed under old instructions.
   */
  baseline?: string;
  /**
   * --compare <run.json>: compare this run's metrics against a previously
   * saved eval result (what `eval` writes to .agentdoctor/eval/last-run.json).
   */
  compare?: string;
  /** --min-first-pass-rate: gate on the final run (0-100). */
  minFirstPassRate?: string | number;
  /** --no-fail-on-regression: keep comparisons informational. */
  noFailOnRegression?: boolean;
  /** --only <task-id>: evaluate a single task. */
  only?: string;
  /** Persist the result to .agentdoctor/eval/last-run.json (default true). */
  save?: boolean;
  /** Run live tasks in the current worktree; default is disposable isolation. */
  inPlace?: boolean;
}

const LAST_RUN_RELATIVE_PATH = path.join(".agentdoctor", "eval", "last-run.json");

function parseMinFirstPassRate(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new EvalConfigurationError("min-first-pass-rate must be a number between 0 and 100.");
  }
  return parsed;
}

function loadSavedRun(repoRoot: string, comparePath: string): EvalRun {
  const absolute = path.isAbsolute(comparePath) ? comparePath : path.join(repoRoot, comparePath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, "utf-8"));
  } catch {
    throw new EvalConfigurationError(`Could not read the saved eval run at ${absolute}.`);
  }
  // Accept both a full EvalResult envelope and a bare EvalRun.
  const candidate = (raw as { run?: unknown; before?: unknown; after?: unknown }) ?? {};
  const chosen =
    (candidate.after as EvalRun | undefined) ||
    (candidate.run as EvalRun | undefined) ||
    (raw as EvalRun);
  if (!chosen || typeof chosen !== "object" || !Array.isArray((chosen as EvalRun).tasks)) {
    throw new EvalConfigurationError(
      `${absolute} is not an eval run record (expected an EvalResult or EvalRun object).`
    );
  }
  return chosen as EvalRun;
}

function ensureComparableTaskSet(before: EvalRun, after: EvalRun): void {
  const beforeIds = before.tasks.map((task) => task.taskId).sort();
  const afterIds = after.tasks.map((task) => task.taskId).sort();
  if (
    beforeIds.length !== afterIds.length ||
    beforeIds.some((taskId, index) => taskId !== afterIds[index])
  ) {
    throw new EvalConfigurationError(
      "Cannot compare eval runs with different golden-task sets. " +
        `baseline=[${beforeIds.join(", ")}] current=[${afterIds.join(", ")}].`
    );
  }
}

/**
 * Effect evaluation orchestration: load golden tasks, run the suite
 * (replay from traces, or live via --command), optionally compare against
 * the instruction files of a baseline ref or a saved run, and gate.
 */
export async function evaluateEval(options: EvalOptions = {}): Promise<EvalResult> {
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const branch = getGitBranch(repoRoot);
  const mode = options.command && options.command.trim() !== "" ? "command" : "replay";
  const minFirstPassRate = parseMinFirstPassRate(options.minFirstPassRate);

  if (options.baseline && mode === "replay") {
    throw new EvalConfigurationError(
      "--baseline executes the golden tasks live under the old instruction files, which " +
        "requires --command. Replayed traces cannot be re-executed; run eval once per trace " +
        "set and compare records with --compare <run.json> instead."
    );
  }
  if (options.baseline && options.compare) {
    throw new EvalConfigurationError("Use either --baseline or --compare, not both.");
  }

  const { suite, suitePath } = loadEvalSuite(repoRoot, options.tasks);
  const selectedTaskCount = options.only
    ? suite.tasks.filter((task) => task.id === options.only).length
    : suite.tasks.length;
  if (options.only && selectedTaskCount === 0) {
    throw new EvalConfigurationError(`--only "${options.only}" matches no task in the eval suite.`);
  }

  const ctx: EvalRunnerContext = {
    repoRoot,
    suite,
    suitePath,
    sessionPath: options.session,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
    maxGlobalSessions: options.maxGlobalSessions,
    only: options.only,
    isolateTasks: mode === "command" && options.inPlace !== true,
    artifactsRoot: repoRoot,
  };

  const warnings: string[] = [];
  const failures: string[] = [];

  const executeRun = async (instructionRef?: string): Promise<EvalRun> => {
    if (mode === "command") {
      const { run } = await runCommandEval(
        { ...ctx, instructionRef },
        options.command as string
      );
      return run;
    }
    const { run, warnings: replayWarnings } = await runReplayEval(ctx);
    warnings.push(...replayWarnings);
    if (run.tasks.every((t) => (t.sessionsMatched || 0) === 0)) {
      if (!run.unmatchedSessions) {
        throw new EvalConfigurationError(
          "No agent session traces found for replay. Collect traces (agentdoctor otel, " +
            "native CLI logs, or --session <file>) or run live with --command."
        );
      }
      throw new EvalConfigurationError(
        "No golden task matched any session. Add match.sessionRegex to tasks, or use a " +
          "single-task suite to attribute all sessions."
      );
    }
    return run;
  };

  let run: EvalRun | null = null;
  let before: EvalRun | null = null;
  let after: EvalRun | null = null;
  let comparison: EvalComparison | null = null;

  if (options.baseline) {
    if (options.inPlace) {
      let swap;
      try {
        swap = swapInstructionsFromRef(repoRoot, options.baseline);
      } catch (error) {
        throw new EvalConfigurationError(error instanceof Error ? error.message : String(error));
      }
      if (!swap) {
        throw new EvalConfigurationError(
          `Baseline ref "${options.baseline}" contains no instruction files to compare.`
        );
      }
      try {
        before = await executeRun();
        before.instructionsRef = options.baseline;
        warnings.push(
          `Before-run used instruction files from "${options.baseline}": ${swap.swappedPaths.join(", ")}.`
        );
      } finally {
        swap.restore();
      }
    } else {
      let instructionPaths: string[];
      try {
        instructionPaths = getInstructionPathsAtRef(repoRoot, options.baseline);
      } catch (error) {
        throw new EvalConfigurationError(error instanceof Error ? error.message : String(error));
      }
      if (instructionPaths.length === 0) {
        throw new EvalConfigurationError(
          `Baseline ref "${options.baseline}" contains no instruction files to compare.`
        );
      }
      before = await executeRun(options.baseline);
      before.instructionsRef = options.baseline;
      warnings.push(
        `Before-run materialized instruction files from "${options.baseline}": ${instructionPaths.join(", ")}.`
      );
    }
    after = await executeRun();
    before.branch = branch;
    after.branch = branch;
    comparison = compareEvalRuns(before, after, options.baseline);
  } else if (options.compare) {
    run = await executeRun();
    run.branch = branch;
    const saved = loadSavedRun(repoRoot, options.compare);
    // Reuse the run-pair comparison by treating the saved run as "before".
    const savedWrapped: EvalRun = { ...saved, metrics: saved.metrics };
    const currentWrapped: EvalRun = { ...run, metrics: run.metrics };
    ensureComparableTaskSet(savedWrapped, currentWrapped);
    comparison = compareEvalRuns(savedWrapped, currentWrapped, `saved:${options.compare}`);
    before = savedWrapped;
    after = currentWrapped;
  } else {
    run = await executeRun();
    run.branch = branch;
  }

  const targetMetrics = (after || run)!.metrics;

  // Replay is only a valid suite-level measurement when every golden task has
  // first-pass evidence. Missing sessions are unknown, not successful tasks.
  if (mode === "replay") {
    const replayRuns = options.compare ? [before, after] : [run];
    for (const [index, evaluated] of replayRuns.entries()) {
      if (!evaluated) continue;
      const missing = evaluated.tasks
        .filter((task) => typeof task.firstPass !== "boolean")
        .map((task) => task.taskId);
      if (missing.length > 0) {
        const label = options.compare ? (index === 0 ? "baseline" : "current") : "run";
        failures.push(
          `${label} eval lacks first-pass evidence for ${missing.length} golden task(s): ${missing.join(", ")}`
        );
      }
    }
  }

  // Gate 1: first-pass rate floor.
  if (minFirstPassRate !== undefined) {
    if (targetMetrics.firstPassRate === undefined) {
      warnings.push(
        "First-pass rate is not measurable for the evaluated run; min-first-pass-rate was not applied."
      );
    } else if (targetMetrics.firstPassRate < minFirstPassRate) {
      failures.push(
        `first-pass rate ${targetMetrics.firstPassRate}% is below minimum ${minFirstPassRate}%`
      );
    }
  }

  // Gate 2: the instructions change must not make the agent actually worse.
  if (comparison && !options.noFailOnRegression && comparison.verdict === "regressed") {
    failures.push(
      `effect regressed against "${comparison.baselineRef}": ${comparison.regressions.join("; ")}`
    );
  }

  // Task-level execution errors make the current run unreliable. In compare
  // mode the saved record's errors were gated when it was produced, so only
  // the fresh run counts.
  const currentRuns = options.baseline ? [before, after] : [run];
  for (const evaluated of currentRuns) {
    for (const metrics of evaluated?.tasks || []) {
      if (metrics.error) {
        failures.push(`task "${metrics.taskId}" errored: ${metrics.error}`);
      }
    }
  }

  const result: EvalResult = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    mode,
    suite: { name: suite.name, path: suitePath, taskCount: selectedTaskCount },
    run,
    before,
    after,
    comparison,
    passed: failures.length === 0,
    failures,
    warnings,
    exitCode: failures.length === 0 ? 0 : 1,
  };

  if (options.save !== false) {
    const savePath = path.join(repoRoot, LAST_RUN_RELATIVE_PATH);
    try {
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, JSON.stringify(result, null, 2) + "\n");
      result.runPath = savePath;
    } catch {
      warnings.push(`Could not persist the run record to ${savePath}.`);
    }
  }

  return result;
}
