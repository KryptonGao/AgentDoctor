import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Finding } from "../../src/core/types.js";
import {
  generateFixPrompt,
  generateAllFixPrompts,
  buildFixPromptContext,
} from "../../src/core/prompt/promptGenerator.js";
import { copyToClipboard, setCustomClipboardWriter } from "../../src/shared/clipboard.js";
import { scanRepository } from "../../src/core/scan/scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("Fix Prompt Generation (Section 17)", () => {
  afterEach(() => {
    setCustomClipboardWriter(null);
  });

  const sampleFinding: Finding = {
    id: "finding-stale-1",
    ruleId: "context/stale-path",
    category: "context",
    severity: "high",
    confidence: 0.95,
    title: 'Stale path reference: "src/old_module.ts"',
    description: 'Instruction references "src/old_module.ts", which previously existed in git history but was deleted.',
    evidence: [
      {
        file: "AGENTS.md",
        line: 42,
        snippet: "See src/old_module.ts for implementation details",
      },
    ],
    recommendation: 'Remove obsolete reference to deleted path "src/old_module.ts" or point to the new location.',
  };

  // 1. 每个可修复 Finding 都可以生成 Fix Prompt
  it("generates a Fix Prompt for an actionable finding", () => {
    const prompt = generateFixPrompt(sampleFinding);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(50);
  });

  // 2. Prompt 包含 title, severity, confidence
  it("prompt contains title, severity and confidence", () => {
    const prompt = generateFixPrompt(sampleFinding);
    expect(prompt).toContain('Stale path reference: "src/old_module.ts"');
    expect(prompt).toContain("HIGH");
    expect(prompt).toContain("95%");
  });

  // 3. Prompt 包含 evidence
  it("prompt contains structured evidence", () => {
    const prompt = generateFixPrompt(sampleFinding);
    expect(prompt).toContain("## 证据");
    expect(prompt).toContain("See src/old_module.ts for implementation details");
  });

  // 4. Prompt 包含相关文件路径和行号
  it("prompt contains related file paths and line numbers", () => {
    const prompt = generateFixPrompt(sampleFinding);
    expect(prompt).toContain("AGENTS.md:42");
  });

  // 5. Prompt 包含 recommendation
  it("prompt contains recommendation", () => {
    const prompt = generateFixPrompt(sampleFinding);
    expect(prompt).toContain("## 修复目标");
    expect(prompt).toContain('Remove obsolete reference to deleted path "src/old_module.ts"');
  });

  // 6. Prompt 不包含无关 Finding
  it("prompt does not contain unrelated finding details", () => {
    const prompt = generateFixPrompt(sampleFinding);
    expect(prompt).not.toContain("duplicate-instruction");
    expect(prompt).not.toContain("oversized source files");
    expect(prompt).not.toContain("pytest");
  });

  // 7. low-confidence Finding 默认不进入 Copy All
  it("excludes low-confidence findings (<0.8) from Copy All", () => {
    const lowConfFinding: Finding = {
      ...sampleFinding,
      id: "low-conf-1",
      confidence: 0.65,
      title: "Tentative guess finding",
    };
    const combined = generateAllFixPrompts([lowConfFinding]);
    expect(combined).not.toContain("Tentative guess finding");
    expect(combined).toContain("did not detect any high-confidence actionable issues");
  });

  // 8. Needs Review 默认不进入 Copy All
  it("excludes Needs Review findings from Copy All", () => {
    const needsReviewFinding: Finding = {
      ...sampleFinding,
      id: "needs-review-1",
      confidence: 0.85,
      needsReview: true,
      title: "Needs Review item",
    };
    const combined = generateAllFixPrompts([needsReviewFinding]);
    expect(combined).not.toContain("Needs Review item");
  });

  // 9. JSON 输出包含 fixPrompt
  it("includes fixPrompt for findings in scanRepository output", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "AGENTS.md"),
        "# Instructions\nCheck missing path `src/nonexistent_file.ts` for details.\n"
      );
      const scan = await scanRepository({ cwd: tmpDir });

      expect(scan.findings.length).toBeGreaterThan(0);
      for (const f of scan.findings) {
        expect(f.fixPrompt).toBeDefined();
        expect(typeof f.fixPrompt).toBe("string");
        expect(f.fixPrompt?.length).toBeGreaterThan(30);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 10. clipboard failure 不导致程序崩溃
  it("handles clipboard failure gracefully without throwing or crashing", async () => {
    // Mock clipboard writer throwing an error
    setCustomClipboardWriter(async () => {
      return { success: false, error: "Mock clipboard error (no display or clip tool)" };
    });

    const res = await copyToClipboard("test prompt");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Mock clipboard error");
  });

  // 11. 不调用 LLM 也可以生成基础 Fix Prompt (纯确定性)
  it("generates deterministic prompts without any external LLM calls", () => {
    const prompt1 = generateFixPrompt(sampleFinding);
    const prompt2 = generateFixPrompt(sampleFinding);
    expect(prompt1).toBe(prompt2);
    expect(prompt1).toContain("请修复当前仓库中的以下 AgentDoctor Finding。");
  });

  // 12. Prompt 长度不会因整个源文件内容而无限膨胀 (高 Signal Density)
  it("does not bloat prompt length with massive source files", () => {
    const hugeSnippet = "A".repeat(50000);
    const findingWithHugeSnippet: Finding = {
      ...sampleFinding,
      evidence: [
        {
          file: "huge_file.py",
          line: 1,
          snippet: hugeSnippet,
        },
      ],
    };

    const prompt = generateFixPrompt(findingWithHugeSnippet);
    // Snippet must be truncated to avoid token waste
    expect(prompt.length).toBeLessThan(2000);
  });

  // Rule-specific tests (Section 17.5)
  it("generates specialized prompt instructions for stale-path", () => {
    const prompt = generateFixPrompt({
      ...sampleFinding,
      ruleId: "context/stale-path",
    });
    expect(prompt).toContain("Git 历史记录");
    expect(prompt).toContain("严禁凭猜测随意替换路径");
  });

  it("generates specialized prompt instructions for duplicate-instruction", () => {
    const prompt = generateFixPrompt({
      ...sampleFinding,
      ruleId: "context/duplicate-instruction",
      title: "Duplicate instruction detected",
    });
    expect(prompt).toContain("Source of Truth");
    expect(prompt).toContain("不要将不同上下文机械粗暴合并");
  });

  it("generates specialized prompt instructions for verification-mismatch", () => {
    const prompt = generateFixPrompt({
      ...sampleFinding,
      ruleId: "verification/ecosystem-command-mismatch",
      title: "Command mismatch in instruction",
    });
    expect(prompt).toContain("CI 工作流配置");
    expect(prompt).toContain("优先将 instruction 中的描述与实际工程工作流同步");
  });

  it("generates specialized prompt instructions for oversized-source-file", () => {
    const prompt = generateFixPrompt({
      ...sampleFinding,
      ruleId: "repo/oversized-source-files",
      title: "Oversized source files",
    });
    expect(prompt).toContain("如果拆分收益有限或风险过高，不要单纯为了降低行数而强行重构");
    expect(prompt).toContain("保持所有公开导出符号与函数签名的向后兼容");
  });

  it("generates specialized prompt instructions for version-conflict", () => {
    const prompt = generateFixPrompt({
      ...sampleFinding,
      ruleId: "context/conflicting-instructions",
      title: "Conflicting Node.js requirement",
    });
    expect(prompt).toContain("如果项目配置文件与 CI 均代表当前真实配置");
    expect(prompt).toContain("如果无法从证据确定正确版本，不要猜测，请明确说明证据冲突");
  });
});
