import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import { Finding, Fix, ContextSignalDensity } from "../../core/types.js";
import { ContextFile, detectDuplicates } from "./duplicateDetector.js";
import { extractRepoMetadata, detectInferableContext } from "./inferableDetector.js";
import { detectStalePaths } from "./stalePathDetector.js";
import { detectVersionConflicts } from "./versionConflict.js";
import { estimateTokens, calculateSignalDensity } from "./tokenCounter.js";

const LOW_VALUE_PATTERNS = [
  /^(?:[\s*\-#\d.)>]*)(?:write clean (?:and maintainable )?code|always write clean code)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:follow best practices|adhere to standard conventions)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:be careful(?:\s+and avoid bugs)?|ensure no bugs are introduced)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:think (?:step by step|carefully before editing))[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:do your best|be helpful and thorough)[\s.!]*$/i,
];

const CONTEXT_PATTERNS = [
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.cursorrules",
  "**/.cursor/rules/**/*.mdc",
  "**/.cursor/rules/**/*.md",
  ".cursor/rules/**/*.mdc",
  ".cursor/rules/**/*.md",
  "**/.github/copilot-instructions.md",
  ".claude/skills/**/*.md",
];

export async function findContextFiles(repoRoot: string): Promise<ContextFile[]> {
  const relativePaths = await fg(CONTEXT_PATTERNS, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/out/**",
      "**/coverage/**",
      "**/generated/**",
      "**/vendor/**",
      "**/.next/**",
      "**/.venv/**",
      "**/venv/**",
    ],
  });

  const files: ContextFile[] = [];
  for (const rel of relativePaths) {
    const abs = path.join(repoRoot, rel);
    try {
      if (fs.existsSync(abs)) {
        const content = fs.readFileSync(abs, "utf-8");
        files.push({
          relativePath: rel,
          absolutePath: abs,
          content,
        });
      }
    } catch {
      // ignore
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function collectWastefulSnippetEntries(
  findings: Finding[],
  seedEntries: Array<{ key: string; text: string }> = []
): Array<{ key: string; text: string }> {
  const entries = new Map<string, { key: string; text: string }>();
  for (const entry of seedEntries) {
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }

  for (const finding of findings) {
    if (finding.category !== "context") continue;
    // Duplicate detector entries include every redundant occurrence. They are
    // seeded above so the compact evidence shown in the report does not lose
    // the full token accounting.
    if (finding.ruleId === "context/duplicate-instruction") continue;

    const evidence = finding.evidence.slice(0, 1);

    for (const item of evidence) {
      if (!item.snippet) continue;
      const key = `${item.file}:${item.line ?? "file"}`;
      if (!entries.has(key)) {
        entries.set(key, { key, text: item.snippet });
      }
    }
  }

  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface ContextAnalyzeOptions {
  gitHistoryRoot?: string;
  gitRef?: string;
}

export async function analyzeContext(
  repoRoot: string,
  options: ContextAnalyzeOptions = {}
): Promise<{
  findings: Finding[];
  fixes: Fix[];
  signalDensity: ContextSignalDensity;
  scannedFiles: string[];
}> {
  const contextFiles = await findContextFiles(repoRoot);
  const metadata = extractRepoMetadata(repoRoot);

  const findings: Finding[] = [];
  const fixes: Fix[] = [];

  const duplicateSnippets: string[] = [];
  const duplicateWastefulEntries: Array<{ key: string; text: string }> = [];
  const inferableSnippets: string[] = [];
  const staleSnippets: string[] = [];
  const lowValueSnippets: string[] = [];

  // 1. Detect duplicates
  const dupResult = detectDuplicates(contextFiles);
  findings.push(...dupResult.findings);
  fixes.push(...dupResult.fixes);
  duplicateSnippets.push(...dupResult.duplicateSnippets);
  duplicateWastefulEntries.push(...dupResult.duplicateEntries);

  // 2. Detect inferable instructions
  const inferResult = detectInferableContext(contextFiles, metadata);
  findings.push(...inferResult.findings);
  fixes.push(...inferResult.fixes);
  inferableSnippets.push(...inferResult.inferableSnippets);

  // 3. Detect stale paths
  const staleResult = detectStalePaths(
    contextFiles,
    repoRoot,
    {
      gitHistoryRoot: options.gitHistoryRoot,
      gitRef: options.gitRef,
    }
  );
  findings.push(...staleResult.findings);
  fixes.push(...staleResult.fixes);
  staleSnippets.push(...staleResult.staleSnippets);

  // 4. Detect version conflicts
  const conflictResult = detectVersionConflicts(contextFiles, repoRoot);
  findings.push(...conflictResult.findings);
  fixes.push(...conflictResult.fixes);
  // conflicts also count into wasteful/stale
  staleSnippets.push(...conflictResult.conflictSnippets);

  // 5. Detect low-value generic fluff instructions
  for (const f of contextFiles) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      for (const pat of LOW_VALUE_PATTERNS) {
        if (pat.test(trimmed)) {
          lowValueSnippets.push(line);
          findings.push({
            id: `context-low-value-${f.relativePath}-${idx + 1}`,
            ruleId: "context/low-value-instructions",
            category: "context",
            severity: "low",
            confidence: 0.85,
            title: "Low-value instruction detected",
            description: `"${trimmed}" is a non-actionable generic platitude that adds no repository-specific guidance and wastes prompt tokens.`,
            evidence: [
              {
                file: f.relativePath,
                line: idx + 1,
                snippet: trimmed,
                source: f.relativePath,
              },
            ],
            impact: {
              tokens: estimateTokens(line),
            },
            recommendation: "Remove generic instructions. Focus instructions on non-obvious architecture, testing, and tool constraints.",
          });
          break;
        }
      }
    });
  }

  // 6. Detect oversized context files (> 2,500 tokens)
  for (const f of contextFiles) {
    const tokens = estimateTokens(f.content);
    if (tokens > 2500) {
      findings.push({
        id: `context-oversized-${f.relativePath}`,
        ruleId: "context/oversized-context",
        category: "context",
        severity: "medium",
        confidence: 0.90,
        title: `Oversized instruction file: ${f.relativePath} (${tokens.toLocaleString()} tokens)`,
        description: `This file contains ${tokens.toLocaleString()} tokens. Excessive context slows down agent inference, crowds system prompts, and increases token costs per turn.`,
        evidence: [
          {
            file: f.relativePath,
            snippet: `${tokens.toLocaleString()} tokens across ${f.content.split(/\r?\n/).length} lines`,
            source: f.relativePath,
          },
        ],
        impact: {
          tokens: Math.round(tokens * 0.4),
        },
        recommendation: "Split detailed documentation into on-demand docs and keep root agent instructions concise (< 1,500 tokens).",
      });
    }
  }

  // Calculate Context Signal Density
  const combinedContent = contextFiles.map((f) => f.content).join("\n\n");
  const signalDensity = calculateSignalDensity({
    totalContent: combinedContent,
    duplicateSnippets,
    inferableSnippets,
    staleSnippets,
    lowValueSnippets,
    wastefulSnippets: collectWastefulSnippetEntries(findings, duplicateWastefulEntries),
  });

  return {
    findings,
    fixes,
    signalDensity,
    scannedFiles: contextFiles.map((f) => f.relativePath),
  };
}
