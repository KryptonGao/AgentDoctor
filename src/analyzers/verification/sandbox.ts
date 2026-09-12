import { spawn } from "node:child_process";
import * as path from "node:path";

const MAX_STREAM_BYTES = 256 * 1024;
const KILL_GRACE_MS = 1_000;

const SECRET_ENV_KEY =
  /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|access[_-]?key|session[_-]?key|auth_token|npm_token|node_auth_token)/i;

const ALLOWED_BINARIES = new Set([
  "npm",
  "npm.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "yarn.cmd",
  "bun",
  "bun.exe",
  "node",
  "node.exe",
  "npx",
  "npx.cmd",
  "cargo",
  "cargo.exe",
  "go",
  "go.exe",
  "python",
  "python.exe",
  "python3",
  "pytest",
  "ruff",
  "mypy",
  "tox",
  "pre-commit",
]);

export interface SandboxSpawnRequest {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  offline?: boolean;
}

export interface SandboxSpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  spawnFailed: boolean;
  truncated: boolean;
  spawnError?: string;
}

export function isAllowedBinary(file: string): boolean {
  return ALLOWED_BINARIES.has(path.basename(file).toLowerCase());
}

export function sanitizeVerifyEnv(base: NodeJS.ProcessEnv, offline: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  env.CI = env.CI || "1";
  env.AGENTDOCTOR_VERIFY = "1";
  if (offline) {
    env.npm_config_offline = "true";
    env.NPM_CONFIG_OFFLINE = "true";
    env.YARN_ENABLE_OFFLINE_MODE = "true";
    env.GOPROXY = "off";
    env.GOSUMDB = "off";
  }
  return env;
}

function collectStream(stream: NodeJS.ReadableStream | null): { text: () => string; truncated: () => boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream?.on("data", (chunk: Buffer | string) => {
    if (truncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_STREAM_BYTES - size;
    if (buffer.length > remaining) {
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      size = MAX_STREAM_BYTES;
      truncated = true;
      return;
    }
    chunks.push(buffer);
    size += buffer.length;
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf-8"),
    truncated: () => truncated,
  };
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall through to killing the child itself.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already exited
  }
}

export function runSandboxedCommand(request: SandboxSpawnRequest): Promise<SandboxSpawnResult> {
  const [file, ...args] = request.argv;
  if (!file || !isAllowedBinary(file)) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      spawnFailed: true,
      truncated: false,
      spawnError: file ? `binary "${path.basename(file)}" is not in the verify allowlist` : "empty command",
    });
  }

  const cwd = path.resolve(request.cwd);
  const env = sanitizeVerifyEnv({ ...process.env, ...request.env }, Boolean(request.offline));
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnFailed = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const stdout = collectStream(child.stdout);
    const stderr = collectStream(child.stderr);

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        spawnFailed,
        truncated: stdout.truncated() || stderr.truncated(),
        spawnError,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child.pid, "SIGKILL"), KILL_GRACE_MS);
    }, Math.max(1, request.timeoutMs));

    child.on("error", (error) => {
      spawnFailed = true;
      spawnError = error.message;
      finish(null, null);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
