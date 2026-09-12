import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateAgentsMarkdown } from "../../src/core/fix/agentsMarkdown.js";
import { AGENT_SHIM_SPECS } from "../../src/core/fix/shims.js";
import { detectDuplicates } from "../../src/analyzers/context/duplicateDetector.js";
import { runFixLoop } from "../../src/core/fix/loop.js";
import { createFixPullRequest, ProcessRunner } from "../../src/core/fix/pullRequest.js";
import { detectProjectProfile } from "../../src/core/project/profile.js";

function write(root: string, rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("fix loop generators and verification rollback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-fix-loop-"));
    write(tmpDir, "package.json", JSON.stringify({
      name: "loop-fixture",
      scripts: { test: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(0)\"", typecheck: "node -e \"process.exit(0)\"" },
    }));
    write(tmpDir, "pnpm-lock.yaml", "");
    write(tmpDir, "src/index.ts", "export const ok = true;\n");
    write(tmpDir, "test/ok.test.ts", "export const t = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates AGENTS.md from package roots, commands, and generated dirs", () => {
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    const markdown = generateAgentsMarkdown({
      repoRoot: tmpDir,
      profile: detectProjectProfile(tmpDir),
      verificationStatus: [
        { name: "test", status: "healthy", command: "node -e \"process.exit(0)\"" },
        { name: "lint", status: "healthy", command: "node -e \"process.exit(0)\"" },
        { name: "typecheck", status: "healthy", command: "node -e \"process.exit(0)\"" },
        { name: "build", status: "not_applicable" },
        { name: "ci", status: "warning" },
      ],
    });
    expect(markdown).toContain("Package roots:");
    expect(markdown).toContain("`src`");
    expect(markdown).toContain("pnpm install");
    expect(markdown).toContain("Never manually edit generated files in `dist/`");
    expect(markdown).not.toMatch(/^use pnpm$/im);
  });

  it("keeps agent shims unique enough to avoid duplicate-instruction auto-fixes", () => {
    const files = [
      { relativePath: "AGENTS.md", absolutePath: "/tmp/AGENTS.md", content: generateAgentsMarkdown({
        repoRoot: tmpDir,
        profile: detectProjectProfile(tmpDir),
        verificationStatus: [],
      }) },
      ...AGENT_SHIM_SPECS.map((spec) => ({
        relativePath: spec.relativePath,
        absolutePath: `/tmp/${spec.relativePath}`,
        content: spec.body,
      })),
    ];
    const { findings, fixes } = detectDuplicates(files);
    expect(fixes.length).toBe(0);
    expect(findings.length).toBe(0);
  });

  it("creates AGENTS.md and shims, then rolls back when post-fix verify fails", async () => {
    const loop = await runFixLoop({
      cwd: tmpDir,
      safe: true,
      shims: true,
      verify: true,
      verifyFn: async () => ({ passed: false, failures: ["lint failed"] }),
    });
    expect(loop.applied.length).toBeGreaterThan(0);
    expect(loop.rolledBack).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
  });

  it("keeps generated files when verify passes", async () => {
    const loop = await runFixLoop({
      cwd: tmpDir,
      safe: true,
      shims: true,
      verify: true,
      verifyFn: async () => ({ passed: true, failures: [] }),
    });
    expect(loop.rolledBack).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8")).toContain("# AGENTS.md");
    expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
    expect(loop.generatedShims.some((file) => file.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("commits a local fix branch when opening a PR without a remote", () => {
    const commands: string[] = [];
    const runner: ProcessRunner = {
      run(command, args) {
        commands.push([command, ...args].join(" "));
        if (command === "git" && args[0] === "remote") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "git") {
          return { status: 0, stdout: "ok\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "gh missing" };
      },
    };

    const result = createFixPullRequest({
      repoRoot: tmpDir,
      title: "chore: apply AgentDoctor instruction fixes",
      body: "test",
      files: ["AGENTS.md"],
      runner,
      push: true,
    });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.detail).toMatch(/No git remote/i);
    expect(commands.some((line) => line.startsWith("git checkout -b agentdoctor/fix-"))).toBe(true);
    expect(commands).toContain("git add -- AGENTS.md");
  });
});
