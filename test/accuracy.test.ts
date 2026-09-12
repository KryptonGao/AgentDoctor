import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectProjectProfile } from "../src/core/project/profile.js";
import { scanRepository } from "../src/core/scan/scanner.js";
import { classifyPathCandidate, detectStalePaths } from "../src/analyzers/context/stalePathDetector.js";
import { calculateCategoryScore } from "../src/core/score/calculator.js";
import { Finding } from "../src/core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

describe("Accuracy & Credibility P0 Fixes", () => {
  // Requirement 1: Python project with multi-package root does not get 0
  it("detects Python multi-package root without src/ and awards high readiness", async () => {
    const fixturePath = path.join(fixturesDir, "python-multipackage");
    const profile = detectProjectProfile(fixturePath);

    expect(profile.primaryEcosystem).toBe("python");
    expect(profile.packageRoots).toContain("pkg_core");
    expect(profile.packageRoots).toContain("pkg_cli");
    expect(profile.packageRoots).toContain("pkg_web");

    const scan = await scanRepository({ cwd: fixturePath });
    expect(scan.scores.repository.score).toBeGreaterThanOrEqual(70);
    expect(scan.findings.some((f) => f.ruleId === "repo/project-structure")).toBe(false);
  });

  // Requirement 2: Python project does not depend on package.json to detect test
  it("detects Python test setup from pytest/pyproject without package.json", async () => {
    const fixturePath = path.join(fixturesDir, "python-standard");
    const scan = await scanRepository({ cwd: fixturePath });

    const testItem = scan.verificationStatus.find((v) => v.name === "test");
    expect(testItem?.status).toBe("healthy");
    expect(testItem?.command).toBe("pytest");
    expect(scan.findings.some((f) => f.ruleId === "verification/missing-test")).toBe(false);
  });

  // Requirement 3: Non-TypeScript does not show typecheck healthy
  it("marks typecheck as not_applicable for non-typed project instead of healthy", async () => {
    const fixturePath = path.join(fixturesDir, "python-multipackage");
    const scan = await scanRepository({ cwd: fixturePath });

    const typecheckItem = scan.verificationStatus.find((v) => v.name === "typecheck");
    expect(typecheckItem?.status).toBe("not_applicable");
  });

  // Requirement 4: *.json is not identified as literal stale path
  it("classifies glob patterns like *.json as glob and ignores them", () => {
    expect(classifyPathCandidate("data/user/settings/*.json")).toBe("glob");
    expect(classifyPathCandidate("logs/**/*.log")).toBe("glob");
  });

  // Requirement 5: {en,zh}/<name>.yaml is not marked as stale path
  it("classifies template paths like {en,zh}/<name>.yaml as template and ignores them", () => {
    expect(classifyPathCandidate("capabilities/prompts/{en,zh}/<name>.yaml")).toBe("template");
    expect(classifyPathCandidate("<workspace>/settings.json")).toBe("template");
  });

  // Requirement 6: /ws or runtime route is not marked as stale path
  it("classifies runtime routes like /api/v1/ws as runtime_route and ignores them", () => {
    expect(classifyPathCandidate("/api/v1/ws")).toBe("runtime_route");
    expect(classifyPathCandidate("/settings/tools")).toBe("runtime_route");
    expect(classifyPathCandidate("/regenerate")).toBe("runtime_route");
  });

  // Requirements 4, 5, 6 verified through detectStalePaths
  it("does not report stale path findings for globs, templates, and runtime routes in instructions", () => {
    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: "/tmp/AGENTS.md",
        content: `
          Settings are in \`data/user/settings/*.json\`.
          Prompts are in \`capabilities/prompts/{en,zh}/<name>.yaml\`.
          API endpoint connects to \`/api/v1/ws\`.
          Retry at \`/retry\`.
        `,
      },
    ];

    const result = detectStalePaths(files, "/tmp");
    expect(result.findings.length).toBe(0);
  });

  // Requirement 7: Git deleted real paths are identified as stale with git evidence
  describe("Git-verified stale paths", () => {
    let gitTmpDir: string;

    beforeEach(() => {
      gitTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-git-stale-"));
      execSync("git init", { cwd: gitTmpDir });
      execSync('git config user.email "test@example.com"', { cwd: gitTmpDir });
      execSync('git config user.name "Test"', { cwd: gitTmpDir });

      // Create a file, commit it, then delete it
      fs.mkdirSync(path.join(gitTmpDir, "src", "legacy"), { recursive: true });
      fs.writeFileSync(path.join(gitTmpDir, "src", "legacy", "old_auth.ts"), "export const auth = 1;");
      execSync("git add . && git commit -m 'add old auth'", { cwd: gitTmpDir });

      // Delete the file and commit deletion
      fs.rmSync(path.join(gitTmpDir, "src", "legacy", "old_auth.ts"));
      execSync("git add . && git commit -m 'remove old auth'", { cwd: gitTmpDir });
    });

    afterEach(() => {
      fs.rmSync(gitTmpDir, { recursive: true, force: true });
    });

    it("verifies git history for deleted file and marks as HIGH stale with high confidence", () => {
      const files = [
        {
          relativePath: "AGENTS.md",
          absolutePath: path.join(gitTmpDir, "AGENTS.md"),
          content: "Auth logic is in `src/legacy/old_auth.ts`.\n",
        },
      ];

      const result = detectStalePaths(files, gitTmpDir);
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].severity).toBe("high");
      expect(result.findings[0].confidence).toBe(0.95);
      expect(result.findings[0].evidence.some((e) => e.source === "git log")).toBe(true);
    });
  });

  // Requirement 8: Multiple large file findings are aggregated
  it("aggregates multiple large file findings into one grouped finding", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-agg-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    fs.writeFileSync(path.join(tmp, "src", "a.ts"), "// line\n".repeat(1600));
    fs.writeFileSync(path.join(tmp, "src", "b.ts"), "// line\n".repeat(1700));
    fs.writeFileSync(path.join(tmp, "src", "c.ts"), "// line\n".repeat(1800));

    const scan = await scanRepository({ cwd: tmp });
    const largeGroup = scan.findings.filter((f) => f.ruleId === "repo/oversized-source-files");

    // Must be aggregated into 1 grouped finding
    expect(largeGroup.length).toBe(1);
    expect(largeGroup[0].title).toContain("3 oversized source files");
    expect(largeGroup[0].children?.length).toBe(3);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Requirement 9: Missing runtime data still calculates partial overall score
  it("calculates partial overall score with explanatory notice when runtime data is absent", async () => {
    const fixturePath = path.join(fixturesDir, "node-standard");
    const scan = await scanRepository({ cwd: fixturePath });

    expect(scan.metadata.hasRuntimeData).toBe(false);
    expect(scan.overallScore).toBeGreaterThan(0);
    expect(scan.scoreExplanation).toContain("Based on 4 of 5 dimensions");
  });

  // Requirement 10: Low confidence findings have lower impact on score than high confidence
  it("deducts fewer points for low confidence findings than high confidence findings", () => {
    const highFinding: Finding = {
      id: "f1",
      ruleId: "test-rule",
      category: "repository",
      severity: "high", // base deduction = 12
      confidence: 0.95,
      title: "High Conf",
      description: "",
      evidence: [],
    };

    const lowFinding: Finding = {
      id: "f2",
      ruleId: "test-rule",
      category: "repository",
      severity: "high", // base deduction = 12
      confidence: 0.40,
      title: "Low Conf",
      description: "",
      evidence: [],
    };

    const scoreHigh = calculateCategoryScore("repository", [highFinding]);
    const scoreLow = calculateCategoryScore("repository", [lowFinding]);

    // High confidence deducts ~11.4 pts -> 89
    // Low confidence deducts ~4.8 pts -> 95
    expect(scoreLow).toBeGreaterThan(scoreHigh);
  });

  // Multi-ecosystem detection
  it("identifies mixed ecosystem projects accurately", () => {
    const fixturePath = path.join(fixturesDir, "mixed-ecosystem");
    const profile = detectProjectProfile(fixturePath);

    expect(profile.ecosystems).toContain("python");
    expect(profile.ecosystems).toContain("node");
    expect(profile.primaryEcosystem).toBe("python");
    expect(profile.summary).toContain("Multi-ecosystem");
  });

  // Rust ecosystem detection
  it("identifies Rust project and Cargo verification tools", async () => {
    const fixturePath = path.join(fixturesDir, "rust-standard");
    const scan = await scanRepository({ cwd: fixturePath });

    expect(scan.projectProfile.primaryEcosystem).toBe("rust");
    const testItem = scan.verificationStatus.find((v) => v.name === "test");
    expect(testItem?.status).toBe("healthy");
    expect(testItem?.command).toBe("cargo test");
  });

  // Go ecosystem detection
  it("identifies Go project and Go verification tools", async () => {
    const fixturePath = path.join(fixturesDir, "go-standard");
    const scan = await scanRepository({ cwd: fixturePath });

    expect(scan.projectProfile.primaryEcosystem).toBe("go");
    const testItem = scan.verificationStatus.find((v) => v.name === "test");
    expect(testItem?.status).toBe("healthy");
    expect(testItem?.command).toBe("go test ./...");
  });
});
