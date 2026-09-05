import { Command } from "commander";
import { runScanCommand } from "./commands/scan.js";
import { runCheckCommand } from "./commands/check.js";
import { CheckConfigurationError } from "../core/regression/check.js";
import { runFixCommand } from "./commands/fix.js";
import { runInitCommand } from "./commands/init.js";
import { runPromptCommand } from "./commands/prompt.js";
import { launchTui } from "../tui/index.js";

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
    .command("tui")
    .description("Launch the interactive terminal user interface")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-s, --session <path>", "Path to agent session JSON trace")
    .action(async (options) => {
      await launchTui({ sessionPath: options.session, cwd: options.cwd });
    });

  program
    .command("scan")
    .description("Scan repository and output agent efficiency report")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--json", "Output results as JSON")
    .option("-s, --session <path>", "Path to agent session JSON trace")
    .action(async (options) => {
      await runScanCommand(options);
    });

  program
    .command("check")
    .description("Verify repository meets minimum agent efficiency score")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-m, --min-score <score>", "Minimum acceptable score (0-100)", "75")
    .option("--baseline <ref>", "Git ref to compare against")
    .option("--max-regression <points>", "Maximum allowed score regression (0-100)", "0")
    .option("--fail-on <severity>", "Fail on new findings at or above severity")
    .option("-s, --session <path>", "Path to agent session JSON trace")
    .option("--json", "Output the check result as JSON")
    .action(async (options) => {
      try {
        const result = await runCheckCommand(options);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = error instanceof CheckConfigurationError ? error.exitCode : 1;
      }
    });

  program
    .command("fix")
    .description("Review and apply deterministic fixes to repository instructions")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("--safe", "Apply all safe fixes automatically without interactive prompts")
    .action(async (options) => {
      await runFixCommand(options);
    });

  program
    .command("init")
    .description("Initialize an optimized AGENTS.md template for the repository")
    .action(async () => {
      await runInitCommand();
    });

  program
    .command("prompt [finding-id]")
    .description("Generate or copy deterministic AI Agent fix prompts for findings")
    .option("-c, --cwd <path>", "Repository working directory")
    .option("-s, --session <path>", "Path to agent session JSON trace")
    .option("--copy", "Copy the generated fix prompt to clipboard")
    .option("--all", "Generate fix prompts for all qualified issues")
    .action(async (findingId, options) => {
      await runPromptCommand(findingId, options);
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
