import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WORKSPACE_PREFIX = "agentdoctor-verify-workspace-";

export interface VerifyWorkspace {
  root: string;
  cleanup(): void;
}

function shouldCopy(sourceRoot: string, sourcePath: string): boolean {
  const relative = path.relative(sourceRoot, sourcePath).replaceAll(path.sep, "/");
  if (!relative) return true;
  const firstSegment = relative.split("/")[0];
  return firstSegment !== ".git" && firstSegment !== "node_modules";
}

function linkNodeModules(sourceRoot: string, targetRoot: string): void {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(targetRoot, "node_modules");
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  try {
    fs.symlinkSync(source, target, "dir");
  } catch {
    // Isolation still works without a dependency tree.
  }
}

export function createVerifyWorkspace(sourceRoot: string): VerifyWorkspace {
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
    return {
      root,
      cleanup() {
        cleanupVerifyWorkspace(root);
      },
    };
  } catch (error) {
    cleanupVerifyWorkspace(root);
    throw error;
  }
}

export function cleanupVerifyWorkspace(root: string): void {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith(WORKSPACE_PREFIX)) {
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
