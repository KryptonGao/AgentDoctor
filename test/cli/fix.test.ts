import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runFixCommand } from "../../src/cli/commands/fix.js";
import { runInitCommand } from "../../src/cli/commands/init.js";

describe("fix and init CLI loop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-fix-cli-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "cli-fix",
      scripts: { test: "echo test", lint: "echo lint" },
    }));
    fs.writeFileSync(path.join(tmpDir, "src.ts"), "export const n = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("init writes a structure-aware AGENTS.md and optional shims", async () => {
    await runInitCommand({ cwd: tmpDir, shims: true });
    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("## Layout");
    expect(agents).toContain("Critical Commands");
    expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".github/copilot-instructions.md"))).toBe(true);
  });

  it("fix --safe --json reports applied bootstrap fixes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runFixCommand({ cwd: tmpDir, safe: true, json: true });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.applied).toContain("fix-generate-agents-md");
      expect(payload.rolledBack).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
