import { describe, expect, it } from "vitest";
import { compareScanResults } from "../../src/core/regression/comparator.js";
import { createFindingFingerprint } from "../../src/core/findings/identity.js";
import { Finding, ScanResult } from "../../src/core/types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding",
    ruleId: "context/stale-path",
    category: "context",
    severity: "high",
    confidence: 0.95,
    title: "Stale path",
    description: "A path is stale",
    evidence: [{ file: "AGENTS.md", line: 2, snippet: "Use `src/old.ts`" }],
    ...overrides,
  };
}

function makeScan(overrides: Partial<ScanResult> = {}): ScanResult {
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
      packageRoots: ["src"],
      workspaceRoots: [],
      isMonorepo: false,
      testRoots: ["test"],
      entryPoints: ["src/index.ts"],
      configFiles: { node: ["package.json"] },
      confidence: 1,
    },
    overallScore: 100,
    scoreExplanation: "static",
    scores: {
      context: { score: 100, weight: 0.4, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      repository: { score: 100, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      verification: { score: 100, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
      security: { score: 100, weight: 0.2, findingsCount: { critical: 0, high: 0, medium: 0, low: 0 } },
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
    verificationStatus: [
      { name: "test", status: "healthy", command: "npm test" },
      { name: "lint", status: "not_applicable" },
    ],
    sessions: [],
    findings: [],
    availableFixes: [],
    metadata: {
      schemaVersion: 1,
      scannedFilesCount: 1,
      scanDurationMs: 10,
      hasRuntimeData: false,
      aiEnabled: false,
    },
    ...overrides,
  };
}

describe("Baseline regression comparison", () => {
  it("keeps fingerprints stable when evidence order changes", () => {
    const finding = makeFinding({
      evidence: [
        { file: "src/index.ts", line: 4, snippet: "Use the old module" },
        { file: "AGENTS.md", line: 20, snippet: "Use `src/old.ts`" },
      ],
    });
    const reordered = makeFinding({ evidence: [...finding.evidence].reverse() });

    expect(createFindingFingerprint(finding)).toBe(createFindingFingerprint(reordered));
  });

  it("matches a finding after its line number moves", () => {
    const baseline = makeScan({ findings: [makeFinding()] });
    const head = makeScan({
      findings: [makeFinding({ evidence: [{ file: "AGENTS.md", line: 20, snippet: "Use `src/old.ts`" }] })],
    });

    const comparison = compareScanResults(baseline, head, "main");
    expect(comparison.regressions.filter((regression) => regression.kind === "new-finding")).toHaveLength(0);
  });

  it("reports new stale instructions and context bloat", () => {
    const baseline = makeScan();
    const head = makeScan({
      overallScore: 80,
      contextSignalDensity: {
        totalTokens: 2_000,
        usefulTokens: 500,
        wastefulTokens: 1_500,
        duplicateTokens: 1_500,
        inferableTokens: 0,
        staleTokens: 0,
        lowValueTokens: 0,
        densityPercent: 25,
      },
      findings: [makeFinding()],
    });

    const comparison = compareScanResults(baseline, head, "main");
    expect(comparison.scoreDelta).toBe(-20);
    expect(comparison.regressions.some((regression) => regression.title === "stale instruction")).toBe(true);
    expect(comparison.regressions.some((regression) => regression.kind === "context-bloat" && regression.title.includes("1,500"))).toBe(true);
  });

  it("reports a verification status regression but ignores N/A transitions", () => {
    const baseline = makeScan();
    const head = makeScan({
      verificationStatus: [
        { name: "test", status: "broken", command: "npm test", source: "package.json" },
        { name: "lint", status: "healthy" },
      ],
    });

    const comparison = compareScanResults(baseline, head, "main");
    const verificationRegressions = comparison.regressions.filter((regression) => regression.kind === "verification");
    expect(verificationRegressions).toHaveLength(1);
    expect(verificationRegressions[0].severity).toBe("high");
  });
});
