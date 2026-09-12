import { describe, expect, it } from "vitest";
import { scanResultToSarif } from "../../src/core/report/sarif.js";
import { formatGitHubAnnotation, formatGitHubAnnotations } from "../../src/core/report/githubAnnotations.js";
import { ScanResult } from "../../src/core/types.js";

function makeScan(): ScanResult {
  return {
    schemaVersion: 1,
    repositoryName: "fixture",
    repositoryRoot: "/tmp/fixture",
    branch: "main",
    timestamp: "2026-01-01T00:00:00.000Z",
    projectProfile: {
      primaryEcosystem: "node",
      ecosystems: ["node"],
      languages: ["typescript"],
      packageRoots: ["."],
      workspaceRoots: [],
      isMonorepo: false,
      testRoots: [],
      entryPoints: ["src/index.ts"],
      configFiles: { node: ["package.json"] },
      confidence: 1,
    },
    overallScore: 80,
    scores: {
      context: { score: 80, weight: 0.4, findingsCount: { critical: 0, high: 1, medium: 0, low: 0 } },
      repository: { score: 80, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      verification: { score: 80, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      security: { score: 80, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      runtime: null,
    },
    contextSignalDensity: {
      totalTokens: 10,
      usefulTokens: 10,
      wastefulTokens: 0,
      duplicateTokens: 0,
      inferableTokens: 0,
      staleTokens: 0,
      lowValueTokens: 0,
      densityPercent: 100,
    },
    verificationStatus: [],
    sessions: [],
    findings: [
      {
        id: "f1",
        ruleId: "context/stale-path",
        category: "context",
        severity: "high",
        confidence: 0.9,
        title: "stale instruction",
        description: "Path src/old.ts no longer exists",
        evidence: [{ file: "AGENTS.md", line: 4, endLine: 4, snippet: "src/old.ts" }],
      },
    ],
    availableFixes: [],
    metadata: { schemaVersion: 1, scannedFilesCount: 1, scanDurationMs: 1, hasRuntimeData: false, aiEnabled: false },
  };
}

describe("SARIF and GitHub annotations", () => {
  it("emits SARIF 2.1.0 results with rule metadata and line regions", () => {
    const sarif = scanResultToSarif(makeScan(), { version: "0.2.0" });
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("AgentDoctor");
    expect(sarif.runs[0].results[0].ruleId).toBe("context/stale-path");
    expect(sarif.runs[0].results[0].level).toBe("error");
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region?.startLine).toBe(4);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("AGENTS.md");
  });

  it("formats GitHub workflow commands for inline annotations", () => {
    const scan = makeScan();
    const line = formatGitHubAnnotation(scan.findings[0], scan.repositoryRoot);
    expect(line).toContain("::error file=AGENTS.md");
    expect(line).toContain("line=4");
    expect(line).toContain("context/stale-path");
    expect(formatGitHubAnnotations(scan)).toHaveLength(1);
  });
});
