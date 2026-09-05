import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import { Finding, Fix } from "../../core/types.js";
import { ContextFile } from "./duplicateDetector.js";
import { estimateTokens } from "./tokenCounter.js";
import { createFix } from "../../core/fix/fixEngine.js";

export interface RepoMetadata {
  hasPnpmLock: boolean;
  hasYarnLock: boolean;
  hasNpmLock: boolean;
  hasBunLock: boolean;
  packageManagerField?: string;
  hasTsConfig: boolean;
  dependencies: string[];
}

export function extractRepoMetadata(repoRoot: string): RepoMetadata {
  const manifestFiles = fg.sync(
    [
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/package-lock.json",
      "**/bun.lockb",
      "**/bun.lock",
      "**/tsconfig.json",
      "**/package.json",
    ],
    {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/target/**"],
    }
  );
  const hasPnpmLock = manifestFiles.some((file) => path.basename(file) === "pnpm-lock.yaml");
  const hasYarnLock = manifestFiles.some((file) => path.basename(file) === "yarn.lock");
  const hasNpmLock = manifestFiles.some((file) => path.basename(file) === "package-lock.json");
  const hasBunLock = manifestFiles.some((file) => ["bun.lockb", "bun.lock"].includes(path.basename(file)));
  const hasTsConfig = manifestFiles.some((file) => path.basename(file) === "tsconfig.json");

  let packageManagerField: string | undefined;
  const dependencies: string[] = [];

  for (const relativePath of manifestFiles.filter((file) => path.basename(file) === "package.json").sort()) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf-8"));
      packageManagerField ||= pkg.packageManager;
      if (pkg.dependencies) dependencies.push(...Object.keys(pkg.dependencies));
      if (pkg.devDependencies) dependencies.push(...Object.keys(pkg.devDependencies));
    } catch {
      // ignore
    }
  }

  return {
    hasPnpmLock,
    hasYarnLock,
    hasNpmLock,
    hasBunLock,
    packageManagerField,
    hasTsConfig,
    dependencies: [...new Set(dependencies)].sort(),
  };
}

export function detectInferableContext(
  files: ContextFile[],
  metadata: RepoMetadata
): {
  findings: Finding[];
  inferableSnippets: string[];
  fixes: Fix[];
} {
  const findings: Finding[] = [];
  const inferableSnippets: string[] = [];
  const fixes: Fix[] = [];

  // Patterns that describe inferable information
  const inferableChecks: Array<{
    id: string;
    regex: RegExp;
    isInferable: (meta: RepoMetadata) => { inferable: boolean; evidenceSource: string };
    title: string;
    description: string;
  }> = [
    {
      id: "inferable-pnpm",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses pnpm|package manager is pnpm|use pnpm|always use pnpm)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.hasPnpmLock || !!(meta.packageManagerField && meta.packageManagerField.includes("pnpm")),
        evidenceSource: meta.hasPnpmLock ? "pnpm-lock.yaml" : "package.json packageManager",
      }),
      title: "Inferable package manager instruction (pnpm)",
      description: "Instruction explicitly states to use pnpm, which is already deterministically declared in repository lockfiles/packageManager.",
    },
    {
      id: "inferable-yarn",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses yarn|package manager is yarn|use yarn)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.hasYarnLock || !!(meta.packageManagerField && meta.packageManagerField.includes("yarn")),
        evidenceSource: meta.hasYarnLock ? "yarn.lock" : "package.json packageManager",
      }),
      title: "Inferable package manager instruction (yarn)",
      description: "Instruction explicitly states to use yarn, which is already deterministically declared in repository lockfiles.",
    },
    {
      id: "inferable-typescript",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses typescript|written in typescript)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.hasTsConfig || meta.dependencies.includes("typescript"),
        evidenceSource: meta.hasTsConfig ? "tsconfig.json" : "package.json dependencies",
      }),
      title: "Inferable language instruction (TypeScript)",
      description: "Instruction states the project uses TypeScript, which is already evident from tsconfig.json and ts files.",
    },
    {
      id: "inferable-react",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses react|frontend framework is react)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.dependencies.includes("react"),
        evidenceSource: "package.json dependencies (react)",
      }),
      title: "Inferable framework instruction (React)",
      description: "Instruction states the project uses React, which is clearly listed in package.json dependencies.",
    },
  ];

  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      for (const check of inferableChecks) {
        if (check.regex.test(trimmed)) {
          const { inferable, evidenceSource } = check.isInferable(metadata);
          if (inferable) {
            inferableSnippets.push(line);
            const tokens = estimateTokens(line);

            const oldLineWithNewline = line + "\n";
            const oldText = f.content.includes(oldLineWithNewline) ? oldLineWithNewline : line;

            const fix = createFix({
              id: `fix-inferable-${f.relativePath}-${idx + 1}`,
              title: `Remove inferable instruction in ${f.relativePath}`,
              description: `Removes redundant instruction "${trimmed}" which is already declared by ${evidenceSource}.`,
              isSafe: true,
              file: f.absolutePath,
              oldText,
              newText: "",
              fullOldContent: f.content,
            });

            fixes.push(fix);

            findings.push({
              id: `context-${check.id}-${f.relativePath}-${idx + 1}`,
              ruleId: "context/inferable-context",
              category: "context",
              severity: "low",
              confidence: 0.95,
              title: check.title,
              description: check.description,
              evidence: [
                {
                  file: f.relativePath,
                  line: idx + 1,
                  snippet: trimmed,
                  source: f.relativePath,
                },
                {
                  file: evidenceSource,
                  snippet: `Declared in ${evidenceSource}`,
                  source: evidenceSource,
                },
              ],
              impact: {
                tokens,
              },
              recommendation: "Remove from global context to conserve context window tokens for high-value instructions.",
              fix,
            });
          }
        }
      }
    });
  }

  return { findings, inferableSnippets, fixes };
}
