import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanRepository } from "../../src/core/scan/scanner.js";
import { applySafeFixes } from "../../src/core/fix/fixEngine.js";

describe("End-to-End Scanner and MVP Core Loop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-e2e-"));
    // Setup git repo
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "export const ok = true;\n");

    // package.json with Node 22 requirement and pnpm
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test-repo",
        version: "1.0.0",
        engines: { node: ">=22" },
        scripts: {
          test: "vitest run",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          build: "tsup",
        },
      })
    );
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");

    // Intentionally problematic AGENTS.md:
    // 1. Conflicting Node version (Node 20 vs 22)
    // 2. Duplicate line with CLAUDE.md
    // 3. Inferable instruction (This project uses pnpm)
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "# Agent Instructions\nRequires Node 20.\nThis project uses pnpm.\nNever bypass tests.\n"
    );

    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Claude Instructions\nNever bypass tests.\n"
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("completes full MVP loop: scan -> find -> fix -> rescan -> score improves", async () => {
    // 1. Initial Scan
    const initialScan = await scanRepository({ cwd: tmpDir });

    expect(initialScan.overallScore).toBeLessThan(100);
    expect(initialScan.findings.length).toBeGreaterThan(0);
    expect(initialScan.availableFixes.length).toBeGreaterThanOrEqual(3);

    // Verify findings detected: Node conflict, Inferable pnpm, Duplicate instruction
    const hasConflict = initialScan.findings.some((f) => f.ruleId === "context/conflicting-instructions");
    const hasInferable = initialScan.findings.some((f) => f.ruleId === "context/inferable-context");
    const hasDuplicate = initialScan.findings.some((f) => f.ruleId === "context/duplicate-instruction");

    expect(hasConflict).toBe(true);
    expect(hasInferable).toBe(true);
    expect(hasDuplicate).toBe(true);

    const initialScore = initialScan.overallScore;

    // 2. Apply all safe fixes
    const safeFixes = initialScan.availableFixes.filter((f) => f.isSafe);
    expect(safeFixes.length).toBeGreaterThanOrEqual(3);

    const { applied } = applySafeFixes(safeFixes);
    expect(applied.length).toBeGreaterThanOrEqual(3);

    // 3. Rescan
    const postScan = await scanRepository({ cwd: tmpDir });

    // Verify score improved!
    expect(postScan.overallScore).toBeGreaterThan(initialScore);
    expect(postScan.contextSignalDensity.densityPercent).toBeGreaterThanOrEqual(
      initialScan.contextSignalDensity.densityPercent
    );
  });
});
