import * as readline from "node:readline";
import pc from "picocolors";
import { Fix } from "../../core/types.js";
import { getGitRoot } from "../../shared/git.js";
import { runFixLoop } from "../../core/fix/loop.js";
import { rollbackFixJournal } from "../../core/fix/journal.js";
import { formatFixLoopResult } from "../formatters/fix.js";

export interface FixCommandOptions {
  safe?: boolean;
  cwd?: string;
  generateAgents?: boolean;
  shims?: boolean;
  verify?: boolean;
  verifyAll?: boolean;
  rollback?: boolean;
  pr?: boolean;
  json?: boolean;
}

function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const norm = answer.trim().toLowerCase();
      resolve(norm === "y" || norm === "yes");
    });
  });
}

async function selectInteractively(fixes: Fix[]): Promise<Fix[]> {
  const selected: Fix[] = [];
  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    const files = (fix.changes && fix.changes.length > 0)
      ? fix.changes.map((change) => change.path).join(", ")
      : fix.file;
    console.log(pc.cyan(`\n[Fix ${i + 1}/${fixes.length}] ${pc.bold(fix.title)}`));
    console.log(`File: ${pc.yellow(files)}`);
    console.log(`Description: ${fix.description}`);
    console.log(`Safety: ${fix.isSafe ? pc.green("Safe (Deterministic)") : pc.yellow("Review recommended")}`);

    if (fix.diff) {
      console.log(pc.dim("\nProposed Diff:"));
      for (const line of fix.diff.split("\n")) {
        if (line.startsWith("+")) console.log(pc.green(line));
        else if (line.startsWith("-")) console.log(pc.red(line));
        else console.log(pc.dim(line));
      }
    }

    const ok = await askConfirmation(pc.bold("\nApply this fix? (y/N): "));
    if (ok) selected.push(fix);
    else console.log(pc.dim("Skipped."));
  }
  return selected;
}

export async function runFixCommand(options: FixCommandOptions = {}) {
  const repoRoot = getGitRoot(options.cwd || process.cwd());

  if (options.rollback) {
    const result = rollbackFixJournal(repoRoot);
    if (result.error) {
      console.log(pc.yellow(`\n${result.error}\n`));
      process.exitCode = 1;
      return;
    }
    console.log(pc.green(`\n✓ Rolled back ${result.restored.length} file(s): ${result.restored.join(", ")}\n`));
    return;
  }

  const loop = await runFixLoop({
    cwd: repoRoot,
    safe: options.safe,
    generateAgents: options.generateAgents,
    shims: options.shims,
    verify: options.verify || options.verifyAll,
    verifyAll: options.verifyAll,
    createPullRequest: options.pr,
    selectFixes: options.safe ? undefined : selectInteractively,
  });

  if (options.json) {
    console.log(JSON.stringify({
      applied: loop.applied.map((fix) => fix.id),
      failed: loop.failed.map((item) => ({ id: item.fix.id, error: item.error })),
      rolledBack: loop.rolledBack,
      rollbackReason: loop.rollbackReason,
      journalId: loop.journalId,
      initialScore: loop.initial.overallScore,
      finalScore: loop.final?.overallScore,
      verify: loop.verify,
      pullRequest: loop.pullRequest,
      generatedAgents: loop.generatedAgents,
      generatedShims: loop.generatedShims,
    }, null, 2));
  } else {
    console.log(formatFixLoopResult(loop));
  }

  if (loop.rolledBack || loop.failed.length > 0 && loop.applied.length === 0) {
    process.exitCode = 1;
  }
}
