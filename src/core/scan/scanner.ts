import * as path from "node:path";
import { ScanResult, Finding, Fix, SCAN_SCHEMA_VERSION } from "../types.js";
import { getGitBranch, getGitRoot } from "../../shared/git.js";
import { detectProjectProfile } from "../project/profile.js";
import { analyzeContext } from "../../analyzers/context/contextAnalyzer.js";
import { analyzeRepository } from "../../analyzers/repository/repoAnalyzer.js";
import { analyzeVerification } from "../../analyzers/verification/verificationAnalyzer.js";
import { analyzeRuntimeSessions } from "../../analyzers/runtime/runtimeAnalyzer.js";
import { calculateEfficiencyScore } from "../score/calculator.js";
import { aggregateFindings } from "../findings/aggregator.js";
import { generateFixPrompt } from "../prompt/promptGenerator.js";

export interface ScanOptions {
  cwd?: string;
  sessionPath?: string;
  enableAi?: boolean;
  includeRuntime?: boolean;
  gitHistoryRoot?: string;
  gitRef?: string;
}

export async function scanRepository(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const repositoryName = path.basename(repoRoot);
  const branch = getGitBranch(repoRoot);
  const timestamp = new Date().toISOString();

  // 1. Detect Project Ecosystem & Profile
  const projectProfile = detectProjectProfile(repoRoot);

  // 2. Context Analyzer
  const contextResult = await analyzeContext(repoRoot, {
    gitHistoryRoot: options.gitHistoryRoot,
    gitRef: options.gitRef,
  });

  // 3. Repository Analyzer (Ecosystem aware)
  const repoResult = await analyzeRepository(repoRoot, projectProfile);

  // 4. Verification Analyzer (Ecosystem aware)
  const verifResult = await analyzeVerification(repoRoot, projectProfile);

  // 5. Runtime Analyzer
  const runtimeResult = options.includeRuntime === false
    ? { findings: [] as Finding[], sessions: [] }
    : await analyzeRuntimeSessions(repoRoot, options.sessionPath);

  // Combine raw findings
  const allFindings: Finding[] = [
    ...contextResult.findings,
    ...repoResult.findings,
    ...verifResult.findings,
    ...runtimeResult.findings,
  ];

  // Group / aggregate findings
  const aggregatedFindings = aggregateFindings(allFindings);

  // Attach fixPrompt to all findings
  for (const f of aggregatedFindings) {
    f.fixPrompt = generateFixPrompt(f);
    if (f.children) {
      for (const child of f.children) {
        child.fixPrompt = generateFixPrompt(child);
      }
    }
  }

  // Combine fixes
  const allFixes: Fix[] = [
    ...contextResult.fixes,
    ...verifResult.fixes,
  ];

  const uniqueFixes = [...new Map(allFixes.map((fix) => [fix.id, fix])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));

  const hasRuntimeData = runtimeResult.sessions.length > 0;

  // Calculate efficiency score factoring in confidence
  const { overallScore, scoreExplanation, scores } = calculateEfficiencyScore(
    aggregatedFindings,
    contextResult.signalDensity,
    hasRuntimeData,
    verifResult.verificationStatus
  );

  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    repositoryName,
    repositoryRoot: repoRoot,
    branch,
    timestamp,
    projectProfile,
    overallScore,
    scoreExplanation,
    scores,
    contextSignalDensity: contextResult.signalDensity,
    verificationStatus: verifResult.verificationStatus,
    sessions: runtimeResult.sessions,
    findings: aggregatedFindings,
    availableFixes: uniqueFixes,
    metadata: {
      schemaVersion: SCAN_SCHEMA_VERSION,
      scannedFilesCount: contextResult.scannedFiles.length + repoResult.metrics.totalFiles,
      scanDurationMs: Math.max(0, Date.now() - startedAt),
      hasRuntimeData,
      aiEnabled: options.enableAi || false,
    },
  };
}
