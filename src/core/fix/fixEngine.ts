import * as fs from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import { FileChange, Fix } from "../types.js";
import { applyChangesAtomic, changesFromFix, FileSnapshot, inferRepoRootFromFixes } from "./transaction.js";
import { writeFixJournal } from "./journal.js";

export function generateDiff(filePath: string, oldContent: string, newContent: string): string {
  const fileName = path.basename(filePath);
  return createTwoFilesPatch(
    `a/${fileName}`,
    `b/${fileName}`,
    oldContent,
    newContent,
    "current",
    "proposed",
    { context: 3 }
  );
}

function combinedDiff(changes: FileChange[]): string {
  return changes.map((change) => {
    const oldContent = change.kind === "create" || change.replaceFile
      ? (change.kind === "create" ? "" : change.oldText ?? "")
      : change.oldText ?? "";
    let newContent = change.newText ?? "";
    if (change.kind === "update" && !change.replaceFile && change.oldText !== undefined) {
      newContent = oldContent.replace(change.oldText, change.newText ?? "");
    }
    if (change.kind === "delete") newContent = "";
    return generateDiff(change.path, oldContent, newContent);
  }).join("\n");
}

export function createFix(options: {
  id: string;
  title: string;
  description: string;
  isSafe: boolean;
  file: string;
  oldText: string;
  newText: string;
  fullOldContent?: string;
  changes?: FileChange[];
}): Fix {
  const { id, title, description, isSafe, file, oldText, newText, fullOldContent, changes } = options;
  const normalizedChanges = changes && changes.length > 0
    ? changes
    : [{
      path: file,
      kind: (!oldText && newText ? "create" : "update") as FileChange["kind"],
      oldText,
      newText,
      replaceFile: !oldText && Boolean(newText),
    }];

  let diff = "";
  if (normalizedChanges.length > 1 || normalizedChanges.some((change) => change.kind === "create" || change.kind === "delete")) {
    if (fullOldContent !== undefined && normalizedChanges.length === 1) {
      const change = normalizedChanges[0];
      const next = change.replaceFile ? (change.newText ?? "") : fullOldContent.replace(oldText, newText);
      diff = generateDiff(file, fullOldContent, next);
    } else {
      diff = combinedDiff(normalizedChanges.map((change) => {
        if (change.kind === "update" && !change.replaceFile && fullOldContent !== undefined && normalizedChanges.length === 1) {
          return { ...change, oldText: fullOldContent, newText: fullOldContent.replace(oldText, newText), replaceFile: true };
        }
        if (change.kind === "update" && !change.replaceFile && fs.existsSync(change.path)) {
          const current = fs.readFileSync(change.path, "utf-8");
          return { ...change, oldText: current, newText: current.replace(change.oldText ?? "", change.newText ?? ""), replaceFile: true };
        }
        return change;
      }));
    }
  } else if (fullOldContent !== undefined) {
    const fullNewContent = oldText ? fullOldContent.replace(oldText, newText) : newText;
    diff = generateDiff(file, fullOldContent, fullNewContent);
  } else if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf-8");
    const updated = oldText ? current.replace(oldText, newText) : newText;
    diff = generateDiff(file, current, updated);
  } else {
    diff = combinedDiff(normalizedChanges);
  }

  return {
    id,
    title,
    description,
    isSafe,
    file,
    oldText,
    newText,
    diff,
    changes: normalizedChanges,
  };
}

export interface ApplyFixResult {
  success: boolean;
  error?: string;
  snapshots?: FileSnapshot[];
}

export function applyFix(fix: Fix, repoRoot?: string): ApplyFixResult {
  try {
    const root = repoRoot || inferRepoRootFromFixes([fix]);
    const snapshots = applyChangesAtomic(root, changesFromFix(fix));
    return { success: true, snapshots };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export function applyFixes(fixes: Fix[], options: { repoRoot?: string; journal?: boolean } = {}): {
  applied: Fix[];
  failed: { fix: Fix; error: string }[];
  snapshots: FileSnapshot[];
  journalId?: string;
} {
  const applied: Fix[] = [];
  const failed: { fix: Fix; error: string }[] = [];
  const snapshots: FileSnapshot[] = [];
  const seen = new Set<string>();
  const root = options.repoRoot || inferRepoRootFromFixes(fixes);

  for (const fix of fixes) {
    const result = applyFix(fix, root);
    if (!result.success) {
      failed.push({ fix, error: result.error || "Unknown error" });
      continue;
    }
    applied.push(fix);
    for (const snapshot of result.snapshots || []) {
      if (seen.has(snapshot.relativePath)) continue;
      seen.add(snapshot.relativePath);
      snapshots.push(snapshot);
    }
  }

  let journalId: string | undefined;
  if (options.journal !== false && snapshots.length > 0) {
    journalId = writeFixJournal(root, applied.map((fix) => fix.id), snapshots).id;
  }

  return { applied, failed, snapshots, journalId };
}

export function applySafeFixes(fixes: Fix[], repoRoot?: string): {
  applied: Fix[];
  failed: { fix: Fix; error: string }[];
  snapshots: FileSnapshot[];
  journalId?: string;
} {
  return applyFixes(fixes.filter((fix) => fix.isSafe), { repoRoot, journal: true });
}
