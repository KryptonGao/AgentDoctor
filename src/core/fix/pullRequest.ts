import { execFileSync } from "node:child_process";

export interface ProcessRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: string[], cwd: string): ProcessRunResult;
}

export const defaultProcessRunner: ProcessRunner = {
  run(command, args, cwd) {
    try {
      const stdout = execFileSync(command, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, stdout: String(stdout), stderr: "" };
    } catch (error: unknown) {
      const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      return {
        status: typeof err.status === "number" ? err.status : 1,
        stdout: err.stdout ? String(err.stdout) : "",
        stderr: err.stderr ? String(err.stderr) : (err.message || String(error)),
      };
    }
  },
};

export interface CreateFixPullRequestOptions {
  repoRoot: string;
  title: string;
  body: string;
  files: string[];
  branchName?: string;
  runner?: ProcessRunner;
  push?: boolean;
}

export interface CreateFixPullRequestResult {
  branch: string;
  committed: boolean;
  pushed: boolean;
  url?: string;
  detail?: string;
}

function git(runner: ProcessRunner, args: string[], cwd: string): ProcessRunResult {
  return runner.run("git", args, cwd);
}

export function createFixPullRequest(options: CreateFixPullRequestOptions): CreateFixPullRequestResult {
  const runner = options.runner || defaultProcessRunner;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").slice(0, 15);
  const branch = options.branchName || `agentdoctor/fix-${stamp}`;
  const uniqueFiles = [...new Set(options.files)].filter(Boolean);

  const checkout = git(runner, ["checkout", "-b", branch], options.repoRoot);
  if (checkout.status !== 0) {
    return { branch, committed: false, pushed: false, detail: checkout.stderr || "Could not create git branch" };
  }

  if (uniqueFiles.length > 0) {
    git(runner, ["add", "--", ...uniqueFiles], options.repoRoot);
  } else {
    git(runner, ["add", "-A"], options.repoRoot);
  }

  const commit = git(runner, ["commit", "-m", options.title], options.repoRoot);
  if (commit.status !== 0) {
    return {
      branch,
      committed: false,
      pushed: false,
      detail: commit.stderr || commit.stdout || "git commit failed (nothing to commit?)",
    };
  }

  if (options.push === false) {
    return { branch, committed: true, pushed: false, detail: "Commit created locally; push skipped." };
  }

  const remote = git(runner, ["remote"], options.repoRoot);
  if (remote.status !== 0 || !remote.stdout.trim()) {
    return { branch, committed: true, pushed: false, detail: "No git remote configured; branch committed locally." };
  }

  const push = git(runner, ["push", "-u", "origin", branch], options.repoRoot);
  if (push.status !== 0) {
    return { branch, committed: true, pushed: false, detail: push.stderr || "git push failed" };
  }

  const gh = runner.run("gh", ["pr", "create", "--title", options.title, "--body", options.body], options.repoRoot);
  if (gh.status === 0) {
    const url = gh.stdout.trim().split(/\s+/).find((token) => token.startsWith("http")) || gh.stdout.trim();
    return { branch, committed: true, pushed: true, url, detail: "Opened pull request with gh." };
  }

  return {
    branch,
    committed: true,
    pushed: true,
    detail: `Pushed ${branch}. Create a PR with: gh pr create --title "${options.title}"`,
  };
}
