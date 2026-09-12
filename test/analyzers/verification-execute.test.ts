import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeVerification } from "../../src/analyzers/verification/verificationAnalyzer.js";
import { detectProjectProfile } from "../../src/core/project/profile.js";
import { runVerify } from "../../src/core/verify/verify.js";
import { VerifyConfigurationError } from "../../src/core/verify/types.js";
import { summarizeFailure } from "../../src/analyzers/verification/summary.js";
import { isAllowedBinary, sanitizeVerifyEnv } from "../../src/analyzers/verification/sandbox.js";

function writePkg(dir: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "verify-fixture", scripts, ...extra }));
}

describe("verification execution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-verify-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not execute commands during static analysis", async () => {
    const marker = path.join(tmpDir, "EXECUTED");
    writePkg(tmpDir, {
      test: `node -e "require('fs').writeFileSync('EXECUTED','1')"`,
      lint: "node -e \"process.exit(0)\"",
    });
    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeVerification(tmpDir, profile);
    expect(result.verificationStatus.find((item) => item.name === "test")?.status).toBe("healthy");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("runs discovered scripts and records exit code, duration, and output tokens", async () => {
    writePkg(tmpDir, {
      test: "node -e \"console.log('ok-test'); process.exit(0)\"",
      lint: "node -e \"console.log('ok-lint'); process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
    });
    const result = await runVerify({
      cwd: tmpDir,
      flakyRuns: 1,
      timeoutSeconds: 20,
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    const test = result.checks.find((check) => check.name === "test");
    expect(test?.passed).toBe(true);
    expect(test?.exitCode).toBe(0);
    expect(test?.command).toBe("npm test");
    expect(test?.durationMs).toBeGreaterThan(0);
    expect(test?.outputTokens).toBeGreaterThan(0);
    expect(test?.failureSummary).toBeUndefined();
  });

  it("marks a failing script broken and captures a failure summary", async () => {
    writePkg(tmpDir, {
      test: "node -e \"console.error('AssertionError: expected 1 to equal 2'); process.exit(1)\"",
    });
    const result = await runVerify({ cwd: tmpDir, only: "test", flakyRuns: 1, timeoutSeconds: 20 });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    const test = result.checks.find((check) => check.name === "test");
    expect(test?.status).toBe("broken");
    expect(test?.failureSummary).toMatch(/AssertionError/);
    expect(result.findings.some((finding) => finding.ruleId === "verification/command-failed")).toBe(true);
  });

  it("detects a flaky test across repeated runs", async () => {
    writePkg(tmpDir, {
      test: "node -e \"const fs=require('fs'); const p='.flaky-flag'; if (fs.existsSync(p)) { fs.unlinkSync(p); process.exit(0); } fs.writeFileSync(p,'1'); process.exit(1);\"",
    });
    const result = await runVerify({ cwd: tmpDir, only: "test", flakyRuns: 2, timeoutSeconds: 20 });
    const test = result.checks.find((check) => check.name === "test");
    expect(test?.flaky).toBe(true);
    expect(test?.status).toBe("warning");
    expect(test?.attempts).toHaveLength(2);
    expect(result.findings.some((finding) => finding.ruleId === "verification/flaky-test")).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("times out a hung command", async () => {
    writePkg(tmpDir, {
      test: "node -e \"setTimeout(() => {}, 30000)\"",
    });
    const result = await runVerify({ cwd: tmpDir, only: "test", flakyRuns: 1, timeoutSeconds: 1 });
    const test = result.checks.find((check) => check.name === "test");
    expect(test?.status).toBe("broken");
    expect(test?.attempts[0]?.timedOut).toBe(true);
    expect(result.findings.some((finding) => finding.ruleId === "verification/command-timeout")).toBe(true);
  }, 15_000);

  it("keeps side effects out of the original tree when isolated", async () => {
    writePkg(tmpDir, {
      test: "node -e \"require('fs').writeFileSync('SIDE_EFFECT','1')\"",
    });
    const result = await runVerify({
      cwd: tmpDir,
      only: "test",
      flakyRuns: 1,
      timeoutSeconds: 20,
      isolate: true,
    });
    expect(result.isolated).toBe(true);
    expect(result.passed).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "SIDE_EFFECT"))).toBe(false);
  });

  it("strips secret environment variables before spawning", async () => {
    writePkg(tmpDir, {
      test: "node -e \"if (process.env.OPENAI_API_KEY) process.exit(3); process.exit(0)\"",
    });
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-should-not-leak";
    try {
      const result = await runVerify({ cwd: tmpDir, only: "test", flakyRuns: 1, timeoutSeconds: 20 });
      expect(result.passed).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("rejects an invalid --only target", async () => {
    writePkg(tmpDir, { test: "node -e \"process.exit(0)\"" });
    await expect(runVerify({ cwd: tmpDir, only: "deploy" })).rejects.toBeInstanceOf(VerifyConfigurationError);
  });
});

describe("verify sandbox helpers", () => {
  it("allowlists known tool binaries only", () => {
    expect(isAllowedBinary("npm")).toBe(true);
    expect(isAllowedBinary("/usr/bin/cargo")).toBe(true);
    expect(isAllowedBinary("curl")).toBe(false);
    expect(isAllowedBinary("bash")).toBe(false);
  });

  it("removes credential-like env keys", () => {
    const env = sanitizeVerifyEnv(
      { PATH: "/bin", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "ghs", NODE_ENV: "test" },
      false
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.AGENTDOCTOR_VERIFY).toBe("1");
  });

  it("summarizes failure output from the interesting tail", () => {
    const summary = summarizeFailure("ok\n", "FAIL src/foo.test.ts\nAssertionError: boom\n");
    expect(summary).toContain("AssertionError");
  });
});
