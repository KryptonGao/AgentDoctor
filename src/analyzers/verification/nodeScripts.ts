import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectProfile } from "../../core/types.js";

export function findNodePackagePaths(repoRoot: string, profile: ProjectProfile): string[] {
  const configured = profile.configFiles.node?.filter((file) => path.basename(file) === "package.json") || [];
  const candidates = ["package.json", ...configured].filter((file, index, all) => all.indexOf(file) === index);
  return candidates.filter((file) => fs.existsSync(path.join(repoRoot, file)));
}

export interface NodePackageScripts {
  scripts: Record<string, string>;
  sources: Record<string, string>;
  rootScripts: Record<string, string>;
}

export function readNodePackageScripts(repoRoot: string, profile: ProjectProfile): NodePackageScripts {
  const paths = findNodePackagePaths(repoRoot, profile);
  const scripts: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const rootScripts: Record<string, string> = {};

  for (const packagePath of paths) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf-8")) as {
        scripts?: Record<string, unknown>;
      };
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

export function isTestScriptName(name: string): boolean {
  return name === "test" || /^test(?:$|[:.-])/.test(name) || /(?:^|:)test(?:$|[:.-])/.test(name);
}

export function isPlaceholderTestCommand(command: string): boolean {
  return command.includes("no test specified") && command.includes("exit 1");
}

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export function detectNodePackageManager(repoRoot: string): NodePackageManager {
  if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repoRoot, "bun.lock")) || fs.existsSync(path.join(repoRoot, "bun.lockb"))) {
    return "bun";
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      packageManager?: string;
    };
    const field = pkg.packageManager || "";
    if (field.startsWith("pnpm")) return "pnpm";
    if (field.startsWith("yarn")) return "yarn";
    if (field.startsWith("bun")) return "bun";
  } catch {
    // ignore
  }
  return "npm";
}

export function packageManagerRunArgv(manager: NodePackageManager, scriptName: string): string[] {
  if (manager === "npm") {
    return scriptName === "test" ? ["npm", "test"] : ["npm", "run", scriptName];
  }
  if (manager === "yarn") {
    return ["yarn", "run", scriptName];
  }
  if (manager === "pnpm") {
    return ["pnpm", "run", scriptName];
  }
  return ["bun", "run", scriptName];
}
