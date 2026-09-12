import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveGitRef } from "../../shared/git.js";
import {
  AGENT_INSTRUCTION_GLOBS,
  globAgentFilesSync,
  isAgentInstructionPath,
} from "../../analyzers/context/agentFiles.js";

/**
 * Instruction files considered "agent context" for before/after eval runs.
 * Uses the shared agent instruction catalog (AGENTS.md, CLAUDE.md, Gemini,
 * Cursor, Copilot, Windsurf, Cline, Aider, OpenCode, Roo, and related rules).
 */
function isInstructionPath(relPath: string): boolean {
  return isAgentInstructionPath(relPath);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function gitOrNull(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function listRefFiles(repoRoot: string, resolvedRef: string): string[] {
  const out = gitOrNull(repoRoot, ["ls-tree", "-r", "--name-only", "-z", resolvedRef]);
  if (out === null) return [];
  return out.split("\0").filter(Boolean);
}

function instructionPathsAtRef(repoRoot: string, ref: string): {
  resolvedRef: string;
  paths: string[];
} {
  const resolvedRef = resolveGitRef(repoRoot, ref);
  if (!resolvedRef) {
    throw new Error(`Could not resolve instructions baseline ref "${ref}".`);
  }

  const wanted = new Set<string>();
  for (const rel of listRefFiles(repoRoot, resolvedRef)) {
    if (isInstructionPath(rel)) wanted.add(rel);
  }
  // Include current-only files so a materialized baseline removes newer
  // instructions instead of accidentally leaking them into the run.
  for (const rel of currentWorktreeInstructionFiles(repoRoot)) wanted.add(rel);
  return { resolvedRef, paths: [...wanted].sort() };
}

export interface InstructionSwap {
  ref: string;
  /** Relative paths that were overwritten or created for the run. */
  swappedPaths: string[];
  /** Restore the working tree exactly as it was before the swap. */
  restore(): void;
}

/**
 * Materialize instruction files from a git ref into another repository copy.
 * The source repo remains untouched; this is used by isolated live evals.
 */
export function materializeInstructionsFromRef(
  repoRoot: string,
  ref: string,
  targetRoot: string
): string[] {
  const { resolvedRef, paths } = instructionPathsAtRef(repoRoot, ref);
  for (const rel of paths) {
    const target = path.join(targetRoot, rel);
    const refContent = gitOrNull(repoRoot, ["show", `${resolvedRef}:${rel}`]);
    if (refContent === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, refContent);
  }
  return paths;
}

/** Return all instruction paths considered by a baseline, without mutating it. */
export function getInstructionPathsAtRef(repoRoot: string, ref: string): string[] {
  return instructionPathsAtRef(repoRoot, ref).paths;
}

interface SavedFile {
  /** null = file did not exist before the swap and must be removed on restore. */
  content: string | null;
}

/**
 * Replace the working tree's instruction files with the versions from a git
 * ref so an eval run executes against the "before" instructions. The restore
 * callback must run in a `finally` block; it never touches files outside the
 * instruction set.
 *
 * Returns null when the ref contains no instruction files at all and the
 * worktree has none either — there would be nothing to compare.
 */
export function swapInstructionsFromRef(
  repoRoot: string,
  ref: string
): InstructionSwap | null {
  const { resolvedRef, paths } = instructionPathsAtRef(repoRoot, ref);
  const wanted = new Set(paths);

  if (wanted.size === 0) return null;

  const saved = new Map<string, SavedFile>();
  for (const rel of [...wanted].sort()) {
    const abs = path.join(repoRoot, rel);
    saved.set(rel, {
      content: fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null,
    });

    const refContent = gitOrNull(repoRoot, ["show", `${resolvedRef}:${rel}`]);
    // A failed `git show` means the file is absent from the ref tree; the
    // "before" run must not keep the current (newer) version, so remove it.
    if (refContent === null) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, refContent);
  }

  return {
    ref,
    swappedPaths: [...wanted].sort(),
    restore() {
      for (const [rel, savedFile] of saved) {
        const abs = path.join(repoRoot, rel);
        try {
          if (savedFile.content === null) {
            fs.rmSync(abs, { force: true });
          } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, savedFile.content);
          }
        } catch {
          // Best-effort restore; never mask the eval result with a cleanup error.
        }
      }
    },
  };
}

function currentWorktreeInstructionFiles(repoRoot: string): string[] {
  const out = gitOrNull(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out === null) {
    // Not a git repo (or git unavailable): fall back to the root instruction set.
    return globAgentFilesSync(repoRoot, AGENT_INSTRUCTION_GLOBS);
  }
  return out.split("\0").filter((rel) => rel && isInstructionPath(rel));
}
