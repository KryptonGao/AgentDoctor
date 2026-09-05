import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { getGitRoot } from "../../shared/git.js";

export async function runInitCommand() {
  const repoRoot = getGitRoot(process.cwd());
  const targetFile = path.join(repoRoot, "AGENTS.md");

  if (fs.existsSync(targetFile)) {
    console.log(pc.yellow(`\nAGENTS.md already exists at ${targetFile}.\n`));
    return;
  }

  // Detect project properties
  let packageManager = "npm";
  if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) packageManager = "yarn";
  else if (fs.existsSync(path.join(repoRoot, "bun.lockb"))) packageManager = "bun";

  const template = `# AGENTS.md

## Repository Overview
Concise architecture overview for AI Coding Agents.

## Critical Commands
- Install: \`${packageManager} install\`
- Build: \`${packageManager} run build\`
- Test: \`${packageManager} test\`
- Typecheck: \`${packageManager} run typecheck\`
- Lint: \`${packageManager} run lint\`

## Architecture & Conventions
- Source code is encapsulated in \`src/\`.
- Never manually edit generated files in \`dist/\` or \`build/\`.
- Follow strict typing and modular architecture.
`;

  fs.writeFileSync(targetFile, template, "utf-8");
  console.log(pc.green(`\n✓ Created standardized high-signal AGENTS.md at ${targetFile}\n`));
}
