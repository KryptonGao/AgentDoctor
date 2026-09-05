import * as readline from "node:readline";
import pc from "picocolors";
import { scanRepository } from "../../core/scan/scanner.js";
import { applyFix, applySafeFixes } from "../../core/fix/fixEngine.js";

export interface FixCommandOptions {
  safe?: boolean;
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

export async function runFixCommand(options: FixCommandOptions = {}) {
  const initialResult = await scanRepository();
  const fixes = initialResult.availableFixes;

  if (fixes.length === 0) {
    console.log(pc.green("\n✓ No fixes available. Repository instructions are up-to-date!\n"));
    return;
  }

  console.log(pc.bold(`\nFound ${fixes.length} available fixes:`));

  if (options.safe) {
    const safeFixes = fixes.filter((f) => f.isSafe);
    console.log(pc.cyan(`Applying ${safeFixes.length} safe fixes automatically...\n`));
    const { applied, failed } = applySafeFixes(safeFixes);
    for (const f of applied) {
      console.log(pc.green(`  ✓ Applied: ${f.title} (${f.file})`));
    }
    for (const f of failed) {
      console.log(pc.red(`  ✕ Failed: ${f.fix.title} - ${f.error}`));
    }

    const postScan = await scanRepository();
    console.log(pc.bold(pc.green(`\nScore improved: ${initialResult.overallScore} → ${postScan.overallScore}\n`)));
    return;
  }

  // Interactive review for each fix
  let appliedCount = 0;
  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    console.log(pc.cyan(`\n[Fix ${i + 1}/${fixes.length}] ${pc.bold(fix.title)}`));
    console.log(`File: ${pc.yellow(fix.file)}`);
    console.log(`Description: ${fix.description}`);
    console.log(`Safety: ${fix.isSafe ? pc.green("Safe (Deterministic)") : pc.yellow("Review recommended")}`);

    if (fix.diff) {
      console.log(pc.dim("\nProposed Diff:"));
      const diffLines = fix.diff.split("\n");
      for (const line of diffLines) {
        if (line.startsWith("+")) {
          console.log(pc.green(line));
        } else if (line.startsWith("-")) {
          console.log(pc.red(line));
        } else {
          console.log(pc.dim(line));
        }
      }
    }

    const ok = await askConfirmation(pc.bold("\nApply this fix? (y/N): "));
    if (ok) {
      const res = applyFix(fix);
      if (res.success) {
        console.log(pc.green("✓ Fix applied successfully."));
        appliedCount++;
      } else {
        console.log(pc.red(`✕ Failed to apply fix: ${res.error}`));
      }
    } else {
      console.log(pc.dim("Skipped."));
    }
  }

  if (appliedCount > 0) {
    const postScan = await scanRepository();
    console.log(pc.bold(pc.green(`\nAll done! Score improved: ${initialResult.overallScore} → ${postScan.overallScore}\n`)));
  } else {
    console.log(pc.dim("\nNo fixes were applied.\n"));
  }
}
