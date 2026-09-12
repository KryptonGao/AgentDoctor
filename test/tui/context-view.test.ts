import { describe, expect, it } from "vitest";
import { buildContextViewModel } from "../../src/tui/views/ContextView.js";
import { EffectiveContextReport } from "../../src/analyzers/context/effectiveTypes.js";

describe("Effective Context TUI view model", () => {
  it("keeps prompt, candidate and capability layers separate", () => {
    const report = {
      profile: { id: "codex", name: "Codex", surface: "CLI", deterministic: true },
      query: { targetPaths: ["src/a.ts"] },
      prompt: [{ status: "loaded", source: "AGENTS.md", matchReason: "root" }],
      candidates: [{ source: "SKILL.md", name: "review", matchReason: "implicit" }],
      capabilities: [{ status: "available", kind: "mcp", name: "db" }],
      diagnostics: [],
      budget: { promptTokens: 10, candidateTokens: 4, contextWindowTokens: null, usagePercent: null },
    } as unknown as EffectiveContextReport;
    const model = buildContextViewModel(report);
    expect(model.promptSources).toEqual(["✓ AGENTS.md — root"]);
    expect(model.candidates[0]).toContain("review");
    expect(model.capabilities[0]).toContain("mcp:db");
    expect(model.budget).toContain("window unknown");
  });
});
