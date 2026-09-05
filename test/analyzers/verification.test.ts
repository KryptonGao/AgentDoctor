import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeVerification } from "../../src/analyzers/verification/verificationAnalyzer.js";
import { detectProjectProfile } from "../../src/core/project/profile.js";

describe("Verification Analyzer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-verif-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects placeholder test script in package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
        },
      })
    );

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeVerification(tmpDir, profile);
    const testItem = result.verificationStatus.find((v) => v.name === "test");
    expect(testItem?.status).toBe("broken");

    const placeholderFinding = result.findings.find((f) => f.ruleId === "verification/placeholder-test");
    expect(placeholderFinding).toBeDefined();
    expect(placeholderFinding?.severity).toBe("high");
  });

  it("detects verification command mismatch with CI", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          "test:ci": "vitest run --coverage",
        },
      })
    );

    fs.mkdirSync(path.join(tmpDir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".github", "workflows", "ci.yml"),
      "jobs:\n  test:\n    steps:\n      - run: pnpm run test:ci\n"
    );

    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "To test code, run `npm test`.\n"
    );

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeVerification(tmpDir, profile);
    const mismatch = result.findings.find((f) => f.ruleId === "verification/command-consistency");
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe("high");
    expect(result.fixes.length).toBe(1);
    expect(result.fixes[0].newText).toBe("pnpm run test:ci");
  });

  it("flags missing typecheck in TypeScript projects", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
        },
      })
    );
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeVerification(tmpDir, profile);
    const missingTc = result.findings.find((f) => f.ruleId === "verification/missing-typecheck");
    expect(missingTc).toBeDefined();
  });

  it("does not invent a Node test failure for an unknown repository", async () => {
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "plain documentation\n");

    const profile = detectProjectProfile(tmpDir);
    const result = await analyzeVerification(tmpDir, profile);
    expect(result.findings).toHaveLength(0);
    expect(result.verificationStatus.find((item) => item.name === "test")?.status).toBe("not_applicable");
  });
});
