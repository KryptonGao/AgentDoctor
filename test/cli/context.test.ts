import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runContextCommand } from "../../src/cli/commands/context.js";
import { simulateEffectiveContext as publicSimulateEffectiveContext } from "../../src/index.js";

describe("context command", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the stable report as JSON", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-context-cli-"));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Run npm test.\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const report = await runContextCommand({ agent: "codex", cwd: root, includeGlobal: false, json: true });
    const json = JSON.parse(String(log.mock.calls[0][0]));
    expect(json.schemaVersion).toBe(1);
    expect(json.profile.id).toBe("codex");
    expect(report.prompt[0].source).toBe("AGENTS.md");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an invalid context window", async () => {
    await expect(runContextCommand({ agent: "codex", contextWindow: "nope" })).rejects.toThrow("positive number");
  });

  it("exports the simulator publicly and renders the human report", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-context-text-"));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Run npm test.\n");
    expect(typeof publicSimulateEffectiveContext).toBe("function");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runContextCommand({ agent: "codex", cwd: root, includeGlobal: false });
    expect(String(log.mock.calls[0][0])).toContain("Effective Context — Codex");
    expect(String(log.mock.calls[0][0])).toContain("Final Prompt");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an unknown agent profile", async () => {
    await expect(runContextCommand({ agent: "not-an-agent" })).rejects.toThrow("Unsupported agent profile");
  });
});
