import * as path from "node:path";
import { Finding, Evidence, Fix } from "../../core/types.js";
import { estimateTokens } from "./tokenCounter.js";
import { createFix } from "../../core/fix/fixEngine.js";

export interface ContextFile {
  relativePath: string;
  absolutePath: string;
  content: string;
}

function normalizeSentence(str: string): string {
  return str
    .toLowerCase()
    .replace(/^[\s*\-#\d.)>]+/, "") // remove bullets, numbering, markdown headers
    .replace(/[^\w\s]/g, "")
    .trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function isActionableInstruction(text: string): boolean {
  return /\b(?:always|never|must|should|do not|don't|run|use|avoid|edit|write|test|install|commit|verify|check|keep|prefer)\b/i.test(text);
}

export function detectDuplicates(files: ContextFile[]): {
  findings: Finding[];
  duplicateSnippets: string[];
  duplicateEntries: Array<{ key: string; text: string }>;
  fixes: Fix[];
} {
  const findings: Finding[] = [];
  const duplicateSnippets: string[] = [];
  const duplicateEntries: Array<{ key: string; text: string }> = [];
  const duplicateOccurrenceKeys = new Set<string>();
  const fixes: Fix[] = [];

  // Parse lines from all files
  interface LineItem {
    file: ContextFile;
    lineNumber: number;
    rawLine: string;
    normalized: string;
  }

  const allLines: LineItem[] = [];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      // Skip empty lines, short lines, or pure markdown headers
      if (trimmed.length > 12 && !trimmed.startsWith("```") && !/^#{1,6}\s/.test(trimmed)) {
        const norm = normalizeSentence(trimmed);
        if (norm.length > 10) {
          allLines.push({
            file: f,
            lineNumber: idx + 1,
            rawLine: line,
            normalized: norm,
          });
        }
      }
    });
  }

  // Compare context files only. Repeated words inside one document are often
  // deliberate examples or headings; reporting them as duplicate context is
  // noisy and does not describe a retrieval problem.
  const pairMatches = new Map<string, { left: ContextFile; right: ContextFile; matches: Array<{ left: LineItem; right: LineItem }> }>();
  const fileGroups = new Map<string, LineItem[]>();
  for (const item of allLines) {
    const group = fileGroups.get(item.file.relativePath) || [];
    group.push(item);
    fileGroups.set(item.file.relativePath, group);
  }

  const contextFiles = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (let leftIndex = 0; leftIndex < contextFiles.length; leftIndex++) {
    const leftFile = contextFiles[leftIndex];
    const leftLines = fileGroups.get(leftFile.relativePath) || [];
    for (let rightIndex = leftIndex + 1; rightIndex < contextFiles.length; rightIndex++) {
      const rightFile = contextFiles[rightIndex];
      const rightLines = fileGroups.get(rightFile.relativePath) || [];
      const matches: Array<{ left: LineItem; right: LineItem }> = [];
      const seenPairs = new Set<string>();

      for (const left of leftLines) {
        for (const right of rightLines) {
          const exact = left.normalized === right.normalized;
          const similar = !exact && jaccardSimilarity(left.normalized, right.normalized) >= 0.8;
          if (!exact && !similar) continue;

          const pairId = `${left.lineNumber}:${right.lineNumber}`;
          if (seenPairs.has(pairId)) continue;
          seenPairs.add(pairId);
          matches.push({ left, right });
        }
      }

      if (matches.length > 0) {
        pairMatches.set(`${leftFile.relativePath}\u0000${rightFile.relativePath}`, {
          left: leftFile,
          right: rightFile,
          matches: matches.sort((a, b) => a.left.lineNumber - b.left.lineNumber || a.right.lineNumber - b.right.lineNumber),
        });
      }
    }
  }

  for (const [, pair] of [...pairMatches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const representativeMatches = pair.matches.slice(0, 6);
    const evidence: Evidence[] = representativeMatches.flatMap(({ left, right }) => [left, right]).map((occ) => ({
      file: occ.file.relativePath,
      line: occ.lineNumber,
      snippet: occ.rawLine.trim(),
      source: occ.file.relativePath,
    }));

    const redundantOccurrences = pair.matches.map(({ right }) => right);
    const redundantTokens = redundantOccurrences.reduce(
      (sum, occurrence) => sum + estimateTokens(occurrence.rawLine),
      0
    );
    // Short one-off phrases such as "and/or" or a section label are not
    // useful evidence of duplicated agent context. Keep a single-line match
    // only when it carries enough instruction content to be actionable.
    if (pair.matches.length === 1 && redundantTokens < 8 && !isActionableInstruction(pair.matches[0].right.normalized)) continue;
    redundantOccurrences.forEach((occurrence) => {
      const key = `${occurrence.file.relativePath}:${occurrence.lineNumber}`;
      if (duplicateOccurrenceKeys.has(key)) return;
      duplicateOccurrenceKeys.add(key);
      duplicateSnippets.push(occurrence.rawLine);
      duplicateEntries.push({ key, text: occurrence.rawLine });
    });

    // Keep the one-line safe fix users already expect for a small duplicate.
    // Large duplicated blocks need a human decision about which file is the
    // source of truth, so they remain report-only.
    let fix: Fix | undefined;
    if (pair.matches.length === 1) {
      const secondary = pair.matches[0].right;
      const primary = pair.matches[0].left;
      const oldLineWithNewline = secondary.rawLine + "\n";
      const oldText = secondary.file.content.includes(oldLineWithNewline)
        ? oldLineWithNewline
        : secondary.rawLine;

      fix = createFix({
        id: `fix-dup-${secondary.file.relativePath}-${secondary.lineNumber}`,
        title: `Remove duplicate instruction in ${secondary.file.relativePath}`,
        description: `Removes duplicate rule already documented in ${primary.file.relativePath}:${primary.lineNumber}`,
        isSafe: true,
        file: secondary.file.absolutePath,
        oldText,
        newText: "",
        fullOldContent: secondary.file.content,
      });
      fixes.push(fix);
    }

    findings.push({
      id: `context-dup-${pair.left.relativePath}-${pair.right.relativePath}`,
      ruleId: "context/duplicate-instruction",
      category: "context",
      severity: "medium",
      confidence: 0.90,
      title: `Duplicate instruction block across ${pair.left.relativePath} and ${pair.right.relativePath}`,
      description: `Found ${pair.matches.length} duplicate or highly similar instruction lines across two context files. This inflates agent context and risks divergent rules.`,
      evidence,
      impact: {
        tokens: redundantTokens,
      },
      recommendation: `Consolidate the repeated rules into a single primary instruction file (${pair.left.relativePath}) and remove redundant copies from ${pair.right.relativePath}.`,
      fix,
    });
  }

  return { findings, duplicateSnippets, duplicateEntries, fixes };
}
