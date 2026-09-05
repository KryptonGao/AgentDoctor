import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFix, applyFix, applySafeFixes, generateDiff } from "../../src/core/fix/fixEngine.js";

describe("Fix Engine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-fix-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates unified diff for proposed changes", () => {
    const filePath = path.join(tmpDir, "AGENTS.md");
    const oldContent = "Node version: 20\nUse pnpm\n";
    const newContent = "Node version: 22\nUse pnpm\n";
    const diff = generateDiff(filePath, oldContent, newContent);

    expect(diff).toContain("-Node version: 20");
    expect(diff).toContain("+Node version: 22");
  });

  it("applies fix cleanly to file", () => {
    const targetFile = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(targetFile, "Line 1\nAlways use pnpm.\nLine 3\n");

    const fix = createFix({
      id: "fix-1",
      title: "Remove duplicate rule",
      description: "Remove duplicate pnpm rule",
      isSafe: true,
      file: targetFile,
      oldText: "Always use pnpm.\n",
      newText: "",
    });

    const result = applyFix(fix);
    expect(result.success).toBe(true);

    const updated = fs.readFileSync(targetFile, "utf-8");
    expect(updated).toBe("Line 1\nLine 3\n");
  });

  it("applies only safe fixes when batching", () => {
    const fileA = path.join(tmpDir, "A.md");
    const fileB = path.join(tmpDir, "B.md");
    fs.writeFileSync(fileA, "Rule A\n");
    fs.writeFileSync(fileB, "Rule B\n");

    const fixSafe = createFix({
      id: "fix-safe",
      title: "Safe Fix",
      description: "Safe",
      isSafe: true,
      file: fileA,
      oldText: "Rule A\n",
      newText: "Rule A Updated\n",
    });

    const fixUnsafe = createFix({
      id: "fix-unsafe",
      title: "Unsafe Fix",
      description: "Unsafe",
      isSafe: false,
      file: fileB,
      oldText: "Rule B\n",
      newText: "Rule B Updated\n",
    });

    const { applied } = applySafeFixes([fixSafe, fixUnsafe]);
    expect(applied.length).toBe(1);
    expect(applied[0].id).toBe("fix-safe");

    expect(fs.readFileSync(fileA, "utf-8")).toBe("Rule A Updated\n");
    expect(fs.readFileSync(fileB, "utf-8")).toBe("Rule B\n"); // untouched
  });
});
