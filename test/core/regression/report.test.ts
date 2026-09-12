import { describe, expect, it } from "vitest";
import { formatAgentDoctorMarkdown, AGENTDOCTOR_REPORT_MARKER } from "../../../src/core/regression/report.js";
import { CheckResult, ScanResult } from "../../../src/core/types.js";

function makeScan(score: number): ScanResult {
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
    overallScore: score,
    scores: {
      context: { score, weight: 0.4, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      repository: { score, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      verification: { score, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      security: { score, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      runtime: null,
    },
    contextSignalDensity: {
      totalTokens: 100,
      usefulTokens: 100,
      wastefulTokens: 0,
      duplicateTokens: 0,
      inferableTokens: 0,
      staleTokens: 0,
      lowValueTokens: 0,
      densityPercent: 100,
    },
    verificationStatus: [],
    sessions: [],
    findings: [],
    availableFixes: [],
    metadata: {
      schemaVersion: 1,
      scannedFilesCount: 1,
      scanDurationMs: 42,
      hasRuntimeData: false,
      aiEnabled: false,
    },
  };
}

describe("AgentDoctor report formatter", () => {
  it("keeps a stable marker and concise baseline report", () => {
    const result: CheckResult = {
      schemaVersion: 1,
      result: makeScan(79),
      baseline: makeScan(86),
      comparison: {
        baselineRef: "main",
        baselineScore: 86,
        headScore: 79,
        scoreDelta: -7,
        regressions: [
          {
            kind: "new-finding",
            severity: "high",
            title: "stale instruction",
            detail: "A deleted path is referenced.",
          },
        ],
      },
      passed: false,
      failures: ["score regressed by 7 points"],
      exitCode: 1,
    };

    const markdown = formatAgentDoctorMarkdown(result);
    expect(markdown.startsWith(AGENTDOCTOR_REPORT_MARKER)).toBe(true);
    expect(markdown).toContain("| main | 86 |");
    expect(markdown).toContain("| HEAD | 79 ↓7 |");
    expect(markdown).toContain("- **HIGH**: stale instruction");
    expect(markdown).toContain("Status: ❌ Failed");
  });
});
