import * as fs from "node:fs";
import * as path from "node:path";
import { getGitRoot } from "../../shared/git.js";

export function resolveRepoRoot(cwdOrFile: string): string {
  const start = fs.existsSync(cwdOrFile) && fs.statSync(cwdOrFile).isFile()
    ? path.dirname(cwdOrFile)
    : cwdOrFile;
  return getGitRoot(start);
}

export function resolveRepoFile(repoRoot: string, filePath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
  if (relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to modify path outside the repository: ${filePath}`);
  }
  return { absolutePath, relativePath };
}

export function toRepoRelative(repoRoot: string, filePath: string): string {
  if (!filePath) return filePath;
  if (!path.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
  const relative = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  if (relative.startsWith("..")) return filePath.replace(/\\/g, "/");
  return relative || ".";
}
