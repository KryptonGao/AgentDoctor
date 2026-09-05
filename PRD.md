# AgentDoctor

## Product Requirements Document

**Version:** v0.1 MVP
**Status:** Draft
**Product Type:** Developer Tool / TUI-first
**Primary Platform:** Terminal
**Secondary Platform:** Web UI, post-MVP
**Primary Language:** TypeScript

------

# 1. Product Overview

AgentDoctor 是一个面向 AI Coding Agent 的效率诊断与优化工具。

它通过分析代码仓库、Agent 上下文文件、验证流程与 Agent Session，定位影响 AI Coding Agent 工作效率的问题，并提供可解释、可执行的修复建议。

AgentDoctor 不负责替代 Codex、Claude Code、OpenCode、Cursor 等 Coding Agent。

它负责回答另一个问题：

> Why is your coding agent inefficient in this repository?

AgentDoctor 的目标是成为：

> **DevTools for AI Coding Agents.**

以及：

> **ESLint for AI agent efficiency.**

用户只需在仓库中运行：

```bash
npx agentdoctor
```

即可进入交互式 TUI，并获得仓库的 Agent Efficiency Score、问题列表、上下文浪费分析以及可执行修复建议。

------

# 2. Problem

AI Coding Agent 的实际表现不仅取决于模型能力。

同一个模型，在不同代码仓库中的效率可能存在巨大差异。

主要原因包括：

- Agent 上下文过长
- 重复 instructions
- 过期 instructions
- 互相冲突的规则
- 可由仓库直接推断却重复写入 context 的信息
- 仓库结构难以理解
- 关键操作流程没有被记录
- 错误或缺失的测试命令
- CI 与本地 instructions 不一致
- Agent 重复读取相同文件
- Agent 重复执行失败命令
- Tool output 过长
- Session 中存在大量无效搜索与反复试错

目前开发者通常只能观察：

```text
Agent 好像有点笨
Agent 怎么又读了一遍这个文件
为什么 Codex 一直跑错测试命令
为什么这个仓库特别烧 Token
```

但缺少一个系统化工具回答：

```text
哪里出了问题
问题有多严重
为什么这是问题
如何修复
修复后是否有效
```

AgentDoctor 用统一的诊断层解决这些问题。

------

# 3. Product Vision

长期目标：

> 建立一套可量化的 AI Coding Agent Repository Readiness 标准。

未来开发者可以像查看：

```text
Tests
Coverage
Lint
Type Safety
```

一样查看：

```text
Agent Efficiency
Context Health
Verification Readiness
Runtime Efficiency
```

最终形成类似：

```text
Agent Efficiency: 91/100
Context Signal Density: 87%
Verification Ready: Yes
```

的标准指标。

------

# 4. Target Users

## 4.1 Primary Users

### AI Coding Agent Heavy Users

经常使用：

- Codex
- Claude Code
- OpenCode
- Cursor
- Gemini CLI
- GitHub Copilot
- 其他 Coding Agent

典型痛点：

- 一个任务 Token 消耗异常高
- Agent 经常重复搜索
- Agent 不遵守项目规则
- AGENTS.md 越写越长
- 不知道 instructions 是否真的有效

------

### Open Source Maintainers

希望：

- 让贡献者使用的 Agent 更容易理解仓库
- 保持 AGENTS.md / CLAUDE.md 等文件一致
- 在 PR 中发现过期 Agent instructions
- 提供标准化 Agent 开发环境

------

### AI-native Development Teams

希望：

- 衡量不同项目的 Agent readiness
- 降低 Agent Token 成本
- 降低 Agent 失败率
- 建立团队 Agent instruction 规范

------

# 5. Product Principles

## 5.1 Explainable by Default

AgentDoctor 不应只输出：

```text
This looks bad.
```

所有 Finding 必须包含：

```text
Problem
Evidence
Impact
Recommendation
```

例如：

```text
HIGH · Conflicting Node.js version

AGENTS.md
Node >= 20

package.json
Node >= 22

.github/workflows/ci.yml
Node 22

Recommendation:
Update AGENTS.md to Node >= 22.
```

------

## 5.2 Deterministic First

能使用静态规则判断的问题，不调用 LLM。

例如：

- Token count
- 路径不存在
- package manager
- Node version
- 文件重复
- CI 命令
- Git history
- Session tool call 数量
- 重复文件读取
- 命令退出码

LLM 只用于：

- 语义重复
- Instruction quality
- 低价值 context 判断
- 语义冲突
- 上下文压缩建议
- 模糊 stale 信息判断

目标：

> 至少 70% 的基础诊断无需 AI。

------

## 5.3 Local First

默认：

- 不上传代码
- 不上传 Session
- 不要求账户
- 不要求 API Key
- 不要求云端服务

所有分析默认在本地完成。

------

## 5.4 TUI First

AgentDoctor 首先是 terminal-native developer tool。

主入口：

```bash
npx agentdoctor
```

而不是：

- Desktop App
- SaaS Dashboard
- Browser-only App

Web UI 仅用于后续高级可视化。

------

## 5.5 Fixes Must Be Reviewable

任何自动修改必须：

1. 展示 diff
2. 解释原因
3. 用户确认
4. 才能写入文件

禁止默认静默修改仓库。

------

# 6. Core Metrics

AgentDoctor 输出一个总指标：

# Agent Efficiency Score

范围：

```text
0 - 100
```

MVP 由四个维度构成：

```text
Context Health          35%
Repository Readiness    20%
Verification Readiness  20%
Runtime Efficiency      25%
```

如果 Runtime 数据不存在，则重新归一化其他三个指标。

例如：

```text
Agent Efficiency

72 / 100

Context          61
Repository       84
Verification     73
Runtime          70
```

------

# 7. Context Signal Density

AgentDoctor 核心独有指标：

> Context Signal Density

定义：

```text
High-value context tokens
─────────────────────────
Total context tokens
```

示例：

```text
AGENTS.md

8,412 tokens

Useful        4,912
Duplicate     1,482
Inferable     1,106
Stale           421
Low-value       491

Signal Density
58.4%
```

该指标用于衡量：

> Agent 每读取 100 个 context token，其中真正有多少是高价值信息。

------

# 8. MVP Scope

MVP 包含四个 Analyzer。

------

# 8.1 Context Analyzer

## Supported Sources

MVP 支持：

```text
AGENTS.md
CLAUDE.md
.cursor/rules/*
.github/copilot-instructions.md
package.json
README.md
Git metadata
```

可选支持：

```text
.claude/skills/*
```

------

## Detection Rules

### Duplicate Instructions

检测：

- 完全重复文本
- 高相似度规则
- 多个 Agent instruction 文件中的重复内容

示例：

```text
AGENTS.md
Use pnpm.

CLAUDE.md
Always use pnpm.

.cursor/rules/project.mdc
Package manager is pnpm.
```

输出：

```text
MEDIUM · Duplicate instruction

Found in:
AGENTS.md:31
CLAUDE.md:17
.cursor/rules/project.mdc:8

Estimated waste:
43 tokens/session
```

------

### Inferable Context

识别 Agent 可直接从仓库确定的信息。

例如：

```text
"This project uses pnpm."
```

而仓库已有：

```text
pnpm-lock.yaml
packageManager: pnpm@10
```

输出：

```text
LOW · Inferable instruction

This information can already be determined
from repository metadata.

Recommendation:
Remove from global context.
```

------

### Stale Context

检测 instructions 中引用的：

- 不存在路径
- 旧版本
- 已删除脚本
- 已删除 package
- 已移动目录

示例：

```text
AGENTS.md:
Frontend lives in /web

Repository:
./web does not exist
./apps/web exists
```

输出：

```text
HIGH · Possibly stale path

/web no longer exists.

Possible replacement:
apps/web/
```

------

### Conflicting Instructions

检测：

```text
AGENTS.md:
Node 20

package.json:
>=22

CI:
Node 22
```

输出：

```text
HIGH · Conflicting Node.js requirement
```

------

### Oversized Context

检测：

- 单个 instruction 文件过长
- Context 总 Token 过高
- 长段低信息密度内容

输出：

```text
AGENTS.md

8,421 tokens

Potential unnecessary context:
3,281 tokens
```

------

### Low-value Instructions

例如：

```text
Write clean code.
Follow best practices.
Be careful.
```

这类：

- 不可操作
- 非项目特有
- 信息增益极低

标记为：

```text
Low-value context
```

MVP 中该规则可依赖 LLM。

------

# 8.2 Repository Analyzer

目标：

> 衡量 Agent 理解仓库的难度。

MVP 不评价代码质量本身。

------

## Checks

### Project Structure

识别：

```text
src/
apps/
packages/
tests/
docs/
```

检查：

- 是否有明显源码入口
- 是否存在异常复杂嵌套
- 是否存在大量命名模糊目录

------

### Large Files

标记例如：

```text
> 1500 lines
```

的大型源码文件。

输出：

```text
MEDIUM

src/auth/AuthService.ts
2,831 lines

Large files increase retrieval and editing cost.
```

------

### Generated Code Discoverability

检测：

```text
generated/
dist/
build/
openapi-generated/
```

并判断：

- 是否在 Agent instructions 中注明不可直接编辑
- 是否能发现生成命令

------

### Critical Workflow Discoverability

AgentDoctor 尝试回答：

```text
How do I install?
How do I build?
How do I test?
How do I lint?
How do I typecheck?
How do I generate code?
```

若无法从仓库明确判断，则产生 Finding。

------

# 8.3 Verification Analyzer

目标：

> 判断 Agent 修改代码后是否拥有可靠反馈回路。

------

## Detect Commands

从以下文件发现：

```text
package.json
Makefile
CI workflows
pyproject.toml
Cargo.toml
```

MVP 优先支持 Node.js。

识别：

```text
test
lint
typecheck
build
```

------

## Verification Consistency

比较：

```text
AGENTS.md
CLAUDE.md
package.json
CI
```

例如：

```text
AGENTS.md:
npm test

CI:
pnpm test:ci
```

输出：

```text
HIGH · Verification command mismatch
```

------

## Command Health

可选执行安全命令：

```text
lint
typecheck
test
build
```

并记录：

```text
Exit code
Duration
Output size
```

首次执行前必须提示用户。

------

## Missing Verification

例如：

```text
No test command found
No typecheck command found
```

输出：

```text
Verification Readiness: 52
```

------

# 8.4 Runtime Analyzer

MVP Runtime Analyzer 支持 1 至 2 种 Agent Session。

首选：

```text
Codex
Claude Code
```

实际优先支持解析难度更低的一种。

------

## Metrics

记录：

```text
Session duration
Token usage
Tool calls
Failed tool calls
Commands executed
Files read
Files edited
Search operations
Tool output size
```

------

## Repeated Reads

例如：

```text
AuthService.ts
read 5 times
```

输出：

```text
MEDIUM · Repeated file retrieval

AuthService.ts was read 5 times
within 12 minutes.
```

------

## Repeated Search

检测：

```text
grep auth
search auth
grep "AuthService"
search auth
```

相似搜索不断重复。

------

## Repeated Command Failure

例如：

```text
npm test
failed 4 times
```

输出：

```text
HIGH · Repeated failed command

Same command failed 4 times
without meaningful configuration change.
```

------

## Oversized Tool Output

例如：

```text
npm test

31,202 output tokens
```

但有效错误只占：

```text
1,238 tokens
```

输出：

```text
Tool output bloat detected.
```

------

# 9. TUI Information Architecture

主界面包含：

```text
Overview
Context
Repository
Verification
Sessions
Fixes
```

------

# 9.1 Overview

示例：

```text
┌ AgentDoctor ────────────────────────────────────────────┐
│ StudyPulse                                    main ✓    │
├─────────────────────────────────────────────────────────┤
│                                                       │
│               Agent Efficiency                        │
│                      72                               │
│                                                       │
│ Context       ██████░░░░ 61                           │
│ Repository    ████████░░ 84                           │
│ Verification  ███████░░░ 73                           │
│ Runtime       ███████░░░ 70                           │
│                                                       │
├─────────────────────────────────────────────────────────┤
│ Top Issues                                            │
│                                                       │
│ ▲ HIGH  Conflicting Node version                     │
│ ▲ HIGH  3,281 unnecessary context tokens             │
│ ● MED   Test command differs from CI                  │
│ ● MED   Agent repeatedly reads AuthService.ts         │
│                                                       │
│ ↑↓ Navigate  Enter Details  f Fix  r Rescan  q Quit  │
└─────────────────────────────────────────────────────────┘
```

------

# 9.2 Context View

展示：

```text
Token breakdown
Signal Density
Context issues
Files
Potential savings
```

示例：

```text
Context Health                        61

Total Context
12,481 tokens

Useful          6,823
Duplicate       2,104
Inferable       1,721
Stale             903
Low-value         930

Signal Density
54.7%
```

------

# 9.3 Repository View

展示：

```text
Structure
Large files
Generated code
Missing instructions
Discoverability findings
```

------

# 9.4 Verification View

展示：

```text
Typecheck
Lint
Tests
Build
CI
```

状态：

```text
✓ Healthy
⚠ Warning
✕ Broken
? Unknown
```

------

# 9.5 Sessions View

Session 列表：

```text
Codex     Today 00:21      72
Claude    Yesterday        81
Codex     Yesterday        66
```

详情：

```text
Fix authentication bug

Duration      18m 31s
Tokens        107k
Tool calls    94
Failures      12

Timeline

00:02  Search auth
00:04  Read AuthService.ts
00:06  Edit AuthService.ts
00:08  Test failed
00:10  Read AuthService.ts
00:13  Test failed
00:17  Test passed
```

------

# 9.6 Fixes View

展示所有可修复 Findings。

例如：

```text
8 fixes available

✓ Remove duplicate package-manager rule
✓ Update outdated Node version
✓ Remove inferable framework description
✓ Replace invalid test command
```

选择某个 Fix 后展示：

```diff
- This project uses React.
- This project uses TypeScript.
- Package manager is pnpm.

  Never edit generated API clients manually.
```

操作：

```text
Apply
Skip
Apply All Safe Fixes
```

------

# 10. CLI

除 TUI 外提供非交互式 CLI。

------

## Launch TUI

```bash
agentdoctor
```

------

## Scan

```bash
agentdoctor scan
```

输出：

```text
Agent Efficiency: 72

17 issues found
3 high severity
8 medium severity
6 low severity
```

------

## JSON Output

```bash
agentdoctor scan --json
```

用于：

- CI
- 其他 Agent
- IDE integration
- Third-party tools

------

## Check

```bash
agentdoctor check
```

支持：

```bash
agentdoctor check --min-score 80
```

若不达标：

```text
Process exit code: 1
```

------

## Fix

```bash
agentdoctor fix
```

进入 fix review。

未来支持：

```bash
agentdoctor fix --safe
```

------

# 11. CI Integration

MVP 后期支持：

```yaml
- run: npx agentdoctor check --min-score 75
```

PR 中可检测：

```text
Context Score

main     87
PR       71

Regression detected.
```

以及：

```text
2 stale instructions introduced.
```

------

# 12. Architecture

MVP 技术栈：

```text
Language
TypeScript

Runtime
Node.js 22+

Package Manager
pnpm

TUI
Ink + React

CLI
Commander.js

Validation
Zod

Testing
Vitest

Git
System git CLI

Config
JSON / YAML / TOML / Markdown

AI
OpenAI-compatible Provider Interface
```

------

# 13. Code Architecture

MVP 初期不使用 Monorepo。

建议：

```text
src/
├── cli/
├── tui/
├── core/
│   ├── scan/
│   ├── score/
│   ├── findings/
│   └── fix/
├── analyzers/
│   ├── context/
│   ├── repository/
│   ├── verification/
│   └── runtime/
├── rules/
├── providers/
├── parsers/
└── shared/
```

未来加入 Web UI 时再拆：

```text
apps/
  tui/
  web/

packages/
  core/
  cli/
  shared/
```

------

# 14. Rule Model

每条规则统一输出：

```ts
interface Finding {
  id: string
  ruleId: string

  category:
    | "context"
    | "repository"
    | "verification"
    | "runtime"

  severity:
    | "critical"
    | "high"
    | "medium"
    | "low"

  title: string
  description: string

  evidence: Evidence[]

  impact?: {
    tokens?: number
    latency?: number
    reliability?: number
  }

  recommendation?: string

  fix?: Fix
}
```

------

# 15. AI Provider

AI 必须通过统一接口：

```ts
interface LLMProvider {
  analyze(request: AnalysisRequest): Promise<AnalysisResult>
}
```

MVP 默认支持：

```text
OpenAI-compatible API
```

用户配置：

```text
Base URL
API Key
Model
```

不配置 AI 时：

> AgentDoctor 仍必须具备完整基础功能。

------

# 16. Privacy

默认：

```text
No account
No telemetry
No cloud upload
No code upload
```

如果未来加入 telemetry：

必须：

```text
Opt-in
Anonymous
Clearly documented
```

------

# 17. MVP Non-goals

v0.1 明确不做：

- 自己实现 Coding Agent
- Agent orchestration
- MCP Marketplace
- Skills Marketplace
- Memory system
- 自动模型选择
- Cloud account
- Team workspace
- SaaS backend
- IDE Extension
- Desktop App
- Vector database
- Full repository embeddings
- 自动大规模代码重构
- Benchmark 不同模型
- 支持所有 Coding Agent
- 支持所有编程语言

------

# 18. MVP Supported Environment

首版优先支持：

```text
Git repositories
Node.js projects
TypeScript
JavaScript
```

Context：

```text
AGENTS.md
CLAUDE.md
.cursor/rules
.github/copilot-instructions.md
```

Runtime：

```text
1-2 Agent session formats
```

------

# 19. MVP Release Criteria

v0.1 可以发布必须满足：

### Installation

用户可以：

```bash
npx agentdoctor
```

在 10 秒内进入 TUI。

------

### Repository Scan

能可靠读取：

```text
Git
package.json
AGENTS.md
CLAUDE.md
CI workflow
```

------

### Context Analysis

至少实现：

```text
Token count
Exact duplicate
Semantic duplicate
Inferable context
Stale path
Version conflict
Oversized context
```

------

### Repository Analysis

至少实现：

```text
Large files
Generated code detection
Missing workflow instructions
Basic project structure analysis
```

------

### Verification Analysis

至少实现：

```text
test command
lint command
typecheck command
build command
CI consistency
```

------

### Runtime Analysis

至少支持一个 Agent。

至少检测：

```text
Repeated file reads
Repeated searches
Repeated command failures
Oversized tool output
```

------

### Fix Engine

至少支持：

```text
3+ deterministic auto-fix rules
```

并确保：

```text
所有修改先展示 diff
```

------

# 20. Success Metrics

## GitHub

发布后关注：

```text
Stars
Forks
Contributors
Issues
PRs
```

核心目标：

```text
3,000 GitHub Stars
```

------

## Product

### Activation

用户首次运行后：

```text
成功完成 repository scan
```

------

### Value Discovery

用户首次扫描中：

```text
至少发现 1 个 Medium+ Finding
```

------

### Fix Rate

```text
用户应用至少一个 Fix
─────────────────────
扫描用户
```

------

### Score Improvement

关注：

```text
Before
72

After
84
```

------

### Signal Density Improvement

例如：

```text
58% → 81%
```

------

# 21. Roadmap

## v0.1

```text
TUI
Context Analyzer
Repository Analyzer
Verification Analyzer
Basic Fix Engine
Node.js support
```

------

## v0.2

```text
Runtime Analyzer
Codex sessions
Claude Code sessions
Session Efficiency Score
```

------

## v0.3

```text
agentdoctor web
React Web Dashboard
Session visualization
Context visualization
Historical trends
```

------

## v0.4

```text
CI integration
PR score diff
Context regression detection
GitHub Actions
```

------

## v0.5

```text
Python
Rust
Go
Additional coding agents
Plugin-based rule system
```

------

# 22. Long-term Opportunities

长期可以扩展：

### Agent Readiness Standard

类似：

```text
README badges
```

例如：

```text
Agent Ready 91/100
```

------

### Repository Benchmark

跨仓库比较：

```text
Context Signal Density
Verification Readiness
Runtime Efficiency
```

------

### Agent Regression Detection

发现：

```text
这个 PR 让 Agent 更难理解项目了。
```

------

### Agent Performance Observatory

把：

```text
Code
Context
Tools
Sessions
Git
Verification
```

关联起来，解释 Agent 为什么低效。

------

# 23. Positioning

AgentDoctor 不应该被描述为：

> Token optimizer

也不应该只是：

> AGENTS.md linter

更准确的定位：

> **AgentDoctor diagnoses how efficiently AI coding agents can understand, navigate and work inside your repository.**

短版：

> **DevTools for AI coding agents.**

传播版：

> **Find what makes your coding agent slow, wasteful or confused.**

技术版：

> **Static analysis and runtime diagnostics for AI coding agents.**

------

# 24. MVP Core Loop

最终必须坚持这条闭环：

```text
npx agentdoctor
        ↓
Scan repository
        ↓
Efficiency Score
        ↓
Find problems
        ↓
Show evidence
        ↓
Suggest fixes
        ↓
Review diff
        ↓
Apply
        ↓
Rescan
        ↓
Score improves
```

如果一个功能不能明显增强这个闭环，就不应该进入 v0.1。