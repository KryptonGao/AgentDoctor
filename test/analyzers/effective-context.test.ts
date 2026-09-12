import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { simulateEffectiveContext } from "../../src/analyzers/context/effectiveContext.js";
import { estimateTokens } from "../../src/analyzers/context/tokenCounter.js";

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe.sequential("Effective Context simulator", () => {
  let root: string;
  const originalEnv = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, COPILOT_HOME: process.env.COPILOT_HOME };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-effective-"));
    write(root, "package.json", "{}");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("loads Codex root-to-cwd instructions, selects override files, and enforces the byte budget", async () => {
    write(root, "AGENTS.md", "Root says use Node 18.\n");
    write(root, "packages/api/AGENTS.md", "This file must lose to override.\n");
    write(root, "packages/api/AGENTS.override.md", "Nested says use Node 20 and keep this explanation deliberately long.\n");
    write(root, ".codex/config.toml", "project_doc_max_bytes = 55\n");

    const report = await simulateEffectiveContext({ agent: "codex", cwd: path.join(root, "packages/api"), includeGlobal: false, contextWindowTokens: 1000 });
    expect(report.prompt.map((entry) => entry.source)).toEqual(["AGENTS.md", "packages/api/AGENTS.override.md"]);
    expect(report.prompt.some((entry) => entry.source.endsWith("packages/api/AGENTS.md"))).toBe(false);
    expect(report.prompt[1].status).toBe("truncated");
    expect(report.budget.knownLimits.find((limit) => limit.name === "Codex project instructions")?.limit).toBe(55);
    expect(report.budget.remainingTokens).toBe(1000 - report.budget.promptTokens);
  });

  it("applies Codex config/profile precedence, records MCP overrides, and never emits MCP env values", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    write(codexHome, "config.toml", `model = "user-model"\n[profiles.fast]\nmodel = "profile-model"\n[mcp_servers.db]\ncommand = "user-db"\n[mcp_servers.db.env]\nAPI_TOKEN = "top-secret-value"\n`);
    write(root, ".codex/config.toml", `[mcp_servers.db]\ncommand = "project-db"\n`);

    const report = await simulateEffectiveContext({ agent: "codex", cwd: root, profile: "fast" });
    const models = report.capabilities.filter((capability) => capability.kind === "configuration" && capability.name === "model");
    expect(models.map((item) => item.status)).toEqual(["overridden", "selected"]);
    expect(report.capabilities.find((item) => item.kind === "mcp" && item.name === "db" && item.scope === "repository")?.status).toBe("available");
    expect(report.relationships.some((relationship) => relationship.type === "overrides" && relationship.reason.includes("MCP"))).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).toContain("API_TOKEN:set");
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("separates selected Codex skill bodies from the discovery catalogue", async () => {
    write(root, ".agents/skills/review/SKILL.md", "---\nname: review\ndescription: Review code safely\n---\nRun the focused test.\n");
    const report = await simulateEffectiveContext({ agent: "codex", cwd: root, includeGlobal: false, skills: ["review"] });
    expect(report.prompt.some((entry) => entry.kind === "skill-metadata")).toBe(true);
    expect(report.prompt.some((entry) => entry.kind === "skill" && entry.name === "review")).toBe(true);
    expect(report.capabilities.find((item) => item.kind === "skill" && item.name === "review")?.status).toBe("selected");
  });

  it("loads Claude imports, target-scoped rules and nested memories while keeping conflicts unresolved", async () => {
    write(root, "CLAUDE.md", "Use Node 18.\n@shared.md\n@../../outside.md\n");
    write(root, "shared.md", "Use Node 20.\n@CLAUDE.md\n");
    write(root, "src/CLAUDE.md", "Nested target memory.\n");
    write(root, ".claude/rules/typescript.md", "---\npaths: src/**/*.ts\n---\nTypeScript target rule.\n");
    write(root, ".claude/rules/docs.md", "---\npaths: docs/**/*.md\n---\nDocs target rule.\n");
    write(root, "src/app.ts", "export {};\n");

    const report = await simulateEffectiveContext({ agent: "claude", cwd: root, targetPaths: ["src/app.ts"], includeGlobal: false });
    expect(report.prompt.some((entry) => entry.source === "shared.md" && entry.kind === "import")).toBe(true);
    expect(report.prompt.some((entry) => entry.source === "src/CLAUDE.md")).toBe(true);
    expect(report.prompt.some((entry) => entry.source.endsWith("typescript.md"))).toBe(true);
    expect(report.candidates.some((entry) => entry.source.endsWith("docs.md"))).toBe(true);
    expect(report.relationships.some((relationship) => relationship.type === "merged-unresolved")).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === "external-import-blocked")).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === "import-cycle")).toBe(true);
  });

  it("classifies Cursor activation modes without guessing Agent Requested rules", async () => {
    write(root, "AGENTS.md", "Root Cursor context.\n");
    write(root, ".cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nAlways.\n");
    write(root, ".cursor/rules/source.mdc", "---\nglobs: src/**/*.ts\n---\nSource.\n");
    write(root, ".cursor/rules/requested.mdc", "---\ndescription: Database help\n---\nRequested.\n");
    write(root, ".cursor/rules/manual.mdc", "---\n---\nManual.\n");
    write(root, "src/app.ts", "export {};\n");

    const report = await simulateEffectiveContext({ agent: "cursor", cwd: root, targetPaths: ["src/app.ts"], rules: ["manual"], includeGlobal: false });
    expect(report.prompt.some((entry) => entry.name === "always")).toBe(true);
    expect(report.prompt.some((entry) => entry.name === "source")).toBe(true);
    expect(report.prompt.some((entry) => entry.name === "manual")).toBe(true);
    expect(report.candidates.some((entry) => entry.name === "requested")).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === "cursor-user-rules-unavailable")).toBe(true);
  });

  it("applies Copilot applyTo conditions and does not invent a natural-language winner", async () => {
    write(root, "AGENTS.md", "Use pnpm only.\n");
    write(root, ".github/instructions/source.instructions.md", "---\napplyTo: src/**/*.ts\n---\nUse npm only.\n");
    write(root, ".github/instructions/docs.instructions.md", "---\napplyTo: docs/**/*.md\n---\nDocs.\n");
    write(root, "src/app.ts", "export {};\n");
    const report = await simulateEffectiveContext({ agent: "copilot", cwd: root, targetPaths: ["src/app.ts"], includeGlobal: false });
    expect(report.prompt.some((entry) => entry.source.endsWith("source.instructions.md"))).toBe(true);
    expect(report.candidates.some((entry) => entry.source.endsWith("docs.instructions.md"))).toBe(true);
    expect(report.relationships.some((relationship) => relationship.type === "merged-unresolved")).toBe(true);
  });

  it("counts before redaction, redacts prompt text, reports missing targets, and rejects outside paths", async () => {
    const raw = "Use token=sk-1234567890 for the local fixture.\n";
    write(root, "AGENTS.md", raw);
    const report = await simulateEffectiveContext({ agent: "codex", cwd: root, includeGlobal: false, targetPaths: ["src/future.ts"] });
    expect(report.prompt[0].estimatedTokens).toBe(estimateTokens(raw));
    expect(report.finalInstructions).toContain("[REDACTED");
    expect(report.finalInstructions).not.toContain("sk-1234567890");
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === "target-missing")).toBe(true);
    await expect(simulateEffectiveContext({ agent: "codex", cwd: root, targetPaths: ["../outside.ts"] })).rejects.toThrow("inside the repository");
  });

  it("marks broken frontmatter/config invalid and keeps untriggered hooks out of the prompt", async () => {
    write(root, ".claude/rules/broken.md", "---\npaths: [src/**\nBroken rule.\n");
    write(root, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm test" }] }] } }));
    const claude = await simulateEffectiveContext({ agent: "claude", cwd: root, includeGlobal: false });
    expect(claude.candidates.find((entry) => entry.source.endsWith("broken.md"))?.status).toBe("invalid");
    expect(claude.candidates.some((entry) => entry.kind === "hook")).toBe(true);
    expect(claude.prompt.some((entry) => entry.kind === "hook")).toBe(false);

    write(root, ".codex/config.toml", "[broken\nvalue = true\n");
    const codex = await simulateEffectiveContext({ agent: "codex", cwd: root, includeGlobal: false });
    expect(codex.diagnostics.some((diagnostic) => diagnostic.code === "invalid-toml")).toBe(true);
  });

  it("simulates Gemini, Windsurf, Cline, Aider, OpenCode, and Roo local configs", async () => {
    write(root, "GEMINI.md", "Gemini root memory.\n");
    write(root, ".gemini/settings.json", JSON.stringify({ mcpServers: { search: { command: "gemini-mcp" } } }));
    const gemini = await simulateEffectiveContext({ agent: "gemini", cwd: root, includeGlobal: false });
    expect(gemini.profile.id).toBe("gemini");
    expect(gemini.prompt.some((entry) => entry.source === "GEMINI.md")).toBe(true);
    expect(gemini.capabilities.some((cap) => cap.kind === "mcp" && cap.name === "search")).toBe(true);

    write(root, ".windsurfrules", "Always prefer the source tree.\n");
    write(root, ".windsurf/rules/src.md", "---\ntrigger: glob\nglobs: src/**/*.ts\n---\nTypeScript only.\n");
    write(root, ".windsurf/mcp.json", JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }));
    write(root, "src/app.ts", "export {};\n");
    const windsurf = await simulateEffectiveContext({ agent: "windsurf", cwd: root, targetPaths: ["src/app.ts"], includeGlobal: false });
    expect(windsurf.prompt.some((entry) => entry.source === ".windsurfrules")).toBe(true);
    expect(windsurf.prompt.some((entry) => entry.source.endsWith("src.md"))).toBe(true);
    expect(windsurf.capabilities.some((cap) => cap.kind === "mcp" && cap.name === "docs")).toBe(true);

    write(root, ".clinerules/base.md", "Cline project rules.\n");
    write(root, ".mcp.json", JSON.stringify({ mcpServers: { shared: { command: "shared-mcp" } } }));
    const cline = await simulateEffectiveContext({ agent: "cline", cwd: root, includeGlobal: false });
    expect(cline.prompt.some((entry) => entry.source.endsWith(".clinerules/base.md"))).toBe(true);
    expect(cline.capabilities.some((cap) => cap.kind === "mcp" && cap.name === "shared")).toBe(true);

    write(root, "CONVENTIONS.md", "Use the test command.\n");
    write(root, ".aider.conf.yml", "read:\n  - notes.md\n");
    write(root, "notes.md", "Extra aider notes.\n");
    const aider = await simulateEffectiveContext({ agent: "aider", cwd: root, includeGlobal: false });
    expect(aider.prompt.map((entry) => entry.source)).toEqual(expect.arrayContaining(["CONVENTIONS.md", "notes.md"]));

    write(root, "AGENTS.md", "OpenCode agents file.\n");
    write(root, "opencode.jsonc", `{\n  // comment\n  "mcp": { "browser": { "type": "local", "command": ["npx", "browser"] } },\n  "instructions": ["CONVENTIONS.md"]\n}\n`);
    write(root, ".opencode/agents/review.md", "---\nname: review\n---\nReview the diff.\n");
    const opencode = await simulateEffectiveContext({ agent: "opencode", cwd: root, includeGlobal: false, subagent: "review" });
    expect(opencode.prompt.some((entry) => entry.source === "AGENTS.md")).toBe(true);
    expect(opencode.capabilities.some((cap) => cap.kind === "mcp" && cap.name === "browser")).toBe(true);
    expect(opencode.prompt.some((entry) => entry.kind === "subagent-instruction")).toBe(true);

    write(root, ".roo/rules/shared.md", "Shared Roo rules.\n");
    write(root, ".roo/rules-code/mode.md", "Code mode only.\n");
    const roo = await simulateEffectiveContext({ agent: "roo", cwd: root, includeGlobal: false, subagent: "code" });
    expect(roo.prompt.some((entry) => entry.source.endsWith(".roo/rules/shared.md"))).toBe(true);
    expect(roo.prompt.some((entry) => entry.source.includes("rules-code"))).toBe(true);
  });
});
