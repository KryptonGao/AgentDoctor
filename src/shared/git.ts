import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

export function getGitBranch(cwd: string): string {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return branch || "main";
  } catch {
    return "unknown";
  }
}

export function getGitRoot(cwd: string): string {
  // If cwd itself has .git, it is the git root
  if (fs.existsSync(path.join(cwd, ".git"))) {
    return path.resolve(cwd);
  }

  // If cwd has an isolated project manifest, check whether cwd is a standalone subproject/fixture
  const hasIsolatedManifest =
    fs.existsSync(path.join(cwd, "pyproject.toml")) ||
    fs.existsSync(path.join(cwd, "Cargo.toml")) ||
    fs.existsSync(path.join(cwd, "go.mod")) ||
    (fs.existsSync(path.join(cwd, "package.json")) && !fs.existsSync(path.join(cwd, "..", "node_modules")));

  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (hasIsolatedManifest && root && path.resolve(root) !== path.resolve(cwd)) {
      // cwd is an isolated test fixture or standalone subpackage inside a parent git repo
      return path.resolve(cwd);
    }
    return path.resolve(root || cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function isGitClean(cwd: string): boolean {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return status.length === 0;
  } catch {
    return true;
  }
}

export function resolveGitRef(cwd: string, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  const candidates = [trimmed];
  // actions/checkout commonly exposes fetched branches as origin/<branch>
  // while the user-facing baseline is simply `main`.
  if (!trimmed.startsWith("origin/") && !trimmed.startsWith("refs/")) {
    candidates.push(`origin/${trimmed}`);
  }

  for (const candidate of candidates) {
    try {
      const resolved = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
        {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }
      ).trim();
      if (resolved) return resolved;
    } catch {
      // Try the origin-qualified spelling before reporting a missing ref.
    }
  }

  return null;
}

/** Materialize a committed tree without changing the user's worktree. */
export function archiveGitRef(cwd: string, ref: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-baseline-"));
  const archivePath = path.join(tempRoot, "tree.tar");
  try {
    // Keep the archive on disk instead of buffering an entire large repository
    // in Node's heap. The extracted tree is temporary and is removed by the
    // caller after the baseline scan completes.
    execFileSync("git", ["archive", "--format=tar", `--output=${archivePath}`, ref], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execFileSync("tar", ["-xf", archivePath, "-C", tempRoot], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    fs.rmSync(archivePath, { force: true });
    return tempRoot;
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function removeTemporaryDirectory(directory: string): void {
  if (directory.includes("agentdoctor-baseline-")) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
