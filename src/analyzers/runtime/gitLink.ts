import { execFileSync } from "node:child_process";

export interface SessionGitContext {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  message?: string;
}

export interface SessionPrContext {
  number?: number;
  title?: string;
  state?: string;
}

function run(cmd: string, args: string[], cwd: string, timeout = 3000): string | null {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const gitCache = new Map<string, SessionGitContext>();

/** Local git context for a repo. Cached per repoRoot. Never throws. */
export function getSessionGitContext(repoRoot: string): SessionGitContext {
  const cached = gitCache.get(repoRoot);
  if (cached) return cached;
  const ctx: SessionGitContext = {};
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, 2000);
  if (branch) ctx.branch = branch;
  const commit = run("git", ["rev-parse", "HEAD"], repoRoot, 2000);
  if (commit) ctx.commit = commit;
  const status = run("git", ["status", "--porcelain"], repoRoot, 2000);
  if (status !== null) ctx.dirty = status.length > 0;
  const message = run("git", ["log", "-1", "--format=%s"], repoRoot, 2000);
  if (message) ctx.message = message.slice(0, 200);
  gitCache.set(repoRoot, ctx);
  return ctx;
}

let ghAvailable: boolean | null = null;
const prCache = new Map<string, SessionPrContext>();

function hasGh(): boolean {
  if (ghAvailable !== null) return ghAvailable;
  try {
    execFileSync("gh", ["--version"], { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "ignore"] });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }
  return ghAvailable;
}

/**
 * Best-effort PR linkage via local `gh` binary. Returns {} when gh is missing,
 * not authenticated, or the branch has no PR. Never throws, never touches network directly.
 */
export function getSessionPrContext(repoRoot: string, branch?: string): SessionPrContext {
  if (!hasGh()) return {};
  const cacheKey = `${repoRoot}\0${branch || ""}`;
  const cached = prCache.get(cacheKey);
  if (cached) return cached;
  try {
    const args = branch
      ? ["pr", "view", branch, "--json", "number,title,state"]
      : ["pr", "status", "--json", "currentBranch", "--jq", ".currentBranch | {number,title,state}"];
    const out = execFileSync("gh", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 4000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!out) return {};
    const data = JSON.parse(out);
    const number = Number(data?.number);
    if (data && Number.isFinite(number) && number > 0) {
      const result = { number, title: String(data.title ?? "").slice(0, 200), state: String(data.state ?? "") };
      prCache.set(cacheKey, result);
      return result;
    }
    prCache.set(cacheKey, {});
    return {};
  } catch {
    prCache.set(cacheKey, {});
    return {};
  }
}

export function clearGitCache(): void {
  gitCache.clear();
  prCache.clear();
  ghAvailable = null;
}
