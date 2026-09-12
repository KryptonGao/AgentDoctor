import { Finding, Evidence, FixPromptContext } from "../types.js";

interface RuleSpecificGuidance {
  constraints: string[];
  verification: string[];
}

function getRuleSpecificGuidance(ruleId: string): RuleSpecificGuidance {
  const lowerRule = ruleId.toLowerCase();

  if (lowerRule.startsWith("security/")) {
    return {
      constraints: [
        "只修改指令文件、MCP 配置或 hook 配置中引入风险的内容",
        "不要把真实密钥写进证据、注释或新的指令文本；如已泄露，说明需要轮换",
        "保留仓库里正当的安全约束（例如 never edit generated files）",
        "不要为了消除告警而删除有用的架构说明",
      ],
      verification: [
        "再次运行 agentdoctor audit，确认对应 ruleId 已消失",
        "确认指令仍然能指导 agent 完成正当开发任务",
      ],
    };
  }

  if (lowerRule.includes("missing-agents-md")) {
    return {
      constraints: [
        "根据仓库真实布局、包管理器和验证命令生成 AGENTS.md",
        "只写 Agent 无法从 lockfile / package.json 推断的信息",
        "不要复制到 CLAUDE.md 等 shim 文件中；shim 只做指针",
        "明确禁止编辑 generated/dist/build 等产物目录",
      ],
      verification: [
        "再次运行 agentdoctor scan，确认 context/missing-agents-md 已消失",
        "确认 Critical Commands 与 package.json / CI 一致",
      ],
    };
  }

  if (lowerRule.includes("stale-path") || lowerRule.includes("unresolved-path")) {
    return {
      constraints: [
        "检查引用的路径是否存在，检查当前目录结构和 Git 历史记录",
        "判断该路径是已被删除、重命名/移动，还是指令书写拼写错误 (typo)",
        "将 instruction 中的路径更新为当前最新有效路径，或移除对已删除模块的过时说明",
        "严禁凭猜测随意替换路径；如无法从仓库确认真实意图，请说明冲突并保留注释",
      ],
      verification: [
        "确保修改后文档中引用的所有文件或目录在当前仓库中真实存在",
        "保持原有文档格式与风格，不引入无关修改",
      ],
    };
  }

  if (lowerRule.includes("duplicate-instruction")) {
    return {
      constraints: [
        "找出多个重复或语义高度重叠的 instruction 规则",
        "明确哪一个文件应作为单一事实来源（Source of Truth，通常为 AGENTS.md）",
        "删除跨文件或同文件内的冗余重复内容",
        "保留特定 Agent 或工具专用的差异化配置，不要将不同上下文机械粗暴合并",
      ],
      verification: [
        "确认重复规则已有效整合，不再存在冗余 Token 消耗",
        "确保关键规则语义完整，未遗漏原有约束",
      ],
    };
  }

  if (
    lowerRule.includes("verification") ||
    lowerRule.includes("command-mismatch") ||
    lowerRule.includes("command-consistency") ||
    lowerRule.includes("missing-test") ||
    lowerRule.includes("missing-typecheck")
  ) {
    return {
      constraints: [
        "对比 instruction 说明、项目配置文件（如 package.json、Makefile、pyproject.toml 等）与 CI 工作流配置",
        "确认当前仓库真实、受支持的验证与测试命令",
        "优先将 instruction 中的描述与实际工程工作流同步",
        "不要为了让文档看起来正确而随意修改已有且正常运行的测试、构建或 CI 配置",
      ],
      verification: [
        "在本地终端执行修正后的验证命令，确保命令能正常运行并通过",
        "instruction、配置文件与 CI 中的命令定义保持完全一致",
      ],
    };
  }

  if (lowerRule.includes("oversized-source-file") || lowerRule.includes("large-file")) {
    return {
      constraints: [
        "请分析该大型文件是否真的对 Agent 检索、导航和局部修改造成严重困难",
        "先评估：文件是否包含多个独立职责？是否存在超大函数或类？是否有明确模块边界？是否适合拆分？",
        "如果拆分收益有限或风险过高，不要单纯为了降低行数而强行重构",
        "如决定拆分，采用增量最小切分原则，保持所有公开导出符号与函数签名的向后兼容",
      ],
      verification: [
        "运行项目现有测试套件与类型检查，确保功能与接口行为无破坏",
        "确保所有调用点与导出符号完全一致",
      ],
    };
  }

  if (lowerRule.includes("conflicting-instructions") || lowerRule.includes("version-conflict")) {
    return {
      constraints: [
        "检查相关文件，确认当前项目实际要求的运行时环境或依赖版本",
        "如果项目配置文件与 CI 均代表当前真实配置，将文档中的旧要求同步更新为真实版本",
        "不要修改仓库配置文件或 CI，除非有确凿证据表明配置文件本身有误",
        "保持原有文档结构与风格，修改完成后展示具体 diff",
        "如果无法从证据确定正确版本，不要猜测，请明确说明证据冲突",
      ],
      verification: [
        "文档、配置文件与 CI 中的版本要求保持一致",
        "不引入额外无关修改",
      ],
    };
  }

  // Default fallback guidance
  return {
    constraints: [
      "只修改解决该问题所需的文件",
      "不要进行无关重构",
      "不要删除无法确认用途的代码或配置",
      "优先使用仓库中的真实配置作为证据",
      "如果证据不足，不要猜测",
      "修改完成后展示 diff",
    ],
    verification: [
      "运行仓库中现有的验证命令（测试、类型检查、构建等）确保未引入破坏",
      "确认修改精准解决上述 Finding，且未引入额外改动",
    ],
  };
}

function formatEvidenceSnippet(ev: Evidence): string {
  const loc = ev.file + (ev.line ? `:${ev.line}` : "");
  if (!ev.snippet && !ev.source) {
    return `- 位置: \`${loc}\``;
  }
  const cleanSnippet = (ev.snippet || ev.source || "")
    .trim()
    .slice(0, 300);
  return `- 位置: \`${loc}\`\n  证据内容: "${cleanSnippet}"`;
}

export function buildFixPromptContext(finding: Finding): FixPromptContext {
  const guidance = getRuleSpecificGuidance(finding.ruleId);
  const locations = finding.evidence.map((ev) => ({
    file: ev.file,
    line: ev.line,
  }));

  return {
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    description: finding.description,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    locations,
    constraints: guidance.constraints,
    verification: guidance.verification,
  };
}

/**
 * Generate an accurate, executable fix prompt for an AI Coding Agent based on a finding.
 * High signal density, low context waste, zero hallucinations.
 */
export function generateFixPrompt(finding: Finding): string {
  const ctx = buildFixPromptContext(finding);

  const evidenceText = ctx.evidence.length > 0
    ? ctx.evidence.map(formatEvidenceSnippet).join("\n")
    : "- 无具体行号证据，基于仓库全局配置或结构推导。";

  const constraintsText = ctx.constraints && ctx.constraints.length > 0
    ? ctx.constraints.map((c) => `- ${c}`).join("\n")
    : "- 只修改解决该问题所需的文件\n- 不要进行无关重构\n- 修改完成后展示 diff";

  const verificationText = ctx.verification && ctx.verification.length > 0
    ? ctx.verification.map((v) => `- ${v}`).join("\n")
    : "- 运行测试和检查流程验证修复结果";

  const recommendationText = ctx.recommendation || "根据上述证据分析并消除该问题。";

  return `请修复当前仓库中的以下 AgentDoctor Finding。

## 问题

${ctx.title}

Severity: ${ctx.severity.toUpperCase()}
Confidence: ${Math.round(ctx.confidence * 100)}%

## 证据

${evidenceText}

## 为什么这是问题

${ctx.description}

## 修复目标

${recommendationText}

## 要求

${constraintsText}

## 验证

${verificationText}
`.trim();
}

/**
 * Generate a combined prompt for all qualified findings (Copy All Fix Prompts).
 * Strictly filters:
 * - actionable !== false
 * - confidence >= 0.8
 * - severity >= medium
 * - !needsReview
 */
export function generateAllFixPrompts(findings: Finding[]): string {
  const eligible = findings.filter((f) => {
    if (f.actionable === false) return false;
    if (f.needsReview) return false;
    const conf = f.confidence ?? 0.85;
    if (conf < 0.8) return false;
    return f.severity === "critical" || f.severity === "high" || f.severity === "medium";
  });

  if (eligible.length === 0) {
    return "AgentDoctor did not detect any high-confidence actionable issues requiring batch fixing.";
  }

  const issuesList = eligible
    .map((f, idx) => {
      const prompt = generateFixPrompt(f);
      return `### Issue ${idx + 1}: ${f.title}
Severity: ${f.severity.toUpperCase()} | Confidence: ${Math.round((f.confidence ?? 0.85) * 100)}%

${prompt}`;
    })
    .join("\n\n---\n\n");

  return `AgentDoctor detected the following issues in this repository.

Please fix them one by one.

Do not perform unrelated refactoring.

${issuesList}

## 完成后：

- 运行仓库现有验证流程（测试、类型检查、构建等）
- 总结修改的内容与修复原因
- 展示最终 diff
- 标记任何无法确定的 Finding 并说明原因
`.trim();
}
