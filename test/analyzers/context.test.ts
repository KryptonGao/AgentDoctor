import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectDuplicates } from "../../src/analyzers/context/duplicateDetector.js";
import { detectInferableContext } from "../../src/analyzers/context/inferableDetector.js";
import { detectStalePaths } from "../../src/analyzers/context/stalePathDetector.js";
import { detectVersionConflicts } from "../../src/analyzers/context/versionConflict.js";
import { estimateTokens, calculateSignalDensity } from "../../src/analyzers/context/tokenCounter.js";
import { analyzeContext, findContextFiles } from "../../src/analyzers/context/contextAnalyzer.js";

describe("Context Analyzer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-ctx-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calculates accurate token counts and signal density", () => {
    const text = "This is a clean and concise instruction for coding agents.";
    const count = estimateTokens(text);
    expect(count).toBeGreaterThan(5);

    const density = calculateSignalDensity({
      totalContent: "Useful rule 1\nDuplicate rule\nInferable rule",
      duplicateSnippets: ["Duplicate rule"],
      inferableSnippets: ["Inferable rule"],
      staleSnippets: [],
      lowValueSnippets: [],
    });

    expect(density.totalTokens).toBeGreaterThan(0);
    expect(density.densityPercent).toBeLessThan(100);
    expect(density.densityPercent).toBeGreaterThan(0);
  });

  it("detects exact and similar duplicate instructions across files", () => {
    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: path.join(tmpDir, "AGENTS.md"),
        content: "- Always run tests before creating a pull request.\n- Use pnpm package manager.\n",
      },
      {
        relativePath: "CLAUDE.md",
        absolutePath: path.join(tmpDir, "CLAUDE.md"),
        content: "- Always run tests before creating a pull request.\n",
      },
    ];

    const result = detectDuplicates(files);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].ruleId).toBe("context/duplicate-instruction");
    expect(result.findings[0].evidence.length).toBe(2);
    expect(result.fixes.length).toBe(1);
  });

  it("does not report repeated lines inside one context file as duplicate context", () => {
    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: path.join(tmpDir, "AGENTS.md"),
        content: "- Always run the focused test before creating a pull request.\n- Always run the focused test before creating a pull request.\n",
      },
    ];

    expect(detectDuplicates(files).findings).toHaveLength(0);
  });

  it("counts an overlapping wasteful line once", () => {
    const density = calculateSignalDensity({
      totalContent: "Use the repository test command.\n",
      duplicateSnippets: ["Use the repository test command."],
      inferableSnippets: ["Use the repository test command."],
      staleSnippets: [],
      lowValueSnippets: [],
      wastefulSnippets: [
        { key: "AGENTS.md:1", text: "Use the repository test command." },
        { key: "AGENTS.md:1", text: "Use the repository test command." },
      ],
    });

    expect(density.wastefulTokens).toBe(estimateTokens("Use the repository test command."));
  });

  it("detects inferable instructions when metadata defines it", () => {
    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: path.join(tmpDir, "AGENTS.md"),
        content: "This project uses pnpm.\nThis project uses TypeScript.\n",
      },
    ];

    const metadata = {
      hasPnpmLock: true,
      hasYarnLock: false,
      hasNpmLock: false,
      hasBunLock: false,
      hasTsConfig: true,
      dependencies: ["typescript"],
    };

    const result = detectInferableContext(files, metadata);
    expect(result.findings.length).toBe(2);
    expect(result.findings.some((f) => f.id.includes("pnpm"))).toBe(true);
    expect(result.findings.some((f) => f.id.includes("typescript"))).toBe(true);
    expect(result.fixes.length).toBe(2);
  });

  it("detects unresolved path and suggests existing replacement", () => {
    // Create apps/web directory
    fs.mkdirSync(path.join(tmpDir, "apps", "web"), { recursive: true });

    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: path.join(tmpDir, "AGENTS.md"),
        content: "Frontend code is located in `packages/web` directory.\n",
      },
    ];

    const result = detectStalePaths(files, tmpDir);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].severity).toBe("low");
    expect(result.findings[0].description).toContain("apps/web");
    expect(result.fixes.length).toBe(1);
    expect(result.fixes[0].newText).toBe("apps/web");
  });

  it("ignores URLs, commands, anchors, and conceptual paths", () => {
    fs.writeFileSync(path.join(tmpDir, "src.ts"), "export {};");
    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: path.join(tmpDir, "AGENTS.md"),
        content: [
          "Read `https://example.com/docs/src/old.ts`.",
          "Run `python scripts/build.py` and `npm test`.",
          "Use `Web/API` and `async/await` terminology.",
          "See `src.ts#L1` for the entry point.",
          "Track issue `owner/repo#123`.",
          "The generated toolchain file is `missing.toml`.",
          "The compiled bundle is `packages/app/dist/index.js`.",
        ].join("\n"),
      },
    ];

    expect(detectStalePaths(files, tmpDir).findings).toHaveLength(0);
  });

  it("detects Node.js version conflicts between instructions and package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } })
    );

    const files = [
      {
        relativePath: "AGENTS.md",
        absolutePath: path.join(tmpDir, "AGENTS.md"),
        content: "Requires Node 20.\n",
      },
    ];

    const result = detectVersionConflicts(files, tmpDir);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].ruleId).toBe("context/conflicting-instructions");
    expect(result.findings[0].severity).toBe("high");
    expect(result.fixes.length).toBe(1);
  });

  it("detects low-value instructions and flags them", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "Write clean code.\nFollow best practices.\nBe careful.\n"
    );

    const result = await analyzeContext(tmpDir);
    const lowValue = result.findings.filter((f) => f.ruleId === "context/low-value-instructions");
    expect(lowValue.length).toBe(3);
    expect(result.signalDensity.lowValueTokens).toBeGreaterThan(0);
  });

  it("discovers nested agent instructions without scanning dependency directories", async () => {
    fs.mkdirSync(path.join(tmpDir, "packages", "api"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "packages", "api", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "packages", "api", "AGENTS.md"), "Write clean code.\n");
    fs.writeFileSync(path.join(tmpDir, "packages", "api", "node_modules", "AGENTS.md"), "Write clean code.\n");

    const result = await analyzeContext(tmpDir);
    expect(result.scannedFiles).toEqual(["packages/api/AGENTS.md"]);
    expect(result.findings[0].evidence[0].file).toBe("packages/api/AGENTS.md");
  });

  it("discovers Cursor and Copilot instructions while excluding generated trees", async () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "rules"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "generated"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".cursor", "rules", "repo.mdc"), "Use the source tree.\n");
    fs.writeFileSync(path.join(tmpDir, ".github", "copilot-instructions.md"), "Run the focused tests.\n");
    fs.writeFileSync(path.join(tmpDir, "generated", "AGENTS.md"), "Write clean code.\n");

    expect((await findContextFiles(tmpDir)).map((file) => file.relativePath)).toEqual([
      ".cursor/rules/repo.mdc",
      ".github/copilot-instructions.md",
    ]);
  });
});
