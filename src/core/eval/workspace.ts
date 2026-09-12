import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const WORKSPACE_PREFIX = "agentdoctor-eval-workspace-";

export interface EvalWorkspace {
  root: string;
  /** Initial commit used as the immutable review-churn baseline. */
  baselineRef?: string;
  cleanup(): void;
}

function shouldCopy(sourceRoot: string, sourcePath: string): boolean {
  const relative = path.relative(sourceRoot, sourcePath).replaceAll(path.sep, "/");
  if (!relative) return true;
  const firstSegment = relative.split("/")[0];
  // A fresh git index is created below. Copying either the source index or a
  // dependency tree would make isolation both unsafe and needlessly costly.
  return firstSegment !== ".git" && firstSegment !== "node_modules";
}

function linkNodeModules(sourceRoot: string, targetRoot: string): void {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(targetRoot, "node_modules");
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  try {
    fs.symlinkSync(source, target, "dir");
  } catch {
    // The eval still works for agents that do not need local dependencies.
  }
}

function initializeGit(root: string): string | undefined {
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "agentdoctor-eval@localhost"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "AgentDoctor Eval"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "--all"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "AgentDoctor eval baseline"], {
      cwd: root,
      stdio: "ignore",
    });
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    // Non-git environments can still execute tasks. Review churn falls back
    // to the file-based untracked snapshot in the runner.
    return undefined;
  }
}

/**
 * Copy a repository into a disposable workspace. The copy includes current
 * tracked and untracked files, but not the source .git directory. A new local
 * git baseline lets eval measure only edits made by the agent in the copy.
 */
export function createEvalWorkspace(sourceRoot: string): EvalWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  try {
    fs.cpSync(sourceRoot, root, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
      filter: (sourcePath) => shouldCopy(sourceRoot, sourcePath),
    });
    linkNodeModules(sourceRoot, root);
    const baselineRef = initializeGit(root);
    return {
      root,
      baselineRef,
      cleanup() {
        cleanupEvalWorkspace(root);
      },
    };
  } catch (error) {
    cleanupEvalWorkspace(root);
    throw error;
  }
}

/** Remove only directories created by createEvalWorkspace. */
export function cleanupEvalWorkspace(root: string): void {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  if (
    !resolved.startsWith(`${tempRoot}${path.sep}`) ||
    !path.basename(resolved).startsWith(WORKSPACE_PREFIX)
  ) {
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
