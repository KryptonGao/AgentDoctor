import { Finding } from "../types.js";

export const VERIFY_SCHEMA_VERSION = 1 as const;

export type VerifyCheckName = "test" | "lint" | "typecheck" | "build";

export type VerifyCheckStatus =
  | "healthy"
  | "warning"
  | "broken"
  | "skipped"
  | "not_applicable";

export interface VerifyAttempt {
  attempt: number;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  spawnFailed: boolean;
  outputTokens: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  failureSummary?: string;
}

export interface VerifyCheckResult {
  name: VerifyCheckName;
  /** Human-readable command actually spawned (argv joined). */
  command?: string;
  argv?: string[];
  cwd?: string;
  skipped: boolean;
  skipReason?: string;
  passed: boolean;
  flaky: boolean;
  status: VerifyCheckStatus;
  durationMs: number;
  exitCode: number | null;
  outputTokens: number;
  failureSummary?: string;
  attempts: VerifyAttempt[];
}

export interface VerifyResult {
  schemaVersion: typeof VERIFY_SCHEMA_VERSION;
  repositoryName: string;
  repositoryRoot: string;
  branch: string;
  timestamp: string;
  isolated: boolean;
  offline: boolean;
  timeoutSeconds: number;
  flakyRuns: number;
  checks: VerifyCheckResult[];
  findings: Finding[];
  passed: boolean;
  failures: string[];
  warnings: string[];
  durationMs: number;
  exitCode: 0 | 1 | 2;
}

export class VerifyConfigurationError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "VerifyConfigurationError";
  }
}
