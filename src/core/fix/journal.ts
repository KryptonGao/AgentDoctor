import * as fs from "node:fs";
import * as path from "node:path";
import { FileSnapshot, restoreSnapshots } from "./transaction.js";

export const FIX_JOURNAL_SCHEMA_VERSION = 1 as const;
export const FIX_JOURNAL_RELATIVE_PATH = ".agentdoctor/last-fix.json";

export interface FixJournalSnapshot {
  relativePath: string;
  existed: boolean;
  content: string | null;
}

export interface FixJournal {
  schemaVersion: typeof FIX_JOURNAL_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  repoRoot: string;
  fixIds: string[];
  snapshots: FixJournalSnapshot[];
}

export function journalFilePath(repoRoot: string): string {
  return path.join(repoRoot, FIX_JOURNAL_RELATIVE_PATH);
}

export function writeFixJournal(repoRoot: string, fixIds: string[], snapshots: FileSnapshot[]): FixJournal {
  const journal: FixJournal = {
    schemaVersion: FIX_JOURNAL_SCHEMA_VERSION,
    id: `fix-${Date.now()}`,
    createdAt: new Date().toISOString(),
    repoRoot,
    fixIds,
    snapshots: snapshots.map((snapshot) => ({
      relativePath: snapshot.relativePath,
      existed: snapshot.existed,
      content: snapshot.content,
    })),
  };
  fs.mkdirSync(path.dirname(journalFilePath(repoRoot)), { recursive: true });
  fs.writeFileSync(journalFilePath(repoRoot), `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
  return journal;
}

export function readFixJournal(repoRoot: string): FixJournal | null {
  const file = journalFilePath(repoRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as FixJournal;
    if (parsed.schemaVersion !== FIX_JOURNAL_SCHEMA_VERSION || !Array.isArray(parsed.snapshots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function rollbackFixJournal(repoRoot: string, journal?: FixJournal | null): { restored: string[]; error?: string } {
  const resolved = journal || readFixJournal(repoRoot);
  if (!resolved) return { restored: [], error: "No fix journal found. Nothing to roll back." };

  const snapshots: FileSnapshot[] = resolved.snapshots.map((snapshot) => ({
    relativePath: snapshot.relativePath,
    absolutePath: path.join(repoRoot, snapshot.relativePath),
    existed: snapshot.existed,
    content: snapshot.content,
  }));
  restoreSnapshots(snapshots);
  const journalPath = journalFilePath(repoRoot);
  if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
  return { restored: snapshots.map((snapshot) => snapshot.relativePath) };
}
