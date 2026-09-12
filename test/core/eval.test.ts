import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  aggregateRunMetrics,
  isVerificationEvent,
  parseTimeOffset,
  replayTaskEvidence,
} from "../../src/core/eval/metrics.js";
import { compareEvalRuns } from "../../src/core/eval/compare.js";
import {
  EvalConfigurationError,
  initEvalSuite,
  loadEvalSuite,
  parseEvalSuite,
  scaffoldEvalSuiteText,
} from "../../src/core/eval/tasks.js";
import {
  runCommandEval,
  runReplayEval,
} from "../../src/core/eval/runner.js";
import { swapInstructionsFromRef } from "../../src/core/eval/instructions.js";
import { SessionMetrics, SessionTimelineEvent } from "../../src/core/types.js";

function makeSession(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    id: "session-1",
    agentName: "Codex",
    date: "2026-09-12 10:00",
    efficiencyScore: 80,
    durationSeconds: 300,
    tokenUsage: { input: 1000, output: 500, total: 1500 },
    toolCalls: 4,
    failedToolCalls: 0,
    commandsExecuted: 2,
    filesRead: [],
    filesEdited: [],
    searchOperations: [],
    toolOutputTokens: 0,
    timeline: [],
    retriesCount: 0,
    ...overrides,
  };
}

function verifyEvent(timeOffset: string, status: SessionTimelineEvent["status"]): SessionTimelineEvent {
  return { timeOffset, action: "run npm test", tool: "bash", status };
}

describe("eval metrics primitives", () => {
  it("parses mm:ss offsets and detects verification commands", () => {
    expect(parseTimeOffset("00:40")).toBe(40);
    expect(parseTimeOffset("01:02:03")).toBe(3723);
    expect(parseTimeOffset("bogus")).toBeUndefined();
    expect(parseTimeOffset(undefined)).toBeUndefined();
    expect(isVerificationEvent(verifyEvent("00:01", "success"))).toBe(true);
    expect(isVerificationEvent({ timeOffset: "00:01", action: "Read src/a.ts", status: "success" })).toBe(false);
  });

  it("derives first pass, time-to-green, retries, and test failure rate from a trace", () => {
    const evidence = replayTaskEvidence([
      makeSession({
        timeline: [
          { timeOffset: "00:10", action: "run npm test", status: "failed" },
          { timeOffset: "00:40", action: "run npm test", status: "success" },
        ],
        retriesCount: 1,
      }),
    ]);
    expect(evidence.firstPass).toBe(false);
    expect(evidence.passed).toBe(true);
    expect(evidence.timeToGreenMs).toBe(40_000);
    expect(evidence.retries).toBe(1);
    expect(evidence.verifyCommandsTotal).toBe(2);
    expect(evidence.verifyCommandsFailed).toBe(1);
    expect(evidence.tokens?.total).toBe(1500);
    expect(evidence.tokensUnknown).toBe(false);
  });

  it("uses the final verification status for the task result", () => {
    const evidence = replayTaskEvidence([
      makeSession({
        timeline: [
          verifyEvent("00:05", "success"),
          verifyEvent("00:10", "failed"),
        ],
      }),
    ]);
    expect(evidence.firstPass).toBe(true);
    expect(evidence.passed).toBe(false);
  });

  it("keeps first-pass unknown when a session has no verification commands", () => {
    const evidence = replayTaskEvidence([makeSession({ timeline: [{ timeOffset: "00:05", action: "Read src/a.ts", status: "success" }] })]);
    expect(evidence.firstPass).toBeUndefined();
    expect(evidence.verifyCommandsTotal).toBe(0);
  });

  it("aggregates suite metrics with n/a preserved and optional cost", () => {
    const metrics = aggregateRunMetrics(
      [
        { taskId: "a", firstPass: true, passed: true, timeToGreenMs: 30_000, tokens: { input: 1_000_000, output: 500_000, total: 1_500_000 }, retries: 0 },
        { taskId: "b", firstPass: false, passed: false, verifyCommandsTotal: 4, verifyCommandsFailed: 1, retries: 2 },
        { taskId: "c" },
      ],
      { inputPerMTok: 3, outputPerMTok: 15 }
    );
    expect(metrics.firstPassRate).toBeUndefined();
    expect(metrics.evaluatedTaskCount).toBe(2);
    expect(metrics.unknownTaskCount).toBe(1);
    expect(metrics.coverageRate).toBe(67);
    expect(metrics.passedCount).toBe(1);
    expect(metrics.medianTimeToGreenMs).toBe(30_000);
    expect(metrics.totalTokens).toBeUndefined();
    expect(metrics.costUsd).toBeUndefined();
    expect(metrics.tokensUnknown).toBe(true);
    expect(metrics.totalRetries).toBe(2);
    expect(metrics.testFailureRate).toBe(0.25);
  });

  it("does not fabricate tokens when every task is unknown", () => {
    const metrics = aggregateRunMetrics([{ taskId: "a", firstPass: true }]);
    expect(metrics.totalTokens).toBeUndefined();
    expect(metrics.tokensUnknown).toBe(true);
    expect(metrics.firstPassRate).toBe(100);
  });
});

describe("eval suite loading", () => {
  it("accepts a valid suite and normalizes defaults", () => {
    const suite = parseEvalSuite(
      { schemaVersion: 1, tasks: [{ id: "t1", prompt: "do it", verify: { command: "npm test" } }] },
      "inline"
    );
    expect(suite.tasks[0].verify?.expectPass).toBe(true);
    expect(suite.tasks[0].maxAttempts).toBeUndefined();
  });

  it("rejects empty suites, duplicate ids, and bad regexes with exit code 2 errors", () => {
    expect(() => parseEvalSuite({ tasks: [] }, "inline")).toThrow(EvalConfigurationError);
    expect(() =>
      parseEvalSuite({ tasks: [{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }] }, "inline")
    ).toThrow(/duplicate task id/);
    expect(() =>
      parseEvalSuite({ tasks: [{ id: "a", prompt: "x", match: { sessionRegex: "(" } }] }, "inline")
    ).toThrow(/valid regex/);
    try {
      parseEvalSuite({ tasks: [] }, "inline");
    } catch (error) {
      expect((error as EvalConfigurationError).exitCode).toBe(2);
    }
  });

  it("loads from the default path and scaffolds with --init", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-eval-tasks-"));
    try {
      expect(() => loadEvalSuite(tmp)).toThrow(EvalConfigurationError);
      const suitePath = initEvalSuite(tmp);
      expect(fs.existsSync(suitePath)).toBe(true);
      const { suite } = loadEvalSuite(tmp);
      expect(suite.tasks.length).toBeGreaterThanOrEqual(1);
      // The scaffold itself must round-trip through the validator.
      expect(() => parseEvalSuite(JSON.parse(scaffoldEvalSuiteText("repo")), "scaffold")).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("eval comparison verdicts", () => {
  const baseRun = (metrics: any) =>
    ({
      schemaVersion: 1,
      repositoryName: "r",
      repositoryRoot: "/r",
      branch: "main",
      timestamp: "2026-09-12T00:00:00Z",
      mode: "replay",
      tasks: [],
      metrics,
      durationMs: 1,
    }) as any;

  it("marks primary improvements as improved and primary regressions as regressed", () => {
    const improved = compareEvalRuns(
      baseRun({ firstPassRate: 50, medianTimeToGreenMs: 60_000 }),
      baseRun({ firstPassRate: 100, medianTimeToGreenMs: 30_000 }),
      "main"
    );
    expect(improved.verdict).toBe("improved");

    const regressed = compareEvalRuns(
      baseRun({ firstPassRate: 100, medianTimeToGreenMs: 30_000 }),
      baseRun({ firstPassRate: 50, medianTimeToGreenMs: 60_000 }),
      "main"
    );
    expect(regressed.verdict).toBe("regressed");
    expect(regressed.regressions.some((r) => r.includes("first-pass rate"))).toBe(true);
  });

  it("keeps secondary-only shifts neutral and skips unknown metrics", () => {
    const neutral = compareEvalRuns(
      baseRun({ firstPassRate: 100, totalTokens: 1000 }),
      baseRun({ firstPassRate: 100, totalTokens: 2000 }),
      "main"
    );
    expect(neutral.verdict).toBe("neutral");
    expect(neutral.regressions.some((r) => r.includes("tokens"))).toBe(true);

    const unknown = compareEvalRuns(baseRun({ firstPassRate: 100 }), baseRun({}), "main");
    expect(unknown.verdict).toBe("neutral");
    expect(unknown.regressions).toHaveLength(0);
  });

  it("compares configured cost and treats retry changes as exact", () => {
    const comparison = compareEvalRuns(
      baseRun({ firstPassRate: 100, totalRetries: 0, costUsd: 1 }),
      baseRun({ firstPassRate: 100, totalRetries: 1, costUsd: 2 }),
      "main"
    );
    expect(comparison.verdict).toBe("neutral");
    expect(comparison.regressions.some((r) => r.includes("retries"))).toBe(true);
    expect(comparison.regressions.some((r) => r.includes("cost"))).toBe(true);
  });
});

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "AgentDoctor Test"], { cwd: dir });
}

function gitCommit(dir: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
}

describe("instruction baseline swap", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-eval-swap-"));
    initGitRepo(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("swaps instruction files from the ref and restores them exactly", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "swap-fixture" }));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "before instructions\n");
    fs.mkdirSync(path.join(tmp, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".cursor", "rules", "old.mdc"), "old rule\n");
    gitCommit(tmp, "before");
    const beforeRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf-8" }).trim();

    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "after instructions\n");
    fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "new file\n");
    gitCommit(tmp, "after");

    const swap = swapInstructionsFromRef(tmp, beforeRef)!;
    expect(swap.swappedPaths).toContain("AGENTS.md");
    expect(swap.swappedPaths).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8")).toBe("before instructions\n");
    expect(fs.existsSync(path.join(tmp, "CLAUDE.md"))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, ".cursor", "rules", "old.mdc"), "utf-8")).toBe("old rule\n");

    swap.restore();
    expect(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8")).toBe("after instructions\n");
    expect(fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8")).toBe("new file\n");
  });

  it("returns null when neither the ref nor the worktree has instruction files", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "no-instructions" }));
    gitCommit(tmp, "init");
    expect(swapInstructionsFromRef(tmp, "HEAD")).toBeNull();
  });

  it("throws on an unresolvable ref", () => {
    expect(() => swapInstructionsFromRef(tmp, "does-not-exist")).toThrow(/Could not resolve/);
  });
});

describe("command runner", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-eval-cmd-"));
    initGitRepo(tmp);
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "cmd-fixture" }));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "run node scripts\n");
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "original\n");
    gitCommit(tmp, "init");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("retries until green and measures attempts, churn, and time-to-green", async () => {
    fs.writeFileSync(
      path.join(tmp, "agent.js"),
      [
        "const fs = require('fs');",
        "let n = 0;",
        "try { n = parseInt(fs.readFileSync('state.txt','utf8'),10) || 0; } catch {}",
        "n += 1;",
        "fs.writeFileSync('state.txt', String(n));",
        "fs.writeFileSync('tracked.txt', `edited attempt ${n}\\n`);",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(tmp, "verify.js"),
      [
        "const fs = require('fs');",
        "const n = parseInt(fs.readFileSync('state.txt','utf8'),10);",
        "process.exit(n === 2 ? 0 : 1);",
      ].join("\n")
    );

    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: {
          schemaVersion: 1,
          tasks: [
            { id: "needs-retry", prompt: "make verify green", verify: { command: "node verify.js" }, maxAttempts: 3 },
          ],
        },
      },
      "node agent.js"
    );

    const task = run.tasks[0];
    expect(task.error).toBeUndefined();
    expect(task.attempts).toBe(2);
    expect(task.passed).toBe(true);
    expect(task.firstPass).toBe(false);
    expect(task.retries).toBe(1);
    expect(task.timeToGreenMs).toBeGreaterThanOrEqual(0);
    expect(task.reviewChurn?.files).toBeGreaterThanOrEqual(1);
    expect(task.reviewChurn?.additions).toBeGreaterThanOrEqual(1);
    expect(task.testFailureRate).toBe(0.5); // 1 failed verify out of 2
    expect(run.metrics.firstPassRate).toBe(0);
  });

  it("isolates task edits and includes newly created text files in review churn", async () => {
    fs.writeFileSync(
      path.join(tmp, "agent-new-file.js"),
      "const fs=require('fs'); fs.writeFileSync('generated.ts','export const generated = true;\\n');"
    );
    fs.writeFileSync(path.join(tmp, "verify-generated.js"), "process.exit(require('fs').existsSync('generated.ts') ? 0 : 1);");

    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: {
          schemaVersion: 1,
          tasks: [{ id: "new-file", prompt: "create a file", verify: { command: "node verify-generated.js" } }],
        },
      },
      "node agent-new-file.js"
    );

    expect(run.tasks[0].passed).toBe(true);
    expect(run.tasks[0].reviewChurn?.additions).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp, "generated.ts"))).toBe(false);
  });

  it("records a first pass when the verify command is green on attempt one", async () => {
    fs.writeFileSync(
      path.join(tmp, "agent.js"),
      "const fs = require('fs'); fs.writeFileSync('state.txt', '2');"
    );
    fs.writeFileSync(path.join(tmp, "verify.js"), "process.exit(0);");

    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: { schemaVersion: 1, tasks: [{ id: "instant", prompt: "p", verify: { command: "node verify.js" } }] },
      },
      "node agent.js"
    );
    expect(run.tasks[0].firstPass).toBe(true);
    expect(run.tasks[0].retries).toBe(0);
    expect(run.metrics.firstPassRate).toBe(100);
  });

  it("records zero review churn when a command makes no edits", async () => {
    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: {
          schemaVersion: 1,
          tasks: [{ id: "no-edit", prompt: "inspect only", verify: { command: "node -e \"process.exit(0)\"" } }],
        },
      },
      "node -e \"process.exit(0)\""
    );

    expect(run.tasks[0].passed).toBe(true);
    expect(run.tasks[0].reviewChurn).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(run.metrics.reviewChurn).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("counts edits even when the agent commits inside the isolated workspace", async () => {
    fs.writeFileSync(
      path.join(tmp, "agent-commit.js"),
      [
        "const fs=require('fs');",
        "const { execFileSync }=require('child_process');",
        "fs.writeFileSync('committed.txt','agent change\\n');",
        "execFileSync('git',['add','committed.txt']);",
        "execFileSync('git',['commit','-m','agent change'],{stdio:'ignore'});",
      ].join("\n")
    );

    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: {
          schemaVersion: 1,
          tasks: [{ id: "commit-edit", prompt: "make a committed edit", verify: { command: "node -e \"process.exit(0)\"" } }],
        },
      },
      "node agent-commit.js"
    );

    expect(run.tasks[0].passed).toBe(true);
    expect(run.tasks[0].reviewChurn?.additions).toBeGreaterThan(0);
  });

  it("runs deterministic task setup inside the isolated workspace", async () => {
    fs.writeFileSync(
      path.join(tmp, "agent-setup.js"),
      "const fs=require('fs'); if (fs.existsSync('fixture.txt')) fs.writeFileSync('fixed.txt','ok\\n');"
    );
    fs.writeFileSync(path.join(tmp, "verify-setup.js"), "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1);");

    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: {
          schemaVersion: 1,
          tasks: [
            {
              id: "setup-task",
              prompt: "fix the fixture",
              setup: "node -e \"require('fs').writeFileSync('fixture.txt','broken\\\\n')\"",
              verify: { command: "node verify-setup.js" },
            },
          ],
        },
      },
      "node agent-setup.js"
    );

    expect(run.tasks[0].passed).toBe(true);
    expect(fs.existsSync(path.join(tmp, "fixture.txt"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "fixed.txt"))).toBe(false);
  });

  it("reports a task error when the agent command cannot start", async () => {
    const { run } = await runCommandEval(
      {
        repoRoot: tmp,
        suite: { schemaVersion: 1, tasks: [{ id: "broken", prompt: "p" }] },
      },
      "agentdoctor-definitely-missing-command-xyz"
    );
    expect(run.tasks[0].error).toBeTruthy();
    expect(run.tasks[0].passed).toBe(false);
  });

  it("respects --only filtering and rejects unknown ids", async () => {
    const ctx = {
      repoRoot: tmp,
      suite: {
        schemaVersion: 1,
        tasks: [
          { id: "a", prompt: "p" },
          { id: "b", prompt: "p" },
        ],
      },
    };
    const onlyA = await runCommandEval({ ...ctx, only: "a" }, "true");
    expect(onlyA.run.tasks.map((t) => t.taskId)).toEqual(["a"]);
    await expect(runCommandEval({ ...ctx, only: "missing" }, "true")).rejects.toThrow(/matches no task/);
  });
});

describe("replay runner", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-eval-replay-"));
    process.env.AGENTDOCTOR_INCLUDE_GLOBAL = "0";
  });

  afterEach(() => {
    delete process.env.AGENTDOCTOR_INCLUDE_GLOBAL;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeAgentDoctorSession(id: string, taskTitle: string, failedFirst: boolean): void {
    const dir = path.join(tmp, ".agent", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const session = {
      id,
      agentName: "Codex",
      date: "2026-09-12 10:00",
      durationSeconds: 120,
      tokenUsage: { input: 800, output: 400, total: 1200 },
      taskTitle,
      retriesCount: failedFirst ? 1 : 0,
      timeline: failedFirst
        ? [
            { timeOffset: "00:05", action: "run npm test", tool: "bash", status: "failed" },
            { timeOffset: "00:30", action: "run npm test", tool: "bash", status: "success" },
          ]
        : [{ timeOffset: "00:20", action: "run npm test", tool: "bash", status: "success" }],
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(session));
  }

  it("attributes sessions by regex and by task title, warns about unmatched", async () => {
    writeAgentDoctorSession("s1", "Fix the failing test", true);
    writeAgentDoctorSession("s2", "totally unrelated", true);

    const { run, warnings } = await runReplayEval({
      repoRoot: tmp,
      suite: {
        schemaVersion: 1,
        tasks: [
          { id: "fix-test", prompt: "p", match: { sessionRegex: "failing test" } },
          { id: "other", prompt: "p" },
        ],
      },
    });
    const fixTest = run.tasks.find((t) => t.taskId === "fix-test")!;
    expect(fixTest.sessionsMatched).toBe(1);
    expect(fixTest.firstPass).toBe(false);
    expect(fixTest.passed).toBe(true);
    // "other" has no match config and the suite is multi-task: s2's title does
    // not contain the id, so it stays unmatched.
    expect(run.tasks.find((t) => t.taskId === "other")!.sessionsMatched).toBe(0);
    expect(run.unmatchedSessions).toBe(1);
    expect(warnings.some((w) => w.includes("matched no golden task"))).toBe(true);
  });

  it("attributes all sessions when the suite has a single task", async () => {
    writeAgentDoctorSession("s1", "anything", false);
    const { run } = await runReplayEval({
      repoRoot: tmp,
      suite: { schemaVersion: 1, tasks: [{ id: "only-task", prompt: "p" }] },
    });
    expect(run.tasks[0].sessionsMatched).toBe(1);
    expect(run.tasks[0].firstPass).toBe(true);
    expect(run.metrics.firstPassRate).toBe(100);
    expect(run.unmatchedSessions).toBe(0);
  });
});
