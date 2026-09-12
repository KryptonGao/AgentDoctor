import * as fs from "node:fs";
import * as path from "node:path";
import { FileChange, Fix } from "../types.js";
import { resolveRepoFile, resolveRepoRoot } from "./paths.js";

export interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  existed: boolean;
  content: string | null;
}

export function changesFromFix(fix: Fix): FileChange[] {
  if (fix.changes && fix.changes.length > 0) return fix.changes;
  const kind: FileChange["kind"] = !fix.oldText && fix.newText ? "create" : "update";
  return [{
    path: fix.file,
    kind,
    oldText: fix.oldText,
    newText: fix.newText,
    replaceFile: kind === "create",
  }];
}

export function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.existed) {
      if (fs.existsSync(snapshot.absolutePath)) {
        fs.unlinkSync(snapshot.absolutePath);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(snapshot.absolutePath), { recursive: true });
    fs.writeFileSync(snapshot.absolutePath, snapshot.content ?? "", "utf-8");
  }
}

function snapshotFile(repoRoot: string, filePath: string): FileSnapshot {
  const { absolutePath, relativePath } = resolveRepoFile(repoRoot, filePath);
  const existed = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
  return {
    relativePath,
    absolutePath,
    existed,
    content: existed ? fs.readFileSync(absolutePath, "utf-8") : null,
  };
}

function applyChange(repoRoot: string, change: FileChange): FileSnapshot {
  const { absolutePath, relativePath } = resolveRepoFile(repoRoot, change.path);
  const snapshot = snapshotFile(repoRoot, change.path);

  if (change.kind === "delete") {
    if (snapshot.existed) fs.unlinkSync(absolutePath);
    return snapshot;
  }

  let next: string;
  if (change.kind === "create" || change.replaceFile || snapshot.content === null) {
    if (change.kind === "create" && snapshot.existed && !change.replaceFile) {
      throw new Error(`Cannot create ${relativePath}: file already exists`);
    }
    next = change.newText ?? "";
  } else {
    const oldText = change.oldText ?? "";
    if (!snapshot.content.includes(oldText)) {
      throw new Error(`Could not locate original text in ${relativePath}. Content may have changed.`);
    }
    next = snapshot.content.replace(oldText, change.newText ?? "");
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, next, "utf-8");
  return snapshot;
}

export function applyChangesAtomic(repoRoot: string, changes: FileChange[]): FileSnapshot[] {
  const snapshots: FileSnapshot[] = [];
  const seen = new Set<string>();
  try {
    for (const change of changes) {
      const { relativePath } = resolveRepoFile(repoRoot, change.path);
      const snapshot = applyChange(repoRoot, change);
      if (!seen.has(relativePath)) {
        snapshots.push(snapshot);
        seen.add(relativePath);
      }
    }
    return snapshots;
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}

export function inferRepoRootFromFixes(fixes: Fix[], fallback = process.cwd()): string {
  const first = fixes[0];
  if (!first) return resolveRepoRoot(fallback);
  const candidate = first.changes?.[0]?.path || first.file;
  if (!candidate) return resolveRepoRoot(fallback);
  try {
    return resolveRepoRoot(path.isAbsolute(candidate) ? candidate : path.join(fallback, candidate));
  } catch {
    return resolveRepoRoot(fallback);
  }
}
