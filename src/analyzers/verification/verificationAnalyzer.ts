import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import { Finding, Fix, VerificationItem, ProjectProfile } from "../../core/types.js";
import { createFix } from "../../core/fix/fixEngine.js";

function findNodePackagePaths(repoRoot: string, profile: ProjectProfile): string[] {
  const configured = profile.configFiles.node?.filter((file) => path.basename(file) === "package.json") || [];
  const candidates = ["package.json", ...configured].filter((file, index, all) => all.indexOf(file) === index);
  return candidates.filter((file) => fs.existsSync(path.join(repoRoot, file)));
}

interface NodePackageScripts {
  scripts: Record<string, string>;
  sources: Record<string, string>;
  rootScripts: Record<string, string>;
}

function readNodePackageScripts(repoRoot: string, profile: ProjectProfile): NodePackageScripts {
  const paths = findNodePackagePaths(repoRoot, profile);
  const scripts: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const rootScripts: Record<string, string> = {};

  // Prefer root workspace scripts, then use a nested package as a fallback.
  // This keeps ordinary monorepos from being reported as missing a workflow
  // merely because the root package delegates it to a workspace package.
  for (const packagePath of paths) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf-8")) as { scripts?: Record<string, unknown> };
      for (const [name, command] of Object.entries(pkg.scripts || {})) {
        if (typeof command === "string" && !scripts[name]) {
          scripts[name] = command;
          sources[name] = packagePath;
        }
        if (packagePath === "package.json" && typeof command === "string") {
          rootScripts[name] = command;
        }
      }
    } catch {
      // ignore malformed package manifests and continue with other workspaces
    }
  }

  return { scripts, sources, rootScripts };
}

function isTestScriptName(name: string): boolean {
  return name === "test" || /^test(?:$|[:.-])/.test(name) || /(?:^|:)test(?:$|[:.-])/.test(name);
}

function isPlaceholderTestCommand(command: string): boolean {
  return command.includes("no test specified") && command.includes("exit 1");
}

function discoverInstructionFiles(repoRoot: string): string[] {
  return fg.sync(
    [
      "**/AGENTS.md",
      "**/CLAUDE.md",
      "**/.cursorrules",
      "**/.cursor/rules/**/*.mdc",
      "**/.cursor/rules/**/*.md",
      ".cursor/rules/**/*.mdc",
      ".cursor/rules/**/*.md",
      "**/.github/copilot-instructions.md",
    ],
    {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/target/**",
        "**/out/**",
        "**/coverage/**",
        "**/generated/**",
        "**/vendor/**",
        "**/.next/**",
      ],
    }
  ).sort((a, b) => a.localeCompare(b));
}

export async function analyzeVerification(
  repoRoot: string,
  profile: ProjectProfile
): Promise<{
  findings: Finding[];
  fixes: Fix[];
  verificationStatus: VerificationItem[];
}> {
  const findings: Finding[] = [];
  const fixes: Fix[] = [];

  const statusMap: Record<"test" | "lint" | "typecheck" | "build" | "ci", VerificationItem> = {
    test: { name: "test", status: "unknown" },
    lint: { name: "lint", status: "unknown" },
    typecheck: { name: "typecheck", status: "not_applicable" },
    build: { name: "build", status: "not_applicable" },
    ci: { name: "ci", status: "unknown" },
  };

  // Discover CI workflow commands across all ecosystems
  const ciWorkflowsDir = path.join(repoRoot, ".github", "workflows");
  let ciTestCommand: string | undefined;
  if (fs.existsSync(ciWorkflowsDir)) {
    try {
      const files = fs.readdirSync(ciWorkflowsDir).sort((a, b) => a.localeCompare(b));
      for (const cf of files) {
        if (cf.endsWith(".yml") || cf.endsWith(".yaml")) {
          const content = fs.readFileSync(path.join(ciWorkflowsDir, cf), "utf-8");
          const runMatch = content.match(
            /run:\s*([^\n#]*(?:test|pytest|cargo\s+test|go\s+test|make\s+test)[^\n#]*)/i
          );
          if (runMatch) {
            ciTestCommand = runMatch[1].trim();
            statusMap.ci = {
              name: "ci",
              status: "healthy",
              command: ciTestCommand,
              source: `.github/workflows/${cf}`,
              detail: `CI runs: "${ciTestCommand}"`,
            };
            break;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!ciTestCommand) {
    statusMap.ci = {
      name: "ci",
      status: "warning",
      detail: "No GitHub Actions CI test workflow detected",
    };
  }

  // Handle based on Primary Ecosystem
  if (profile.primaryEcosystem === "python") {
    // 1. Python Test
    const hasPytest =
      profile.testRoots.length > 0 ||
      fs.existsSync(path.join(repoRoot, "pytest.ini")) ||
      fs.existsSync(path.join(repoRoot, "tox.ini"));

    let pyprojectHasPytest = false;
    let pyprojectHasMypy = false;
    let pyprojectHasRuff = false;
    let pyprojectHasBuild = false;

    const pyprojectPath = path.join(repoRoot, "pyproject.toml");
    if (fs.existsSync(pyprojectPath)) {
      const pyprojectContent = fs.readFileSync(pyprojectPath, "utf-8");
      if (pyprojectContent.includes("pytest") || pyprojectContent.includes("[tool.pytest")) {
        pyprojectHasPytest = true;
      }
      if (pyprojectContent.includes("mypy") || pyprojectContent.includes("pyright") || pyprojectContent.includes("[tool.mypy")) {
        pyprojectHasMypy = true;
      }
      if (pyprojectContent.includes("ruff") || pyprojectContent.includes("flake8") || pyprojectContent.includes("[tool.ruff")) {
        pyprojectHasRuff = true;
      }
      if (pyprojectContent.includes("[build-system]") || pyprojectContent.includes("build-backend")) {
        pyprojectHasBuild = true;
      }
    }

    if (hasPytest || pyprojectHasPytest) {
      statusMap.test = {
        name: "test",
        status: "healthy",
        command: "pytest",
        detail: "Configured with pytest / test suite",
      };
    } else {
      statusMap.test = {
        name: "test",
        status: "warning",
        detail: "No test configuration (pytest / unittest) found",
      };
      findings.push({
        id: "verif-missing-python-test",
        ruleId: "verification/missing-test",
        category: "verification",
        severity: "high",
        confidence: 0.80,
        title: "Missing test command for Python project",
        description: "No pytest or unittest configuration found. Agents cannot verify code modifications.",
        evidence: [{ file: "pyproject.toml", source: "filesystem" }],
        recommendation: "Add pytest configuration and tests/ directory.",
      });
    }

    // 2. Python Lint
    const hasPrecommit = fs.existsSync(path.join(repoRoot, ".pre-commit-config.yaml"));
    if (pyprojectHasRuff || hasPrecommit || fs.existsSync(path.join(repoRoot, "ruff.toml"))) {
      statusMap.lint = {
        name: "lint",
        status: "healthy",
        command: pyprojectHasRuff ? "ruff check ." : "pre-commit run",
        detail: "Linter configured (ruff / pre-commit)",
      };
    } else {
      statusMap.lint = {
        name: "lint",
        status: "unknown",
        detail: "No Python linter (ruff, flake8) detected",
      };
    }

    // 3. Python Typecheck
    if (pyprojectHasMypy || fs.existsSync(path.join(repoRoot, "mypy.ini"))) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "healthy",
        command: "mypy .",
        detail: "Static type checker (mypy/pyright) configured",
      };
    } else {
      statusMap.typecheck = {
        name: "typecheck",
        status: "not_applicable",
        detail: "Type checker (mypy/pyright) not configured for Python project",
      };
    }

    // 4. Python Build
    if (pyprojectHasBuild || fs.existsSync(path.join(repoRoot, "setup.py"))) {
      statusMap.build = {
        name: "build",
        status: "healthy",
        command: "python -m build",
        detail: "Package build system configured",
      };
    } else {
      statusMap.build = {
        name: "build",
        status: "not_applicable",
        detail: "Application project does not define package build target",
      };
    }
  } else if (profile.primaryEcosystem === "rust") {
    statusMap.test = { name: "test", status: "healthy", command: "cargo test", detail: "Standard Cargo test" };
    statusMap.lint = { name: "lint", status: "healthy", command: "cargo clippy", detail: "Standard Cargo clippy" };
    statusMap.typecheck = { name: "typecheck", status: "healthy", command: "cargo check", detail: "Cargo compiler typecheck" };
    statusMap.build = { name: "build", status: "healthy", command: "cargo build", detail: "Standard Cargo build" };
  } else if (profile.primaryEcosystem === "go") {
    statusMap.test = { name: "test", status: "healthy", command: "go test ./...", detail: "Standard Go test" };
    statusMap.lint = { name: "lint", status: "healthy", command: "go vet ./...", detail: "Standard Go vet" };
    statusMap.typecheck = { name: "typecheck", status: "healthy", command: "go build", detail: "Go compiler typecheck" };
    statusMap.build = { name: "build", status: "healthy", command: "go build ./...", detail: "Standard Go build" };
  } else if (profile.primaryEcosystem === "node" || profile.ecosystems.includes("node")) {
    // Node.js, including mixed projects where Node is not the primary runtime.
    const packageScriptData = readNodePackageScripts(repoRoot, profile);
    const packageScripts = packageScriptData.scripts;
    const packageScriptSources = packageScriptData.sources;
    const rootTest = Object.entries(packageScriptData.rootScripts)
      .filter(([name]) => isTestScriptName(name))
      .sort(([a], [b]) => (a === "test" ? -1 : b === "test" ? 1 : a.localeCompare(b)))
      .map(([name, command]) => ({ name, command }))[0];
    const nestedTests = Object.entries(packageScripts)
      .filter(([name]) => isTestScriptName(name) && packageScriptSources[name] !== "package.json")
      .sort(([a], [b]) => (a === "test" ? -1 : b === "test" ? 1 : a.localeCompare(b)))
      .map(([name, command]) => ({ name, command }));

    // Evaluate test command
    const configuredTest = rootTest || nestedTests.find(({ command }) => !isPlaceholderTestCommand(command)) || nestedTests[0];

    if (configuredTest) {
      if (isPlaceholderTestCommand(configuredTest.command)) {
        statusMap.test = {
          name: "test",
          status: "broken",
          command: configuredTest.command,
          detail: "Default unconfigured npm placeholder test script",
        };
        findings.push({
          id: "verif-placeholder-test",
          ruleId: "verification/placeholder-test",
          category: "verification",
          severity: "high",
          confidence: 0.95,
          title: "Placeholder test script fails verification",
          description: 'package.json contains placeholder "exit 1". Any agent running the test suite will fail automatically.',
            evidence: [
            {
              file: packageScriptSources[configuredTest.name] || "package.json",
              snippet: `"${configuredTest.name}": "${configuredTest.command}"`,
              source: packageScriptSources[configuredTest.name] || "package.json",
            },
          ],
          recommendation: "Configure a working test runner (e.g. vitest, jest, or mocha).",
        });
      } else {
        statusMap.test = {
          name: "test",
          status: "healthy",
          command: configuredTest.command,
          detail: `Defined in ${packageScriptSources[configuredTest.name] || "package.json"}: "${configuredTest.command}"`,
        };
      }
    } else {
      statusMap.test = {
        name: "test",
        status: "broken",
        detail: "No test script found in package.json",
      };
      findings.push({
        id: "verif-missing-test",
        ruleId: "verification/missing-test",
        category: "verification",
        severity: "high",
        confidence: 0.90,
        title: "Missing test command",
        description: "No test command found in package.json. AI agents cannot verify functional correctness of code modifications without test feedback.",
        evidence: [{ file: "package.json", source: "package.json" }],
        recommendation: "Add a test script (e.g. 'test': 'vitest run') to package.json.",
      });
    }

    // Evaluate lint command
    if (packageScripts.lint) {
      statusMap.lint = {
        name: "lint",
        status: "healthy",
        command: packageScripts.lint,
        detail: `Defined in package.json: "${packageScripts.lint}"`,
      };
    } else {
      statusMap.lint = {
        name: "lint",
        status: "unknown",
        detail: "No lint script found",
      };
    }

    // Evaluate typecheck command
    const hasTs = fs.existsSync(path.join(repoRoot, "tsconfig.json"));
    const typecheckCmd = packageScripts.typecheck || packageScripts["type-check"] || packageScripts.tsc;
    const inferredTypecheck = Object.entries(packageScripts).find(([name, command]) =>
      /type[-:]?check/i.test(name) || /\b(?:tsc|tsgo)\b/.test(command) || (hasTs && name === "compile")
    )?.[1];
    if (typecheckCmd || inferredTypecheck) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "healthy",
        command: typecheckCmd || inferredTypecheck,
        detail: typecheckCmd
          ? `Defined in package.json: "${typecheckCmd}"`
          : `Inferred from a compiler-backed package script: "${inferredTypecheck}"`,
      };
    } else if (hasTs) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "warning",
        detail: "TypeScript project missing explicit typecheck script",
      };
      findings.push({
        id: "verif-missing-typecheck",
        ruleId: "verification/missing-typecheck",
        category: "verification",
        severity: "medium",
        confidence: 0.85,
        title: "TypeScript repository lacks typecheck script",
        description: 'Repository uses TypeScript (tsconfig.json exists) but package.json has no "typecheck" script. Agents need a fast type checking loop (tsc --noEmit) to catch compile errors early.',
        evidence: [{ file: "tsconfig.json", source: "filesystem" }],
        recommendation: 'Add `"typecheck": "tsc --noEmit"` to package.json scripts.',
      });
    } else {
      statusMap.typecheck = {
        name: "typecheck",
        status: "not_applicable",
        detail: "Non-TypeScript JavaScript project",
      };
    }

    // Evaluate build command
    if (packageScripts.build) {
      statusMap.build = {
        name: "build",
        status: "healthy",
        command: packageScripts.build,
        detail: `Defined in package.json: "${packageScripts.build}"`,
      };
    } else {
      statusMap.build = {
        name: "build",
        status: "not_applicable",
        detail: "No build command defined",
      };
    }
  } else {
    // Unknown repositories do not get a speculative Node.js failure. There is
    // not enough evidence to claim that a test loop is missing, so leave the
    // checks as N/A and keep the score/report quiet.
    statusMap.test = { name: "test", status: "not_applicable", detail: "No supported ecosystem detected" };
    statusMap.lint = { name: "lint", status: "not_applicable", detail: "No supported ecosystem detected" };
    statusMap.typecheck = { name: "typecheck", status: "not_applicable", detail: "No supported ecosystem detected" };
    statusMap.build = { name: "build", status: "not_applicable", detail: "No supported ecosystem detected" };
  }

  // Compare instruction verification commands vs discovered test command & CI
  const instructionFiles = discoverInstructionFiles(repoRoot);
  for (const instName of instructionFiles) {
    const instPath = path.join(repoRoot, instName);
    if (!fs.existsSync(instPath)) continue;

    const content = fs.readFileSync(instPath, "utf-8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, idx) => {
      // 1. If it's a Python project, detect instructions wrongly telling agent to run `npm test`
      if (profile.primaryEcosystem === "python" && !profile.ecosystems.includes("node")) {
        const npmMatch = line.match(/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test/i);
        if (npmMatch) {
          findings.push({
            id: `verif-ecosystem-mismatch-${instName}-${idx + 1}`,
            ruleId: "verification/ecosystem-command-mismatch",
            category: "verification",
            severity: "high",
            confidence: 0.95,
            title: `Instruction references Node test command in Python repository`,
            description: `${instName} instructs the agent to run "${npmMatch[0]}", but this is a Python repository configured for pytest. Coding agents will fail when running this command.`,
            evidence: [
              {
                file: instName,
                line: idx + 1,
                snippet: line.trim(),
                source: instName,
              },
              {
                file: profile.configFiles.python?.[0] || "pyproject.toml",
                snippet: `Primary ecosystem: Python`,
                source: "ProjectProfile",
              },
            ],
            recommendation: `Update instruction to use "pytest" instead of "${npmMatch[0]}".`,
          });
        }
      }

      // 2. Check CI mismatch
      if (ciTestCommand) {
        const cmdMatch = line.match(/(?:(?:`)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([a-zA-Z0-9:\-_]+)(?:`)|(?:run|use)\s+(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([a-zA-Z0-9:\-_]+))/i);
        if (cmdMatch) {
          const fullCmd = cmdMatch[0].replace(/[`]/g, "").trim();
          const scriptName = cmdMatch[1] || cmdMatch[2];
          if (scriptName === "test" && !ciTestCommand.includes(fullCmd)) {
            const fix = createFix({
              id: `fix-ci-mismatch-${instName}-${idx + 1}`,
              title: `Align test command in ${instName} with CI`,
              description: `Update command from "${fullCmd}" to CI standard "${ciTestCommand}"`,
              isSafe: true,
              file: instPath,
              oldText: fullCmd,
              newText: ciTestCommand,
              fullOldContent: content,
            });
            fixes.push(fix);

            findings.push({
              id: `verif-ci-mismatch-${instName}-${idx + 1}`,
              ruleId: "verification/command-consistency",
              category: "verification",
              severity: "high",
              confidence: 0.90,
              title: "Verification command mismatch with CI",
              description: `${instName} instructs the agent to run "${fullCmd}", whereas CI runs "${ciTestCommand}". Discrepancies lead to local passes that fail in CI.`,
              evidence: [
                {
                  file: instName,
                  line: idx + 1,
                  snippet: line.trim(),
                  source: instName,
                },
                {
                  file: statusMap.ci.source || ".github/workflows",
                  snippet: `CI runs: ${ciTestCommand}`,
                  source: statusMap.ci.source || "CI",
                },
              ],
              recommendation: `Update ${instName} to run "${ciTestCommand}" to match CI.`,
              fix,
            });
          }
        }
      }
    });
  }

  return {
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    fixes,
    verificationStatus: ["test", "lint", "typecheck", "build", "ci"].map((name) => statusMap[name as keyof typeof statusMap]),
  };
}
