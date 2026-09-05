import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../../src/analyzers/repository/repoAnalyzer.js";
import { detectProjectProfile } from "../../src/core/project/profile.js";

describe("Repository Analyzer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-repo-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags large source files exceeding 1500 lines", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    const largeContent = "// line\n".repeat(1600);
    fs.writeFileSync(path.join(tmpDir, "src", "LargeService.ts"), largeContent);

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeRepository(tmpDir, profile);
    const largeFindings = result.findings.filter((f) => f.ruleId === "repo/oversized-source-files");
    expect(largeFindings.length).toBe(1);
    expect(largeFindings[0].title).toContain("LargeService.ts");
    expect(result.metrics.largeFiles.length).toBe(1);
  });

  it("warns when generated code exists without protection instruction", async () => {
    fs.mkdirSync(path.join(tmpDir, "generated"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "generated", "client.ts"), "export const x = 1;\n");

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeRepository(tmpDir, profile);
    const genFindings = result.findings.filter((f) => f.ruleId === "repo/generated-code-protection");
    expect(genFindings.length).toBe(1);
  });

  it("does not report generated source files as oversized hand-maintained code", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "generated.ts"),
      "// DO NOT EDIT, this is an Auto-generated file.\n" + "export const value = 1;\n".repeat(1_600)
    );

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeRepository(tmpDir, profile);
    expect(result.findings.some((finding) => finding.ruleId === "repo/oversized-source-files")).toBe(false);
  });

  it("detects missing critical workflows in package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        scripts: {
          test: "vitest run",
        },
      })
    );

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeRepository(tmpDir, profile);
    const workflowFindings = result.findings.filter((f) => f.ruleId === "repo/critical-workflow-discoverability");
    // In Node project without build/lint/typecheck, discovers workflows accurately
    expect(result.metrics.workflows.test).toBe(true);
    expect(result.metrics.workflows.typecheck).toBe(false);
  });

  it("detects nested Node workspaces and keeps profile output deterministic", () => {
    fs.mkdirSync(path.join(tmpDir, "apps", "web", "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "packages", "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })
    );
    fs.writeFileSync(path.join(tmpDir, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
    fs.writeFileSync(path.join(tmpDir, "packages", "shared", "package.json"), JSON.stringify({ name: "shared" }));
    fs.writeFileSync(path.join(tmpDir, "apps", "web", "src", "index.ts"), "export {};\n");

    const profile = detectProjectProfile(tmpDir);
    expect(profile.isMonorepo).toBe(true);
    expect(profile.workspaceRoots).toContain(".");
    expect(profile.packageRoots).toContain("apps/web");
    expect(profile.packageRoots).toContain("packages/shared");
    expect(profile.entryPoints).toContain("apps/web/src/index.ts");
  });

  it("does not infer a monorepo from Python metadata companions or go.sum", () => {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[build-system]\n");
    fs.writeFileSync(path.join(tmpDir, "setup.py"), "from setuptools import setup\n");
    let profile = detectProjectProfile(tmpDir);
    expect(profile.primaryEcosystem).toBe("python");
    expect(profile.isMonorepo).toBe(false);

    fs.rmSync(path.join(tmpDir, "pyproject.toml"));
    fs.rmSync(path.join(tmpDir, "setup.py"));
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/fixture\n\ngo 1.22\n");
    fs.writeFileSync(path.join(tmpDir, "go.sum"), "");
    profile = detectProjectProfile(tmpDir);
    expect(profile.primaryEcosystem).toBe("go");
    expect(profile.isMonorepo).toBe(false);
  });
});
