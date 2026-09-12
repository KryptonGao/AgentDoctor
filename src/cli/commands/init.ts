import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { getGitRoot } from "../../shared/git.js";
import { detectProjectProfile } from "../../core/project/profile.js";
import { analyzeVerification } from "../../analyzers/verification/verificationAnalyzer.js";
import { generateAgentsMarkdown } from "../../core/fix/agentsMarkdown.js";
import { applyFixes } from "../../core/fix/fixEngine.js";
import { buildAgentShimFix } from "../../core/fix/bootstrap.js";

export interface InitCommandOptions {
  force?: boolean;
  shims?: boolean;
  cwd?: string;
}

export async function runInitCommand(options: InitCommandOptions = {}) {
  const repoRoot = getGitRoot(options.cwd || process.cwd());
  const targetFile = path.join(repoRoot, "AGENTS.md");
  const profile = detectProjectProfile(repoRoot);
  const verification = await analyzeVerification(repoRoot, profile);
  const markdown = generateAgentsMarkdown({
    repoRoot,
    profile,
    verificationStatus: verification.verificationStatus,
    repositoryName: path.basename(repoRoot),
  });

  if (fs.existsSync(targetFile) && !options.force) {
    console.log(pc.yellow(`\nAGENTS.md already exists at ${targetFile}. Use --force to regenerate from the live project profile.\n`));
  } else {
    fs.writeFileSync(targetFile, markdown, "utf-8");
    console.log(pc.green(`\n✓ Wrote AGENTS.md from repository structure at ${targetFile}\n`));
  }

  if (options.shims) {
    const shimFix = buildAgentShimFix(repoRoot);
    if (!shimFix) {
      console.log(pc.dim("All agent shim files already exist.\n"));
      return;
    }
    const result = applyFixes([shimFix], { repoRoot, journal: true });
    if (result.failed.length > 0) {
      console.log(pc.red(`✕ Failed to write shims: ${result.failed[0].error}\n`));
      return;
    }
    for (const change of shimFix.changes || []) {
      console.log(pc.green(`  ✓ ${path.relative(repoRoot, change.path)}`));
    }
    console.log("");
  }
}
