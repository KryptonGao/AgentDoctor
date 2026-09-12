import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateEval, EvalConfigurationError } from "../../src/core/eval/eval.js";
import { runEvalCommand } from "../../src/cli/commands/eval.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "AgentDoctor Test"], { cwd: dir });
}

function gitCommit(dir: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
}

function writeSession(repoRoot: string, id: string, taskTitle: string, failedFirst: boolean): void {
  const dir = path.join(repoRoot, ".agent", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      agentName: "Codex",
      date: "2026-09-12 10:00",
      durationSeconds: 120,
      tokenUsage: { input: 800, output: 400, total: 1200 },
      taskTitle,
      timeline: failedFirst
        ? [
            { timeOffset: "00:05", action: "run npm test", tool: "bash", status: "failed" },
            { timeOffset: "00:30", action: "run npm test", tool: "bash", status: "success" },
          ]
        : [{ timeOffset: "00:20", action: "run npm test", tool: "bash", status: "success" }],
    })
  );
}

const SUITE = {
  schemaVersion: 1,
  name: "cli fixture suite",
  tasks: [{ id: "fix-test", prompt: "fix the failing test", match: { sessionRegex: "failing test" } }],
};

describe("eval CLI contract", () => {
  let tmp: string;
  const prevGlobal = process.env.AGENTDOCTOR_INCLUDE_GLOBAL;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-eval-cli-"));
    process.env.AGENTDOCTOR_INCLUDE_GLOBAL = "0";
    initGitRepo(tmp);
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "eval-fixture", scripts: { test: "echo test" } }));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "Run `npm test`.\n");
    fs.mkdirSync(path.join(tmp, ".agentdoctor", "eval"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentdoctor", "eval", "golden-tasks.json"), JSON.stringify(SUITE));
    writeSession(tmp, "s1", "Fix the failing test", false);
    gitCommit(tmp, "init");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevGlobal === undefined) delete process.env.AGENTDOCTOR_INCLUDE_GLOBAL;
    else process.env.AGENTDOCTOR_INCLUDE_GLOBAL = prevGlobal;
  });

  it("runs a replay eval and emits the fixed JSON envelope", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runEvalCommand({ cwd: tmp, json: true, save: false });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.schemaVersion).toBe(1);
      expect(payload.mode).toBe("replay");
      expect(payload.suite.name).toBe("cli fixture suite");
      expect(payload.run).not.toBeNull();
      expect(payload.before).toBeNull();
      expect(payload.after).toBeNull();
      expect(payload.comparison).toBeNull();
      expect(payload.passed).toBe(true);
      expect(payload.exitCode).toBe(0);
      expect(payload.run.metrics.firstPassRate).toBe(100);
      expect(payload.run.tasks[0].tokens.total).toBe(1200);
    } finally {
      log.mockRestore();
    }
  });

  it("persists a run record and compares against it with --compare", async () => {
    const first = await evaluateEval({ cwd: tmp, save: true });
    expect(first.runPath).toBeTruthy();
    expect(fs.existsSync(first.runPath!)).toBe(true);

    // Degrade the trace: failed verify first -> first pass becomes false.
    writeSession(tmp, "s1", "Fix the failing test", true);
    const second = await evaluateEval({ cwd: tmp, compare: ".agentdoctor/eval/last-run.json", save: false });
    expect(second.comparison).not.toBeNull();
    expect(second.comparison?.verdict).toBe("regressed");
    expect(second.passed).toBe(false);
    expect(second.exitCode).toBe(1);
    expect(second.failures[0]).toContain("first-pass rate");
  });

  it("rejects --compare when the golden-task set changed", async () => {
    const first = await evaluateEval({ cwd: tmp, save: true });
    expect(first.runPath).toBeTruthy();
    fs.writeFileSync(
      path.join(tmp, ".agentdoctor", "eval", "golden-tasks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          { id: "fix-test", prompt: "fix the failing test", match: { sessionRegex: "failing test" } },
          { id: "new-task", prompt: "do something new", match: { sessionRegex: "new task" } },
        ],
      })
    );
    await expect(
      evaluateEval({ cwd: tmp, compare: first.runPath, save: false })
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("fails with exit code 1 when min-first-pass-rate is not met", async () => {
    writeSession(tmp, "s1", "Fix the failing test", true);
    const result = await evaluateEval({ cwd: tmp, minFirstPassRate: 80, save: false });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.failures[0]).toContain("first-pass rate 0% is below minimum 80%");
  });

  it("fails replay evaluation when a golden task has no evidence", async () => {
    fs.writeFileSync(
      path.join(tmp, ".agentdoctor", "eval", "golden-tasks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          { id: "fix-test", prompt: "fix the failing test", match: { sessionRegex: "failing test" } },
          { id: "missing-task", prompt: "do another task", match: { sessionRegex: "missing task" } },
        ],
      })
    );

    const result = await evaluateEval({ cwd: tmp, save: false });
    expect(result.run?.metrics.coverageRate).toBe(50);
    expect(result.run?.metrics.firstPassRate).toBeUndefined();
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes("missing-task"))).toBe(true);
  });

  it("rejects replay + baseline with exit code 2", async () => {
    await expect(evaluateEval({ cwd: tmp, baseline: "main", save: false })).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("returns exit code 2 when no traces exist for replay", async () => {
    fs.rmSync(path.join(tmp, ".agent"), { recursive: true, force: true });
    await expect(evaluateEval({ cwd: tmp, save: false })).rejects.toBeInstanceOf(EvalConfigurationError);
  });

  it("runs a live before/after comparison against instruction baseline", async () => {
    // Head commit changed AGENTS.md ("after"); baseline ref is the same commit
    // here, so instructions are equal and the verdict must be neutral.
    fs.writeFileSync(
      path.join(tmp, "agent.js"),
      "const fs=require('fs'); fs.writeFileSync('state.txt','2');"
    );
    gitCommit(tmp, "agent script");
    const suite = {
      schemaVersion: 1,
      tasks: [{ id: "live", prompt: "p", verify: { command: "node -e \"process.exit(0)\"" } }],
    };
    fs.writeFileSync(path.join(tmp, ".agentdoctor", "eval", "golden-tasks.json"), JSON.stringify(suite));

    const result = await evaluateEval({ cwd: tmp, command: "node agent.js", baseline: "HEAD", save: false });
    expect(result.mode).toBe("command");
    expect(result.before).not.toBeNull();
    expect(result.after).not.toBeNull();
    expect(result.before?.instructionsRef).toBe("HEAD");
    // Instructions were identical (baseline == HEAD), so the run must never
    // be judged a regression; timing jitter may produce neutral/improved.
    expect(result.comparison?.verdict).not.toBe("regressed");
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8")).toBe("Run `npm test`.\n");
  });

  it("keeps before/after task runs isolated and detects a real instruction effect", async () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "before instructions\n");
    gitCommit(tmp, "before instructions");
    const beforeRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf-8" }).trim();
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "after instructions\n");
    fs.writeFileSync(
      path.join(tmp, "agent.js"),
      "const fs=require('fs'); if (fs.readFileSync('AGENTS.md','utf8').includes('after')) fs.writeFileSync('marker.txt','green\\n');"
    );
    fs.writeFileSync(path.join(tmp, "verify-marker.js"), "process.exit(require('fs').existsSync('marker.txt') ? 0 : 1);");
    fs.writeFileSync(
      path.join(tmp, ".agentdoctor", "eval", "golden-tasks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [{ id: "instruction-effect", prompt: "follow the instructions", verify: { command: "node verify-marker.js" } }],
      })
    );

    const result = await evaluateEval({
      cwd: tmp,
      command: "node agent.js",
      baseline: beforeRef,
      save: false,
    });

    expect(result.before?.metrics.firstPassRate).toBe(0);
    expect(result.after?.metrics.firstPassRate).toBe(100);
    expect(result.comparison?.verdict).toBe("improved");
    expect(result.passed).toBe(true);
    // Isolated runs must not leak the agent's edits into the caller's tree.
    expect(fs.existsSync(path.join(tmp, "marker.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8")).toBe("after instructions\n");
  });

  it("writes a starter suite via --init", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-eval-init-"));
    try {
      initGitRepo(fresh);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await runEvalCommand({ cwd: fresh, init: true, json: true });
        const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(fs.existsSync(payload.created)).toBe(true);
      } finally {
        log.mockRestore();
      }
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
