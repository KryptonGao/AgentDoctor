import * as fs from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  ScanResult,
  BaselineComparison,
  Finding,
  FindingSeverity,
} from "../core/types.js";
import { scanRepository } from "../core/scan/scanner.js";
import { findContextFiles } from "../analyzers/context/contextAnalyzer.js";
import { describeAgentFileRole } from "../analyzers/context/agentFiles.js";
import { estimateTokens } from "../analyzers/context/tokenCounter.js";
import {
  getGitRoot,
  getGitBranch,
  resolveGitRef,
  archiveGitRef,
  removeTemporaryDirectory,
} from "../shared/git.js";
import { compareScanResults } from "../core/regression/comparator.js";
import { generateAllFixPrompts } from "../core/prompt/promptGenerator.js";

export interface ContextFileItem {
  file: string;
  role: { zh: string; en: string };
  totalTokens: number;
  usefulTokens: number;
  wastefulTokens: number;
  densityPercent: number;
  issuesCount: number;
}

export interface WastefulSnippetItem {
  ruleId: string;
  severity: FindingSeverity;
  locations: string;
  wasteText: string;
  snippet: string;
}

export interface DiffLine {
  type: "hunk" | "add" | "del" | "normal";
  text: string;
}

export interface BaselineTreeInfo {
  baselineRef: string;
  baselineTokens: number;
  headTokens: number;
  deltaTokens: number;
  baselineLines: string[];
  headLines: string[];
  diffLines: DiffLine[];
}

export interface WebDataPayload {
  repositoryName: string;
  repositoryRoot: string;
  branch: string;
  timestamp: string;
  scanResult: ScanResult;
  baselineResult: ScanResult | null;
  baselineComparison: BaselineComparison | null;
  baselineTreeInfo: BaselineTreeInfo | null;
  contextFiles: ContextFileItem[];
  wastefulSnippets: WastefulSnippetItem[];
  batchFixPrompt: string;
}

export interface BuildWebPayloadOptions {
  cwd?: string;
  baseline?: string;
  sessionPath?: string;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
}

export function parseUnifiedDiffLines(diffText: string): DiffLine[] {
  if (!diffText) return [];
  const lines = diffText.split(/\r?\n/);
  const result: DiffLine[] = [];

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("Index: ") || line.startsWith("===")) {
      continue;
    }
    if (line.startsWith("@@")) {
      result.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", text: line });
    } else if (line.startsWith("-")) {
      result.push({ type: "del", text: line });
    } else if (line.trim().length > 0 || result.length > 0) {
      result.push({ type: "normal", text: line });
    }
  }

  return result;
}

function getRoleForFile(relativePath: string): { zh: string; en: string } {
  return describeAgentFileRole(relativePath);
}

export async function buildWebPayload(options: BuildWebPayloadOptions = {}): Promise<WebDataPayload> {
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const branch = getGitBranch(repoRoot);
  const repoName = path.basename(repoRoot);

  // 1. Scan current repository
  const scanResult = await scanRepository({
    cwd: repoRoot,
    sessionPath: options.sessionPath,
    includeRuntime: true,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
  });

  // Attach diff lines to findings with fixes
  for (const f of scanResult.findings) {
    if (f.fix?.diff) {
      (f as any).diffLines = parseUnifiedDiffLines(f.fix.diff);
    }
  }

  // 2. Discover context files & compute per-file stats
  const rawContextFiles = await findContextFiles(repoRoot);
  const contextFiles: ContextFileItem[] = [];

  for (const cf of rawContextFiles) {
    const totalTokens = estimateTokens(cf.content);
    const relatedFindings = scanResult.findings.filter(
      (f) =>
        f.category === "context" &&
        f.evidence.some(
          (e) => e.file === cf.relativePath || cf.relativePath.endsWith(path.basename(e.file))
        )
    );
    const issuesCount = relatedFindings.length;
    let wastefulTokens = 0;
    for (const rf of relatedFindings) {
      if (rf.impact?.tokens) {
        wastefulTokens += rf.impact.tokens;
      }
    }
    wastefulTokens = Math.min(totalTokens, wastefulTokens);
    const usefulTokens = Math.max(0, totalTokens - wastefulTokens);
    const densityPercent = totalTokens > 0
      ? Math.round((usefulTokens / totalTokens) * 1000) / 10
      : 100;

    contextFiles.push({
      file: cf.relativePath,
      role: getRoleForFile(cf.relativePath),
      totalTokens,
      usefulTokens,
      wastefulTokens,
      densityPercent,
      issuesCount,
    });
  }

  // 3. Collect concrete wasteful snippets from context findings
  const wastefulSnippets: WastefulSnippetItem[] = [];
  for (const f of scanResult.findings) {
    if (f.category !== "context") continue;
    const firstEv = f.evidence[0];
    if (!firstEv) continue;

    const locs = f.evidence
      .map((e) => `${e.file}${e.line ? `:${e.line}` : ""}`)
      .join(" vs ");

    const wasteText = f.impact?.tokens
      ? `${f.impact.tokens.toLocaleString()} tokens/会话`
      : "引发额外检索或重试";

    wastefulSnippets.push({
      ruleId: f.ruleId,
      severity: f.severity,
      locations: locs,
      wasteText,
      snippet: firstEv.snippet || f.description,
    });
  }

  // 4. Baseline regression comparison
  let baselineResult: ScanResult | null = null;
  let baselineComparison: BaselineComparison | null = null;
  let baselineTreeInfo: BaselineTreeInfo | null = null;

  const baselineRefCandidate = options.baseline?.trim() || undefined;
  const resolvedRef = baselineRefCandidate
    ? resolveGitRef(repoRoot, baselineRefCandidate)
    : null;

  if (resolvedRef && baselineRefCandidate) {
    let baselineTree: string | undefined;
    try {
      baselineTree = archiveGitRef(repoRoot, resolvedRef);
      baselineResult = await scanRepository({
        cwd: baselineTree,
        includeRuntime: false,
        gitHistoryRoot: repoRoot,
        gitRef: resolvedRef,
      });

      baselineComparison = compareScanResults(baselineResult, scanResult, baselineRefCandidate);

      // Compare primary instruction file (AGENTS.md)
      const baseAgentsPath = path.join(baselineTree, "AGENTS.md");
      const headAgentsPath = path.join(repoRoot, "AGENTS.md");

      if (fs.existsSync(baseAgentsPath) && fs.existsSync(headAgentsPath)) {
        const baseContent = fs.readFileSync(baseAgentsPath, "utf-8");
        const headContent = fs.readFileSync(headAgentsPath, "utf-8");
        const baseTokens = estimateTokens(baseContent);
        const headTokens = estimateTokens(headContent);
        const patch = createTwoFilesPatch(
          `a/AGENTS.md`,
          `b/AGENTS.md`,
          baseContent,
          headContent,
          "",
          "",
          { context: 3 }
        );

        baselineTreeInfo = {
          baselineRef: baselineRefCandidate,
          baselineTokens: baseTokens,
          headTokens,
          deltaTokens: headTokens - baseTokens,
          baselineLines: baseContent.split(/\r?\n/).slice(0, 30),
          headLines: headContent.split(/\r?\n/).slice(0, 30),
          diffLines: parseUnifiedDiffLines(patch),
        };
      }
    } catch {
      // Ignore baseline archive failure
    } finally {
      if (baselineTree) removeTemporaryDirectory(baselineTree);
    }
  }

  // If no baseline comparison was performed, create a default baselineTreeInfo from current AGENTS.md if present
  if (!baselineTreeInfo) {
    const headAgentsPath = path.join(repoRoot, "AGENTS.md");
    if (fs.existsSync(headAgentsPath)) {
      const headContent = fs.readFileSync(headAgentsPath, "utf-8");
      const headTokens = estimateTokens(headContent);
      baselineTreeInfo = {
        baselineRef: "baseline (not configured)",
        baselineTokens: headTokens,
        headTokens,
        deltaTokens: 0,
        baselineLines: headContent.split(/\r?\n/).slice(0, 30),
        headLines: headContent.split(/\r?\n/).slice(0, 30),
        diffLines: [],
      };
    }
  }

  // 5. Generate all fix prompts for batch copy
  const batchFixPrompt = generateAllFixPrompts(scanResult.findings);

  return {
    repositoryName: repoName,
    repositoryRoot: repoRoot,
    branch,
    timestamp: scanResult.timestamp,
    scanResult,
    baselineResult,
    baselineComparison,
    baselineTreeInfo,
    contextFiles,
    wastefulSnippets,
    batchFixPrompt,
  };
}
