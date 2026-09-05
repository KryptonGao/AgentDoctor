import { describe, it, expect } from "vitest";
import {
  calculateCategoryScore,
  calculateEfficiencyScore,
  countFindingsBySeverity,
} from "../../src/core/score/calculator.js";
import { Finding, ContextSignalDensity } from "../../src/core/types.js";

describe("Scoring Calculator", () => {
  it("calculates category score with deductions", () => {
    const findings: Finding[] = [
      {
        id: "f1",
        ruleId: "repo/large-files",
        category: "repository",
        severity: "high", // -12
        title: "Large file",
        description: "Large file",
        evidence: [],
      },
      {
        id: "f2",
        ruleId: "repo/unorganized",
        category: "repository",
        severity: "medium", // -6
        title: "Unorganized",
        description: "Unorganized",
        evidence: [],
      },
    ];

    const score = calculateCategoryScore("repository", findings);
    expect(score).toBe(100 - 12 - 6); // 82
  });

  it("calculates context health blending signal density and deductions", () => {
    const findings: Finding[] = [
      {
        id: "f1",
        ruleId: "context/duplicate",
        category: "context",
        severity: "medium", // -6
        title: "Dup",
        description: "Dup",
        evidence: [],
      },
    ];

    const signalDensity: ContextSignalDensity = {
      totalTokens: 1000,
      usefulTokens: 800,
      wastefulTokens: 200,
      duplicateTokens: 100,
      inferableTokens: 50,
      staleTokens: 30,
      lowValueTokens: 20,
      densityPercent: 80.0,
    };

    // raw score = 100 - 6 = 94
    // density = 80
    // blended = 0.5 * 94 + 0.5 * 80 = 47 + 40 = 87
    const score = calculateCategoryScore("context", findings, signalDensity);
    expect(score).toBe(87);
  });

  it("re-normalizes weights when runtime data is absent", () => {
    const signalDensity: ContextSignalDensity = {
      totalTokens: 500,
      usefulTokens: 450,
      wastefulTokens: 50,
      duplicateTokens: 50,
      inferableTokens: 0,
      staleTokens: 0,
      lowValueTokens: 0,
      densityPercent: 90.0,
    };

    const result = calculateEfficiencyScore([], signalDensity, false);
    expect(result.scores.runtime).toBeNull();
    // Context: 35 / 75 = 0.467
    expect(result.scores.context.weight).toBeCloseTo(0.467, 2);
    expect(result.scores.repository.weight).toBeCloseTo(0.267, 2);
    expect(result.scores.verification.weight).toBeCloseTo(0.267, 2);
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
  });

  it("includes runtime score when runtime data is present", () => {
    const signalDensity: ContextSignalDensity = {
      totalTokens: 500,
      usefulTokens: 500,
      wastefulTokens: 0,
      duplicateTokens: 0,
      inferableTokens: 0,
      staleTokens: 0,
      lowValueTokens: 0,
      densityPercent: 100.0,
    };

    const result = calculateEfficiencyScore([], signalDensity, true);
    expect(result.scores.runtime).toBeDefined();
    expect(result.scores.context.weight).toBe(0.35);
    expect(result.scores.repository.weight).toBe(0.2);
    expect(result.scores.verification.weight).toBe(0.2);
    expect(result.scores.runtime?.weight).toBe(0.25);
    expect(result.overallScore).toBe(100);
  });

  it("uses confidence and square-root decay for large finding groups", () => {
    const makeFinding = (id: string, confidence = 1): Finding => ({
      id,
      ruleId: "context/duplicate-instruction",
      category: "context",
      severity: "medium",
      confidence,
      title: "Duplicate",
      description: "Duplicate",
      evidence: [],
    });

    const one = calculateCategoryScore("context", [makeFinding("one")]);
    const many = calculateCategoryScore(
      "context",
      Array.from({ length: 100 }, (_, index) => makeFinding(`many-${index}`)),
      {
        totalTokens: 1,
        usefulTokens: 1,
        wastefulTokens: 0,
        duplicateTokens: 0,
        inferableTokens: 0,
        staleTokens: 0,
        lowValueTokens: 0,
        densityPercent: 100,
      }
    );
    const lowConfidence = calculateCategoryScore("context", [makeFinding("low", 0.5)], {
      totalTokens: 1,
      usefulTokens: 1,
      wastefulTokens: 0,
      duplicateTokens: 0,
      inferableTokens: 0,
      staleTokens: 0,
      lowValueTokens: 0,
      densityPercent: 100,
    });

    expect(one).toBe(94);
    expect(many).toBeGreaterThan(60);
    expect(lowConfidence).toBeGreaterThan(one);
  });

  it("caps ordinary and oversized rule groups", () => {
    const ordinary = Array.from({ length: 100 }, (_, index): Finding => ({
      id: `ordinary-${index}`,
      ruleId: "repository/repeated-rule",
      category: "repository",
      severity: "critical",
      confidence: 1,
      title: "Repeated rule",
      description: "Repeated rule",
      evidence: [],
    }));
    const oversized = ordinary.map((finding, index) => ({
      ...finding,
      id: `oversized-${index}`,
      ruleId: "repo/oversized-source-files",
    }));

    expect(calculateCategoryScore("repository", ordinary)).toBe(65);
    expect(calculateCategoryScore("repository", oversized)).toBe(75);
  });

  it("keeps N/A verification checks out of score metrics", () => {
    const result = calculateEfficiencyScore(
      [],
      {
        totalTokens: 10,
        usefulTokens: 10,
        wastefulTokens: 0,
        duplicateTokens: 0,
        inferableTokens: 0,
        staleTokens: 0,
        lowValueTokens: 0,
        densityPercent: 100,
      },
      false,
      [
        { name: "test", status: "healthy" },
        { name: "lint", status: "not_applicable" },
      ]
    );

    expect(result.scores.verification.metrics?.applicableChecks).toBe(1);
    expect(result.scores.verification.metrics?.notApplicableChecks).toBe(1);
    expect(result.scores.verification.score).toBe(100);
  });
});
