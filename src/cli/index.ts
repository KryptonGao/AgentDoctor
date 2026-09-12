import { Command } from "commander";
import { runScanCommand } from "./commands/scan.js";
import { runCheckCommand } from "./commands/check.js";
import { CheckConfigurationError } from "../core/regression/check.js";
import { runFixCommand } from "./commands/fix.js";
import { runInitCommand } from "./commands/init.js";
import { runPromptCommand } from "./commands/prompt.js";
import { runWebCommand } from "./commands/web.js";
import { runOtelCommand } from "./commands/otel.js";
import { runEvalCommand } from "./commands/eval.js";
import { runContextCommand } from "./commands/context.js";
import { runVerifyCommand } from "./commands/verify.js";
import { runAuditCommand } from "./commands/audit.js";
import { launchTui } from "../tui/index.js";
import { AGENT_PROFILE_LIST } from "../analyzers/context/effectiveTypes.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("agentdoctor")
    .description("DevTools and efficiency diagnostics for AI Coding Agents")
    .version("0.1.0")
    .action(async () => {
      // Default action: launch TUI if interactive, else run scan
      if (process.stdout.isTTY && !process.env.CI) {
        await launchTui();
      } else {
        await runScanCommand();
      }
    });

  program
    .command("context")
    .description("Simulate the effective instructions and capabilities for an agent task")
    .requiredOption("--agent <agent>", `Agent profile: ${AGENT_PROFILE_LIST}`)
    .option("-c, --cwd <path>", "Agent launch directory")
    .option("--path <path>", "Target file path (repeatable)", collect, [])
    .option("--task <text>", "Task description used only to explain candidates")
    .option("--rule <name>", "Explicitly select a rule (repeatable)", collect, [])
    .option("--skill <name>", "Explicitly invoke a skill (repeatable)", collect, [])
    .option("--subagent <name>", "Explicitly select a subagent/custom agent")
    .option("--hook-event <event>", "Hook event to match")
    .option("--tool <name>", "Tool name used for hook matching")
    .option("--profile <name>", "Codex configuration profile")
    .option("--context-window <tokens>", "Known model context window in tokens")
    .option("--no-global", "Skip user/global configuration")
    .option("--allow-external-imports", "Allow imports outside repository/global roots")
    .option("--json", "Output the complete report as JSON")
    .action(async (options) => {
      await runContextCommand({ ...options, includeGlobal: options.global });
    });

  program
    .command("tui")
    .description("Launch the interactive terminal user interface")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-s, --session <path>", "Path to agent session trace (JSON/JSONL/OTLP)")
    .option("--agent <agent>", `Effective Context profile: ${AGENT_PROFILE_LIST}`, "codex")
    .option("--path <path>", "Effective Context target file (repeatable)", collect, [])
    .option("--task <text>", "Effective Context task description")
    .option("--rule <name>", "Explicit rule (repeatable)", collect, [])
    .option("--skill <name>", "Explicit skill (repeatable)", collect, [])
    .option("--subagent <name>", "Explicit subagent/custom agent")
    .option("--hook-event <event>", "Hook event to match")
    .option("--tool <name>", "Tool name used for hook matching")
    .option("--profile <name>", "Codex configuration profile")
    .option("--context-window <tokens>", "Known model context window")
    .option("--allow-external-imports", "Allow imports outside repository/global roots")
    .option("--no-global", "Skip global native log dirs (~/.codex, ~/.claude, ~/.gemini)")
    .option("--allow-sensitive", "Disable secret redaction in session output")
    .action(async (options) => {
      const contextWindow = options.contextWindow === undefined ? undefined : Number(options.contextWindow);
      await launchTui({
        sessionPath: options.session,
        cwd: options.cwd,
        includeGlobal: options.global,
        allowSensitive: options.allowSensitive,
        agent: options.agent,
        targetPaths: options.path,
        task: options.task,
        rules: options.rule,
        skills: options.skill,
        subagent: options.subagent,
        hookEvent: options.hookEvent,
        toolName: options.tool,
        profile: options.profile,
        contextWindowTokens: Number.isFinite(contextWindow) ? contextWindow : undefined,
        allowExternalImports: options.allowExternalImports,
      });
    });

  program
    .command("scan")
    .description("Scan repository and output agent efficiency report")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--json", "Output results as JSON")
    .option("-s, --session <path>", "Path to agent session trace (JSON/JSONL/OTLP)")
    .option("--no-global", "Skip global native log dirs (~/.codex, ~/.claude, ~/.gemini)")
    .option("--allow-sensitive", "Disable secret redaction in session output")
    .option("--max-global-sessions <n>", "Max global sessions to parse per repo (default 20)")
    .option("--sarif <path>", "Write findings as SARIF 2.1.0")
    .option("--annotate", "Print GitHub Actions workflow commands for inline annotations")
    .action(async (options) => {
      await runScanCommand({ ...options, includeGlobal: options.global });
    });

  program
    .command("check")
    .description("Verify repository meets minimum agent efficiency score")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-m, --min-score <score>", "Minimum acceptable score (0-100)", "75")
    .option("--baseline <ref>", "Git ref to compare against")
    .option("--max-regression <points>", "Maximum allowed score regression (0-100)", "0")
    .option("--fail-on <severity>", "Fail on new findings at or above severity")
    .option("-s, --session <path>", "Path to agent session trace (JSON/JSONL/OTLP)")
    .option("--no-global", "Skip global native log dirs")
    .option("--allow-sensitive", "Disable secret redaction in session output")
    .option("--json", "Output the check result as JSON")
    .option("--sarif <path>", "Write findings as SARIF 2.1.0")
    .option("--annotate", "Print GitHub Actions workflow commands for inline annotations")
    .action(async (options) => {
      try {
        const result = await runCheckCommand({ ...options, includeGlobal: options.global });
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = error instanceof CheckConfigurationError ? error.exitCode : 1;
      }
    });

  program
    .command("fix")
    .description("Apply instruction fixes as an atomic loop: generate, shim, verify, rollback, optional PR")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--safe", "Apply all safe fixes automatically without interactive prompts")
    .option("--generate-agents", "Write AGENTS.md from the live project profile (overwrites with --safe)")
    .option("--shims", "Create missing per-agent pointer files that defer to AGENTS.md")
    .option("--verify", "Run lint and typecheck after apply; roll back the transaction on failure")
    .option("--verify-all", "Run lint, typecheck, test, and build after apply; roll back on failure")
    .option("--rollback", "Restore files from the last fix journal")
    .option("--pr", "Commit applied files on a branch and open a pull request when gh/origin are available")
    .option("--json", "Output the fix-loop result as JSON")
    .action(async (options) => {
      await runFixCommand(options);
    });

  program
    .command("init")
    .description("Initialize AGENTS.md from the detected repository structure")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--force", "Overwrite an existing AGENTS.md")
    .option("--shims", "Also create missing Claude/Cursor/Copilot/Gemini/Aider/Windsurf/Cline/Roo pointer files")
    .action(async (options) => {
      await runInitCommand(options);
    });

  program
    .command("prompt [finding-id]")
    .description("Generate or copy deterministic AI Agent fix prompts for findings")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-s, --session <path>", "Path to agent session trace (JSON/JSONL/OTLP)")
    .option("--no-global", "Skip global native log dirs")
    .option("--allow-sensitive", "Disable secret redaction in session output")
    .option("--copy", "Copy the generated fix prompt to clipboard")
    .option("--all", "Generate fix prompts for all qualified issues")
    .action(async (findingId, options) => {
      await runPromptCommand(findingId, { ...options, includeGlobal: options.global });
    });

  program
    .command("web")
    .description("Launch the local AgentDoctor DevTools Web UI")
    .option("-p, --port <port>", "Port to run web server on", "4000")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--baseline <ref>", "Git ref to compare against for regressions")
    .option("-s, --session <path>", "Path to agent session trace (JSON/JSONL/OTLP)")
    .option("--no-global", "Skip global native log dirs")
    .option("--allow-sensitive", "Disable secret redaction in session output")
    .option("--no-open", "Do not open browser automatically")
    .action(async (options) => {
      await runWebCommand({ ...options, includeGlobal: options.global });
    });

  program
    .command("otel")
    .description("Run a local OTLP/HTTP receiver to collect agent traces")
    .option("-p, --port <port>", "Port to listen on (127.0.0.1 only)", "4318")
    .option("-o, --out <path>", "JSONL file to append traces to")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--allow-sensitive", "Disable secret redaction in persisted traces")
    .action(async (options) => {
      await runOtelCommand(options);
    });

  program
    .command("verify")
    .description("Opt-in: actually run discovered test/lint/typecheck/build commands")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--only <targets>", "Comma-separated subset: test,lint,typecheck,build")
    .option("--timeout <seconds>", "Per-command timeout in seconds", "300")
    .option("--flaky-runs <n>", "Repeat the test command to detect flakes (default 2)", "2")
    .option("--isolate", "Run inside a disposable copy of the worktree")
    .option("--offline", "Prefer offline package/module resolution")
    .option("--json", "Output the verify result as JSON")
    .action(async (options) => {
      await runVerifyCommand({
        cwd: options.cwd,
        only: options.only,
        timeout: options.timeout,
        flakyRuns: options.flakyRuns,
        isolate: options.isolate,
        offline: options.offline,
        json: options.json,
      });
    });

  program
    .command("audit")
    .description("Static agent security audit: injection, secrets, hooks, MCP, and untrusted input")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--fail-on <severity>", "Fail on findings at or above severity (default high)", "high")
    .option("--json", "Output the audit result as JSON")
    .action(async (options) => {
      await runAuditCommand({
        cwd: options.cwd,
        json: options.json,
        failOn: options.failOn,
      });
    });

  program
    .command("eval")
    .description("Verify golden tasks measure real agent effect, not just static score")
    .option("--init", "Scaffold a starter golden-task suite (.agentdoctor/eval/golden-tasks.json)")
    .option("--tasks <path>", "Path to the golden-task suite JSON")
    .option("--command <template>", "Agent command template; {task} and {prompt} are substituted, $AGENTDOCTOR_TASK_PROMPT/$AGENTDOCTOR_TASK_ID are always set. Enables live execution mode.")
    .option("--baseline <ref>", "Command mode: run tasks against instruction files (AGENTS.md/CLAUDE.md/Cursor/Copilot) from this ref for a before/after comparison")
    .option("--compare <run.json>", "Compare this run against a saved eval run record")
    .option("--min-first-pass-rate <0-100>", "Fail when the first-pass rate is below this value")
    .option("--no-fail-on-regression", "Keep baseline/comparison results informational only")
    .option("--only <task-id>", "Evaluate only the given task id")
    .option("--in-place", "Run live tasks in the current worktree; edits remain after eval")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-s, --session <path>", "Replay only this agent session trace (JSON/JSONL/OTLP)")
    .option("--no-global", "Skip global native log dirs (~/.codex, ~/.claude, ~/.gemini)")
    .option("--allow-sensitive", "Disable secret redaction in replayed session data")
    .option("--no-save", "Do not persist the run record to .agentdoctor/eval/last-run.json")
    .option("--json", "Output the eval result as JSON")
    .action(async (options) => {
      await runEvalCommand({ ...options, includeGlobal: options.global, save: options.save });
    });

  return program;
}

export async function runCli(argv: string[] = process.argv) {
  const program = createCli();
  await program.parseAsync(argv);
}

import { fileURLToPath } from "node:url";
import * as path from "node:path";

// If executed directly with tsx/node
try {
  if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    runCli().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
} catch {
  // ignore
}
