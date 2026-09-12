/**
 * Effect evaluation (`agentdoctor eval`).
 *
 * Static scores prove the instructions look clean; eval proves the agent is
 * actually better. Metrics follow the same honesty rules as runtime sessions:
 * unknown values stay unknown (`n/a`), never fabricated.
 */

export const EVAL_SCHEMA_VERSION = 1 as const;

export type EvalMode = "replay" | "command";

export interface EvalPricing {
  /** USD per million input tokens. */
  inputPerMTok?: number;
  /** USD per million output tokens. */
  outputPerMTok?: number;
}

export interface EvalVerification {
  /** Command that must exit 0 for the task to count as green. */
  command: string;
  /** Default true. When false, a non-zero exit counts as green. */
  expectPass?: boolean;
  timeoutSeconds?: number;
}

export interface EvalTask {
  /** Stable, unique id used in reports and session matching. */
  id: string;
  title?: string;
  /** Full task prompt handed to the agent runner. */
  prompt: string;
  /** Optional deterministic fixture/setup command run before the agent. */
  setup?: string;
  verify?: EvalVerification;
  /** Retry budget for the command runner. Default 1 (no retries). */
  maxAttempts?: number;
  /** Agent command timeout in seconds (command runner). Default 900. */
  timeoutSeconds?: number;
  /**
   * Replay matcher: sessions whose taskTitle/nativeId/id match this regex are
   * attributed to the task. Without it, attribution only works for
   * single-task suites or sessions whose taskTitle contains the task id.
   */
  match?: { sessionRegex?: string };
  tags?: string[];
}

export interface EvalSuite {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  name?: string;
  description?: string;
  pricing?: EvalPricing;
  tasks: EvalTask[];
}

export interface EvalReviewChurn {
  files: number;
  additions: number;
  deletions: number;
}

/** Per-task effect metrics. Absent fields mean "not measurable", never 0. */
export interface EvalTaskMetrics {
  taskId: string;
  /** Green on the final verification. */
  passed?: boolean;
  /** Green on the first attempt (or first matched session in replay). */
  firstPass?: boolean;
  attempts?: number;
  retries?: number;
  /** Wall time from the first attempt start to the first green verify. */
  timeToGreenMs?: number;
  totalDurationMs?: number;
  tokens?: { input: number; output: number; total: number };
  tokensUnknown?: boolean;
  costUsd?: number;
  reviewChurn?: EvalReviewChurn;
  /** Failed verification commands / executed verification commands (0-1). */
  testFailureRate?: number;
  verifyCommandsTotal?: number;
  verifyCommandsFailed?: number;
  sessionsMatched?: number;
  error?: string;
}

export interface EvalRunMetrics {
  taskCount: number;
  /** Tasks with enough verification evidence to measure first-pass behavior. */
  evaluatedTaskCount?: number;
  /** Tasks missing first-pass evidence; incomplete runs must not look green. */
  unknownTaskCount?: number;
  /** 0-100 coverage of the golden-task suite. */
  coverageRate?: number;
  passedCount?: number;
  /** 0-100. Undefined when any task lacks first-pass evidence. */
  firstPassRate?: number;
  medianTimeToGreenMs?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensUnknown?: boolean;
  costUsd?: number;
  totalRetries?: number;
  reviewChurn?: EvalReviewChurn;
  testFailureRate?: number;
}

export interface EvalRun {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  repositoryName: string;
  repositoryRoot: string;
  branch: string;
  timestamp: string;
  mode: EvalMode;
  /** Ref whose instruction files were injected for this run ("before"). */
  instructionsRef?: string;
  suiteName?: string;
  suitePath?: string;
  tasks: EvalTaskMetrics[];
  metrics: EvalRunMetrics;
  /** Sessions seen by the replay source but matched to no golden task. */
  unmatchedSessions?: number;
  durationMs: number;
}

export type EvalVerdict = "improved" | "neutral" | "regressed";

export interface EvalComparison {
  baselineRef: string;
  before: EvalRunMetrics;
  after: EvalRunMetrics;
  verdict: EvalVerdict;
  /** Human-readable "metric: before -> after" lines, worse first. */
  regressions: string[];
  improvements: string[];
  neutralDeltas: string[];
}

export interface EvalResult {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  mode: EvalMode;
  suite: { name?: string; path?: string; taskCount: number };
  /** Single run when no instruction baseline was requested. */
  run: EvalRun | null;
  /** "Before" run (instructions from the baseline ref). */
  before: EvalRun | null;
  /** "After" run (current instructions). */
  after: EvalRun | null;
  comparison: EvalComparison | null;
  passed: boolean;
  failures: string[];
  warnings: string[];
  /** Where the run record was persisted (.agentdoctor/eval/last-run.json). */
  runPath?: string;
  exitCode: 0 | 1 | 2;
}
