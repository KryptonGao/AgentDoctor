import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectProfile, VerificationItem } from "../types.js";
import { detectNodePackageManager } from "../../analyzers/verification/nodeScripts.js";

const GENERATED_DIR_NAMES = ["generated", "dist", "build", "openapi-generated", ".next", "out", "target"];

export function detectGeneratedDirectories(repoRoot: string): string[] {
  return GENERATED_DIR_NAMES.filter((name) => fs.existsSync(path.join(repoRoot, name)));
}

function bulletList(values: string[], empty = "none detected"): string {
  if (values.length === 0) return empty;
  return values.map((value) => `\`${value}\``).join(", ");
}

function formatCommand(item: VerificationItem | undefined, fallback?: string): string | undefined {
  if (item?.command && (item.status === "healthy" || item.status === "warning")) {
    return item.command;
  }
  return fallback;
}

function displayCommand(raw: string | undefined, packageManager: string, scriptHint?: string): string | undefined {
  if (!raw) return undefined;
  if (/^(?:npm|pnpm|yarn|bun|cargo|go|pytest|ruff|mypy|pre-commit)\b/.test(raw)) return raw;
  if (scriptHint) {
    if (packageManager === "npm" && scriptHint === "test") return "npm test";
    return `${packageManager} run ${scriptHint}`;
  }
  return raw;
}

export function generateAgentsMarkdown(options: {
  repoRoot: string;
  profile: ProjectProfile;
  verificationStatus: VerificationItem[];
  repositoryName?: string;
}): string {
  const { repoRoot, profile, verificationStatus } = options;
  const name = options.repositoryName || path.basename(repoRoot);
  const manager = detectNodePackageManager(repoRoot);
  const byName = Object.fromEntries(verificationStatus.map((item) => [item.name, item])) as Record<string, VerificationItem>;
  const generatedDirs = detectGeneratedDirectories(repoRoot);
  const sourceRoots = profile.packageRoots.length > 0 ? profile.packageRoots : ["src"];

  const install = profile.ecosystems.includes("node") || profile.primaryEcosystem === "node"
    ? `${manager} install`
    : profile.primaryEcosystem === "python"
      ? "pip install -e ."
      : profile.primaryEcosystem === "rust"
        ? "cargo fetch"
        : profile.primaryEcosystem === "go"
          ? "go mod download"
          : undefined;

  const test = displayCommand(formatCommand(byName.test), manager, "test")
    ?? (profile.primaryEcosystem === "python" ? "pytest" : profile.primaryEcosystem === "rust" ? "cargo test" : profile.primaryEcosystem === "go" ? "go test ./..." : undefined);
  const lint = displayCommand(formatCommand(byName.lint), manager, "lint");
  const typecheck = displayCommand(formatCommand(byName.typecheck), manager, "typecheck");
  const build = displayCommand(formatCommand(byName.build), manager, "build")
    ?? (profile.primaryEcosystem === "rust" ? "cargo build" : profile.primaryEcosystem === "go" ? "go build ./..." : undefined);

  const commandLines = [
    install ? `- Install: \`${install}\`` : undefined,
    build ? `- Build: \`${build}\`` : undefined,
    test ? `- Test: \`${test}\`` : undefined,
    typecheck ? `- Typecheck: \`${typecheck}\`` : undefined,
    lint ? `- Lint: \`${lint}\`` : undefined,
    "- Verify (opt-in, executes commands): `npx agentdoctor verify`",
    "- Security audit: `npx agentdoctor audit`",
  ].filter((line): line is string => Boolean(line));

  const overviewBits = [
    profile.summary || `${name} repository`,
    profile.isMonorepo ? "This is a monorepo." : undefined,
    `Primary ecosystem: ${profile.primaryEcosystem}.`,
    profile.languages.length > 0 ? `Languages: ${profile.languages.join(", ")}.` : undefined,
  ].filter(Boolean);

  const layoutLines = [
    `- Package roots: ${bulletList(sourceRoots)}`,
    `- Entry points: ${bulletList(profile.entryPoints)}`,
    `- Test roots: ${bulletList(profile.testRoots)}`,
  ];

  const generatedRule = generatedDirs.length > 0
    ? `- Never manually edit generated files in ${generatedDirs.map((dir) => `\`${dir}/\``).join(", ")}.`
    : "- Never manually edit generated files in `dist/` or `build/`.";

  return `# AGENTS.md

## Repository Overview
${overviewBits.join(" ")}

## Layout
${layoutLines.join("\n")}

## Critical Commands
${commandLines.join("\n")}

## Architecture & Conventions
- Source code is encapsulated in ${sourceRoots.map((root) => `\`${root}/\``).join(", ")}.
${generatedRule}
- Follow strict typing and modular architecture.
- Keep agent-specific overrides in shim files; do not duplicate this command table.
`;
}
