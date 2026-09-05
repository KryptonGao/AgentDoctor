import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CheckConfigurationError, evaluateCheck } from "../../src/core/regression/check.js";
import { runCheckCommand } from "../../src/cli/commands/check.js";

describe("check baseline CLI contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-check-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "AgentDoctor Test"], { cwd: tmpDir });
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "export const ok = true;\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "check-fixture", scripts: { test: "echo test" } }));
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "Run `npm test`.\n");
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compares the working tree with main and reports regressions", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "Run `npm test`.\nUse `src/missing.ts`.\n");

    const result = await evaluateCheck({ cwd: tmpDir, baseline: "main", minScore: 0 });
    expect(result.exitCode).toBe(1);
    expect(result.comparison?.baselineRef).toBe("main");
    expect(result.comparison?.headScore).toBeLessThanOrEqual(result.comparison?.baselineScore || 0);
    expect(result.comparison?.regressions.some((regression) => regression.title === "stale instruction")).toBe(true);
  });

  it("returns a configuration error for an unknown baseline ref", async () => {
    await expect(evaluateCheck({ cwd: tmpDir, baseline: "does-not-exist" })).rejects.toBeInstanceOf(CheckConfigurationError);
  });

  it("keeps baseline and comparison keys present when no baseline is configured", async () => {
    const result = await evaluateCheck({ cwd: tmpDir, minScore: 0 });
    expect(result.schemaVersion).toBe(1);
    expect(result.baseline).toBeNull();
    expect(result.comparison).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it("emits the fixed JSON envelope from the command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await runCheckCommand({ cwd: tmpDir, minScore: 0, json: true });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.schemaVersion).toBe(1);
      expect(payload.result.overallScore).toBe(result.result.overallScore);
      expect(payload.baseline).toBeNull();
      expect(payload.comparison).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
