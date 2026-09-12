import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runVerifyCommand } from "../../src/cli/commands/verify.js";

describe("verify CLI contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-verify-cli-"));
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "verify-cli-fixture",
        scripts: {
          test: "node -e \"console.log('cli-test'); process.exit(0)\"",
          lint: "node -e \"process.exit(0)\"",
        },
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("emits a fixed JSON envelope for a passing run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runVerifyCommand({ cwd: tmp, json: true, only: "test", flakyRuns: 1, timeout: 20 });
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.schemaVersion).toBe(1);
    expect(payload.passed).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.checks[0].name).toBe("test");
    expect(payload.checks[0].exitCode).toBe(0);
    expect(typeof payload.durationMs).toBe("number");
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    process.exitCode = 0;
  });

  it("prints a configuration error envelope for an unknown target", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runVerifyCommand({ cwd: tmp, json: true, only: "deploy" });
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.schemaVersion).toBe(1);
    expect(payload.passed).toBe(false);
    expect(payload.exitCode).toBe(2);
    expect(payload.failures[0]).toMatch(/Unknown verify target/);
    process.exitCode = 0;
  });
});
