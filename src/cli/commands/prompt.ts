import { scanRepository } from "../../core/scan/scanner.js";
import { generateFixPrompt, generateAllFixPrompts } from "../../core/prompt/promptGenerator.js";
import { copyToClipboard } from "../../shared/clipboard.js";
import { Finding } from "../../core/types.js";
import pc from "picocolors";

export interface PromptCommandOptions {
  cwd?: string;
  session?: string;
  copy?: boolean;
  all?: boolean;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
}

function findFindingById(findings: Finding[], targetId: string): Finding | undefined {
  const normTarget = targetId.toLowerCase().trim();

  // Search top-level
  for (const f of findings) {
    if (f.id.toLowerCase() === normTarget || f.ruleId.toLowerCase() === normTarget) {
      return f;
    }
  }

  // Search children
  for (const f of findings) {
    if (f.children) {
      for (const c of f.children) {
        if (c.id.toLowerCase() === normTarget || c.ruleId.toLowerCase() === normTarget) {
          return c;
        }
      }
    }
  }

  // Partial match fallback
  for (const f of findings) {
    if (f.id.toLowerCase().includes(normTarget) || f.ruleId.toLowerCase().includes(normTarget)) {
      return f;
    }
  }

  return undefined;
}

export async function runPromptCommand(findingId?: string, options: PromptCommandOptions = {}) {
  const result = await scanRepository({
    cwd: options.cwd,
    sessionPath: options.session,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
  });

  if (options.all) {
    const prompt = generateAllFixPrompts(result.findings);

    if (options.copy) {
      const res = await copyToClipboard(prompt);
      if (res.success) {
        console.log(pc.green("✓ Fix prompts for all qualified issues copied to clipboard!"));
      } else {
        console.warn(pc.yellow(`Failed to access clipboard: ${res.error || "Unknown error"}`));
        console.log("\nFix Prompts:\n");
        console.log(prompt);
      }
    } else {
      console.log(prompt);
    }
    return;
  }

  if (!findingId) {
    console.error(pc.red("Error: Please specify a finding ID or use --all to generate prompts for all qualified findings."));
    console.log(pc.dim("\nExamples:"));
    console.log(pc.dim("  agentdoctor prompt context/stale-path-3"));
    console.log(pc.dim("  agentdoctor prompt context/stale-path-3 --copy"));
    console.log(pc.dim("  agentdoctor prompt --all"));
    process.exit(1);
  }

  const finding = findFindingById(result.findings, findingId);
  if (!finding) {
    console.error(pc.red(`Error: Finding "${findingId}" not found in current repository scan.`));
    console.log(pc.dim("Run `agentdoctor scan` or `agentdoctor scan --json` to list available findings."));
    process.exit(1);
  }

  const prompt = finding.fixPrompt || generateFixPrompt(finding);

  if (options.copy) {
    const res = await copyToClipboard(prompt);
    if (res.success) {
      console.log(pc.green(`✓ Fix prompt for "${finding.title}" copied to clipboard!`));
    } else {
      console.warn(pc.yellow(`Failed to access clipboard: ${res.error || "Unknown error"}`));
      console.log("\nFix Prompt:\n");
      console.log(prompt);
    }
  } else {
    console.log(prompt);
  }
}
