# AgentDoctor

> **A trust-first CI tool for AI coding context.**
> Find the wrong path, missing verification loop, and context regression before your agent does.

<p align="center">
  <img src="./assets/readme/hero.gif" width="100%" alt="AgentDoctor comparing a baseline and reporting new AI context regressions">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gaochenkai/agentdoctor"><img src="https://img.shields.io/npm/v/%40gaochenkai%2Fagentdoctor.svg" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-43853d.svg" alt="Node.js 20 or newer"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

AgentDoctor scans the repository instructions and project layout that coding agents rely on. It produces deterministic findings, a calibrated Agent Efficiency Score, stable JSON, and a baseline gate that is safe to put in CI.

It runs without an LLM, API key, dependency installation, or network access during a normal scan.

## Quick start

```bash
npx @gaochenkai/agentdoctor web        # Launch local interactive Web UI DevTools
npx @gaochenkai/agentdoctor scan       # Fast terminal scan
npx @gaochenkai/agentdoctor scan --json
npx @gaochenkai/agentdoctor check --baseline main --min-score 75 --max-regression 0 --fail-on high
npx @gaochenkai/agentdoctor audit      # Static agent security audit
npx @gaochenkai/agentdoctor eval       # Prove real agent effect with golden tasks
npx @gaochenkai/agentdoctor verify     # Opt-in: actually run test/lint/typecheck/build
npx @gaochenkai/agentdoctor fix --safe --shims --verify
npx @gaochenkai/agentdoctor check --sarif agentdoctor.sarif --annotate
```

Node.js 20 or newer is required. `npx @gaochenkai/agentdoctor` opens the interactive TUI dashboard in a terminal and falls back to a scan in non-interactive environments.

## Effective Context Debugger

`agentdoctor context` deterministically simulates what a local coding agent can load for one launch directory, set of target paths, and task. The report separates prompt text from candidates and capabilities, explains every glob/path decision, reports provable override/duplicate/conflict relationships, and shows an estimated token/byte budget.

```bash
agentdoctor context --agent codex --cwd . --path src/index.ts
agentdoctor context --agent claude --path src/api.ts --task "Add an API route"
agentdoctor context --agent cursor --path web/index.html --rule accessibility
agentdoctor context --agent copilot --skill review --subagent security --json
agentdoctor context --agent gemini --path src/index.ts --no-global
agentdoctor context --agent windsurf --path web/index.html
agentdoctor context --agent codex --profile fast --context-window 128000 --no-global
```

Repeat `--path`, `--rule`, and `--skill` as needed. Hook matching can be inspected with `--hook-event` and `--tool`; external imports remain blocked unless `--allow-external-imports` is supplied. The same simulator is available in the Web Context view and the TUI (`[` / `]` switches profiles, `r` reruns the original query).

| Profile | Hierarchical instructions | Path/glob rules | Skills | Hooks | Subagents | MCP |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | global + root→cwd `AGENTS` selection | fallback names + directory scope | yes | yes | custom agents | yes |
| Claude Code | managed/user/project/local + on-demand nested memory | `.claude/rules` `paths` | yes | yes | yes | yes |
| Cursor Agent/CLI | root files + nested `.cursor/rules` | Always/Auto/Requested/Manual | unavailable locally | unavailable locally | unavailable locally | yes |
| Copilot CLI | user/repository + directory-chain instructions | `applyTo` + extra instruction dirs | yes | yes | custom agents | yes |
| Gemini CLI | user + root→cwd `GEMINI.md` | settings only | no | no | no | `.gemini/settings.json` |
| Windsurf | `.windsurfrules` + `.windsurf/rules` | `trigger` / `globs` | no | no | no | yes |
| Cline | `.clinerules` file or directory chain | directory scope | no | no | no | yes |
| Aider | `CONVENTIONS.md` + config `read:` | config paths | no | no | no | no |
| OpenCode | `AGENTS.md` + config `instructions` | config paths | yes | no | `.opencode/agents` | yes |
| Roo Code | `.roo/rules` + `.roorules` | mode dirs via `--subagent` | no | no | mode rules | yes |

This is a static debugger: it does not start an agent, execute hooks, connect to MCP servers, or predict which conflicting natural-language instruction a model will follow. Unknown model windows stay `unknown`. Token estimates are calculated before output redaction; emitted prompt content is redacted, and MCP environment values are never returned (only variable names and whether they are set). Global local configuration is included by default and can be disabled with `--no-global`.

## Local Web UI DevTools

Launch a high-density, real-time diagnostic dashboard directly in your browser:

```bash
agentdoctor web
agentdoctor web --baseline main            # Side-by-side regression comparison
agentdoctor web --session path/to/trace.json # Inspect runtime agent session trace
agentdoctor web --port 4000 --no-open      # Custom port without opening browser
```

Key capabilities:
- **Zero Configuration & Privacy-First**: 100% local server, runs offline, zero telemetry, no external accounts, SaaS, or LLM required.
- **5 Focused Views**:
  - **Overview**: Overall Agent Efficiency Score, signal density gauge, verification loop health, security audit, and priority remediation issues.
  - **Context**: Queryable Effective Context simulation plus the existing instruction inventory, token bloat metrics, and concrete wasteful snippet inspector.
  - **Regression**: Side-by-side diff comparison between current branch and baseline ref with regression gate status.
  - **Findings**: Searchable, filterable issue workbench with diagnostic rationale, multi-file evidence, unified patch diff, and single-click copyable Fix Prompts.
  - **Sessions**: Execution trace stream, duration/token KPIs, and automated detection of interaction loops (repeated searches, file re-reads, and command retry failures).
- **Keyboard Shortcuts**: `1`-`5` for instant view switching, `R` to rescan repository on demand, `P` to batch copy all fix prompts.
- **Bilingual & Themes**: One-click toggle between English and 中文, as well as Dark and Light themes.

## What it understands

- Hierarchical `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor, Copilot, Windsurf, Cline, Aider, OpenCode, and Roo instruction files, plus MCP/settings such as `.mcp.json` and `.claude/settings.json`. Dependency, VCS, build, and generated directories are excluded.
- Node.js and pnpm workspaces, Python packages, Rust Cargo workspaces, Go modules/workspaces, and mixed repositories.
- Context paths that are actually stale: URLs, globs, templates, routes, commands, package names, and conceptual phrases are ignored. A deleted path is high confidence only when Git history confirms it existed.
- Verification loops for test, lint, typecheck, build, and CI commands.
- Agent security audit: prompt injection, hidden Unicode, secrets in instruction files, dangerous shell, MCP/hook permissions, external network, generated-file edits, and untrusted README/issue/tool output.
- Stable finding fingerprints, so moving a line does not create a fake baseline regression.

## Score you can explain

Each finding starts with the existing impact scale:

| Severity | Base impact |
| --- | ---: |
| Critical | 25 |
| High | 12 |
| Medium | 6 |
| Low | 2 |

The effective impact is:

```text
severity impact × clamped confidence × 1 / √rank
```

`rank` is calculated within the same rule group. Each ordinary group is capped at 35 points and oversized-file groups at 25, so a large repository does not lose a point for every similar file. Low-confidence results remain visible under **Needs Review** and do not trigger `fail-on` gates.

When runtime session data is absent, the static dimensions are re-normalized to Context 40%, Repository 20%, Verification 20%, and Security 20%. Verification items marked `not_applicable` do not enter the denominator or create deductions.

## Agent security audit

`agentdoctor audit` (also part of `scan` / `check`) statically inspects instruction files, MCP configs, and hooks:

| Rule | Looks for |
| --- | --- |
| `security/prompt-injection` | Jailbreak / ignore-previous-instructions language in agent files |
| `security/hidden-unicode` | Zero-width, tag, and bidi override characters |
| `security/instruction-secrets` | Live-looking credentials in instructions or MCP env |
| `security/dangerous-shell` | Destructive or remote-pipe shell in instructions and hooks |
| `security/mcp-hook-permissions` | Wildcard tool allow-lists, disabled sandbox, auto-approve MCP |
| `security/external-network` | Remote MCP, hook curl/wget, instructed exfiltration |
| `security/generated-file-edit` | Instructions or hooks that edit `dist` / generated output |
| `security/untrusted-content-injection` | README/issue/tool output treated as system commands |

```bash
agentdoctor audit
agentdoctor audit --json --fail-on high
```

Default `--fail-on high` exits `1` when high/critical findings have confidence ≥ 0.8. Evidence snippets are redacted.

## Baseline and regression checks

The baseline is read through `git archive`; the current working tree is never replaced:

```bash
agentdoctor check --baseline main
```

Example output:

```text
Agent Efficiency

main  86
HEAD  79 ↓7

New regressions:

- HIGH: stale instruction
- MEDIUM: +1,800 redundant context tokens
- MEDIUM: verification mismatch
```

The comparison uses fingerprints and detects:

- new or severity-upgraded stale/unresolved context findings;
- verification changes from healthy to warning/broken and command mismatches;
- context bloat from total tokens, de-duplicated wasteful tokens, or lower signal density.

Exit codes are stable: `0` passed, `1` gate failed, and `2` configuration error such as a missing baseline ref. `check --json` returns a fixed top-level shape:

```json
{
  "schemaVersion": 1,
  "result": { "overallScore": 86, "metadata": { "scanDurationMs": 42 } },
  "baseline": null,
  "comparison": null,
  "passed": true,
  "failures": [],
  "exitCode": 0
}
```

`scan --json` always includes `schemaVersion`, `metadata.scanDurationMs`, sorted findings, sorted evidence, and fingerprints. The schema is deterministic; timestamps and timings are the only run-dependent values.

## Effect evaluation: `agentdoctor eval`

The score proves your instructions are clean; eval proves the agent is **actually better** after you fix them. It runs your repository's own **golden tasks** and measures real outcomes instead of static weights:

- **first-pass rate** — tasks that reached green on the first attempt;
- **time-to-green** — wall time from task start to the first passing verification;
- **tokens / cost** — input+output tokens, with an optional per-model price for USD estimates;
- **retries** — agent re-attempts or native retry counts;
- **review churn** — added/removed lines the agent produced (review workload);
- **test failure rate** — failed verification commands / executed verification commands.

Unknown metrics stay `n/a`, never fabricated — the same honesty rules as runtime sessions.

### 1. Define golden tasks

```bash
agentdoctor eval --init   # scaffolds .agentdoctor/eval/golden-tasks.json
```

```json
{
  "schemaVersion": 1,
  "name": "my golden tasks",
  "pricing": { "inputPerMTok": 3, "outputPerMTok": 15 },
  "tasks": [
    {
      "id": "fix-failing-test",
      "prompt": "Run `npm test`, find the failing test, and fix the source code (not the test).",
      "setup": "node scripts/seed-failing-test.js",
      "verify": { "command": "npm test", "timeoutSeconds": 300 },
      "maxAttempts": 2,
      "match": { "sessionRegex": "fix.*failing.*test" }
    }
  ]
}
```

`setup` is optional and runs before the agent inside the disposable task copy;
use it to seed a deterministic fixture or failing test.

### 2. Measure — two modes

**Replay (default, offline):** attribute existing runtime session traces (`.agent/sessions/`, native CLI logs, OTLP, or `--session`) to golden tasks and derive effect metrics from what really happened:

```bash
agentdoctor eval
agentdoctor eval --session .agent/otel-traces.jsonl
```

**Command (live):** execute a real agent command per task, verify the result, and measure everything including review churn. Each task runs in a disposable copy of the current worktree by default, so tasks and before/after runs cannot contaminate one another:

```bash
agentdoctor eval --command "claude -p \"\$AGENTDOCTOR_TASK_PROMPT\""
agentdoctor eval --command "codex exec \"\$AGENTDOCTOR_TASK_PROMPT\""
```

`{task}` and `{prompt}` are substituted into the template; `$AGENTDOCTOR_TASK_ID` and `$AGENTDOCTOR_TASK_PROMPT` are always set (recommended for multi-line prompts). Attempt logs land in `.agentdoctor/eval/logs/`.

Use `--in-place` only when you explicitly want the agent's edits to remain in the current worktree:

```bash
agentdoctor eval --command "..." --in-place
```

### 3. Before/after: did the instructions change help?

**Live comparison (command mode):** `--baseline <ref>` materializes the ref's instruction files — `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, Cursor/Copilot/Windsurf/Cline/Aider/OpenCode/Roo rules, and related catalogs — into isolated task copies, runs the suite ("before"), then runs the current instructions ("after") from the same repository baseline and diffs the outcome:

```bash
agentdoctor eval --command "claude -p \"\$AGENTDOCTOR_TASK_PROMPT\"" --baseline main
```

```text
Comparison against main
verdict: IMPROVED
  ↑ first-pass rate: 0% -> 100%
  ↑ test failure rate: 100% -> 0%
  ↑ retries: 2 -> 0
```

**Replay comparison:** replayed traces cannot be re-executed under old instructions, so run eval once per trace set and compare records:

```bash
agentdoctor eval                       # writes .agentdoctor/eval/last-run.json
agentdoctor eval --compare .agentdoctor/eval/last-run.json
```

The verdict is **strict**: regressions on a primary metric (first-pass rate, median time-to-green) mean `regressed`; noisy continuous metrics (time, tokens, cost, churn) need a >10% (and ≥250 ms for time) move to count, while first-pass rate, retries, and test failure rate are exact counts. A replay run with missing task evidence is incomplete and fails instead of silently inflating the rate; the report shows evidence coverage.

### 4. Gate on it

```bash
agentdoctor eval --min-first-pass-rate 80
agentdoctor eval --command "..." --baseline main --min-first-pass-rate 80
```

Exit codes mirror `check`: `0` passed, `1` gate failed (below first-pass floor, effect regressed against the baseline, or a task error), `2` configuration error (missing/invalid suite, unresolvable ref, no traces to replay). `--json` returns a fixed top-level envelope with `run`/`before`/`after`/`comparison`, `passed`, `failures`, and `warnings`; the full run record is persisted to `.agentdoctor/eval/last-run.json` unless `--no-save`.

Known limits: replayed traces cannot yield true wall-clock duration or review churn; replay time-to-green is the session-relative trace offset. Token/cost measurements remain `n/a` when the trace source does not expose complete usage or pricing is not configured. Command-mode review churn includes text files created by the agent but excludes binary files and `.agentdoctor/eval` artifacts. Live evals are isolated by default; `--in-place` leaves edits in the tree for review.

## GitHub Action

Add the action after a full-history checkout so the baseline ref and deleted-path history are available:

```yaml
name: AgentDoctor

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  agentdoctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: agentdoctor/action@v1
        with:
          min-score: 75
          max-regression: 0
          fail-on: high
          baseline: main
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action always checks `min-score`. With a baseline, `fail-on` applies only to new or upgraded high-confidence regressions; without one, it applies to current high-confidence findings. `max-regression` is used only when a baseline exists.

It writes a concise report to the Job Summary, emits GitHub inline annotations for findings, writes `agentdoctor.sarif` (override with the `sarif` input), and updates one sticky PR comment using the `<!-- agentdoctor-report -->` marker. Upload the SARIF file with `github/codeql-action/upload-sarif` if you want Code Scanning alerts. If comment permission is unavailable, the summary and annotations remain available and comment publication does not turn a scan failure into a different failure.

Action outputs include `score`, `baseline-score`, `regression`, `regression-count`, `passed`, `report`, and `sarif-path`.

## Real-repository benchmark

The pinned corpus contains 16 public repositories across Node.js, Python, Rust, Go, monorepos, and mixed projects. It runs three scans per checkout without installing target dependencies, running target tests, or enabling an LLM. Clone and checkout time is excluded.

The latest checked-in benchmark summary is in [`benchmarks/BENCHMARK.md`](./benchmarks/BENCHMARK.md), with the manifest and fingerprint-level labels in [`benchmarks/manifest.json`](./benchmarks/manifest.json) and [`benchmarks/golden.json`](./benchmarks/golden.json).

Selected fixed-commit cases:

| Repository | Type | Result |
| --- | --- | --- |
| [`expressjs/express`](https://github.com/expressjs/express) | Node.js | 100 score, 0 findings |
| [`pallets/flask`](https://github.com/pallets/flask) | Python | 99 score, 1 reviewed finding |
| [`tokio-rs/tokio`](https://github.com/tokio-rs/tokio) | Rust workspace | 93 score, 12 reviewed findings |
| [`spf13/cobra`](https://github.com/spf13/cobra) | Go | 97 score, 3 reviewed findings |
| [`jupyterlab/jupyterlab`](https://github.com/jupyterlab/jupyterlab) | Mixed monorepo | 92 score, 26 findings, 1 low-confidence path needs review |

Run it manually or from the scheduled workflow:

```bash
npm run benchmark                 # network fetches pinned commits when needed
npm run benchmark -- --strict     # release-quality gate
npm run benchmark -- --offline    # only use an existing local cache
```

The benchmark command is intentionally separate from `npm test` so ordinary pull requests are not coupled to upstream repository availability.

## Commands

```text
agentdoctor web [-p <port>] [-c <path>] [--baseline <ref>] [-s <path>] [--no-open]
agentdoctor scan [--json] [--cwd <path>] [--session <path>] [--no-global] [--allow-sensitive] [--sarif <path>] [--annotate]
agentdoctor check [--baseline <ref>] [--min-score <0-100>]
                   [--max-regression <0-100>] [--fail-on <severity>]
                   [--json] [--sarif <path>] [--annotate]
agentdoctor eval [--tasks <path>] [--init] [--command <template>]
                 [--baseline <ref> | --compare <run.json>]
                 [--min-first-pass-rate <0-100>] [--no-fail-on-regression]
                 [--only <task-id>] [--session <path>] [--in-place]
                 [--json] [--no-save]
agentdoctor fix [--safe] [--generate-agents] [--shims] [--verify|--verify-all]
                [--rollback] [--pr] [--json]
agentdoctor init [--force] [--shims]
agentdoctor prompt [finding-id] [--all]
agentdoctor otel [-p <port>] [-o <path>] [--allow-sensitive]
agentdoctor verify [--only test,lint,typecheck,build] [--timeout <seconds>]
                   [--flaky-runs <n>] [--isolate] [--offline] [--json]
```

## Agent session ingestion

No manual exporting needed for the common case. `scan` reads repo-local traces
(`.agent/sessions/`, `.claude/sessions/`, `sessions/`, JSON or JSONL) **plus**
global native logs that belong to the current repo:

- Codex `~/.codex/sessions/**/*.jsonl` (matched by `session_meta.cwd`)
- Claude Code `~/.claude/projects/<encoded-cwd>/*.jsonl`
- Gemini CLI `~/.gemini/tmp/<sha256(repoRoot)>/chats/session-*.jsonl`
- Cursor `~/.cursor/projects/<encoded-cwd>/agent-transcripts/**/*.jsonl`
- OpenTelemetry OTLP/HTTP JSON or file-exporter JSONL via `--session traces.jsonl`

Missing duration/tokens are reported as `n/a`, never fabricated. Secrets
(API keys, tokens, passwords, private keys) are redacted by default;
pass `--allow-sensitive` or set `AGENTDOCTOR_ALLOW_SENSITIVE=1` to keep them.
Use `--no-global` (or `AGENTDOCTOR_INCLUDE_GLOBAL=0`) to scan repo-local files only.
Sessions retain native Git/task metadata when present and are otherwise linked
to the scanned repository's branch/commit and, when the `gh` CLI is available,
the matching PR. To collect live SDK traces:

```bash
agentdoctor otel -p 4318 -o .agent/otel-traces.jsonl
# OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
# OTEL_EXPORTER_OTLP_PROTOCOL=http/json
agentdoctor scan --session .agent/otel-traces.jsonl
```

`fix` is a closed loop: missing `AGENTS.md` is generated from the live project profile, `--shims` writes per-agent pointer files, changes apply as a multi-file transaction with a rollback journal, `--verify` re-runs lint/typecheck (or `--verify-all` including tests) and restores on failure, and `--pr` commits a branch and opens a pull request when `gh` and `origin` are available. `prompt` remains a review-first workflow. The Web UI runs entirely locally on your machine with zero cloud dependencies, accounts, or telemetry.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

The default scanner is static and offline. Runtime session traces are optional and excluded from baseline comparison so local, uncommitted session files cannot create CI noise.

## Execute the verification loop: `agentdoctor verify`

`scan` only checks that test/lint/typecheck/build **commands exist**. `verify` is opt-in and actually runs them so a placeholder `lint` script cannot look healthy.

```bash
agentdoctor verify
agentdoctor verify --only test,lint
agentdoctor verify --timeout 120 --flaky-runs 2 --isolate --json
```

Each executed check records exit code, wall time, estimated output tokens, and a failure summary. The test command is repeated (`--flaky-runs`, default 2) to flag non-deterministic suites. Commands are spawned as argv (no shell), with a per-command timeout, credential-like environment keys stripped, output capped, and cwd jailed to the repository. `--isolate` copies the worktree to a disposable temp directory (and symlinks `node_modules`) before running. CI workflows are still discovery-only — they are not executed.

Exit codes match `check`: `0` passed, `1` a check failed/timed out/was flaky, `2` configuration error. `--json` returns a fixed envelope with `schemaVersion`, `checks`, `findings`, `passed`, `failures`, `warnings`, and `exitCode`.

## License

MIT
