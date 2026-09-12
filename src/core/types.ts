export type FindingCategory = "context" | "repository" | "verification" | "runtime" | "security";
export type FindingSeverity = "critical" | "high" | "medium" | "low";

export const SCAN_SCHEMA_VERSION = 1 as const;
export const CHECK_SCHEMA_VERSION = 1 as const;
export const AUDIT_SCHEMA_VERSION = 1 as const;

export type RegressionKind = "new-finding" | "verification" | "context-bloat";

export type SupportedEcosystem = "node" | "python" | "rust" | "go" | "mixed" | "unknown";

export interface ProjectProfile {
  primaryEcosystem: SupportedEcosystem;
  ecosystems: SupportedEcosystem[];
  languages: string[];
  packageRoots: string[];
  workspaceRoots: string[];
  isMonorepo: boolean;
  testRoots: string[];
  entryPoints: string[];
  configFiles: {
    node?: string[];
    python?: string[];
    rust?: string[];
    go?: string[];
  };
  confidence: number; // 0.0 - 1.0
  summary?: string;
}

export interface Evidence {
  file: string;
  line?: number;
  endLine?: number;
  snippet?: string;
  source?: string;
}

export interface Impact {
  tokens?: number;
  latency?: number;
  reliability?: number;
}

export type FileChangeKind = "create" | "update" | "delete";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  /** Substring replaced on update. Ignored when `replaceFile` is true. */
  oldText?: string;
  newText?: string;
  /** Replace or create the entire file with `newText`. */
  replaceFile?: boolean;
}

export interface Fix {
  id: string;
  title: string;
  description: string;
  isSafe: boolean;
  /** Primary path (absolute or repo-relative). Prefer `changes` for multi-file fixes. */
  file: string;
  oldText: string;
  newText: string;
  diff?: string;
  /** Atomic file operations for this fix. When omitted, `file`/`oldText`/`newText` are used. */
  changes?: FileChange[];
}

export interface FixPromptContext {
  title: string;
  category: string;
  severity: FindingSeverity;
  confidence: number;
  description: string;
  evidence: Evidence[];
  recommendation?: string;
  locations?: {
    file: string;
    line?: number;
  }[];
  constraints?: string[];
  verification?: string[];
}

export interface Finding {
  id: string;
  /** Stable identity that intentionally excludes line numbers. */
  fingerprint?: string;
  ruleId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number; // 0.0 - 1.0
  needsReview?: boolean; // true if confidence < 0.8
  title: string;
  description: string;
  evidence: Evidence[];
  impact?: Impact;
  recommendation?: string;
  fix?: Fix;
  fixPrompt?: string;
  actionable?: boolean;
  groupKey?: string;
  children?: Finding[];
}

export interface CategoryScore {
  score: number; // 0-100
  weight: number; // e.g. 0.35
  findingsCount: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  metrics?: Record<string, any>;
}

export interface ContextSignalDensity {
  totalTokens: number;
  usefulTokens: number;
  wastefulTokens: number;
  duplicateTokens: number;
  inferableTokens: number;
  staleTokens: number;
  lowValueTokens: number;
  densityPercent: number; // Useful / Total * 100
}

export interface VerificationItem {
  name: "test" | "lint" | "typecheck" | "build" | "ci";
  status: "healthy" | "warning" | "broken" | "unknown" | "not_applicable";
  command?: string;
  source?: string;
  detail?: string;
}

export interface Regression {
  kind: RegressionKind;
  severity: FindingSeverity;
  title: string;
  detail: string;
  fingerprint?: string;
  evidence?: Evidence[];
}

export interface BaselineComparison {
  baselineRef: string;
  baselineScore: number;
  headScore: number;
  scoreDelta: number;
  regressions: Regression[];
  contextDelta?: {
    totalTokens: number;
    wastefulTokens: number;
    densityPercent: number;
  };
}

export interface AuditResult {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  repositoryName: string;
  repositoryRoot: string;
  branch: string;
  timestamp: string;
  score: number;
  findings: Finding[];
  passed: boolean;
  failures: string[];
  exitCode: 0 | 1;
}

export interface CheckResult {
  schemaVersion: typeof CHECK_SCHEMA_VERSION;
  result: ScanResult;
  /** Always present in JSON so consumers can rely on a fixed top-level shape. */
  baseline: ScanResult | null;
  comparison: BaselineComparison | null;
  passed: boolean;
  failures: string[];
  exitCode: 0 | 1 | 2;
}

export interface SessionTimelineEvent {
  timeOffset: string; // e.g. "00:02"
  action: string;     // e.g. "Search auth", "Read AuthService.ts"
  tool?: string;
  status: "success" | "failed";
  detail?: string;
}

export interface SessionMetrics {
  id: string;
  agentName: "Codex" | "Claude Code" | "OpenCode" | "Cursor" | "Gemini CLI" | "Other";
  date: string;
  efficiencyScore: number;
  durationSeconds: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  toolCalls: number;
  failedToolCalls: number;
  commandsExecuted: number;
  filesRead: string[];
  filesEdited: string[];
  searchOperations: string[];
  toolOutputTokens: number;
  timeline: SessionTimelineEvent[];
  repeatedReads: { file: string; count: number }[];
  repeatedSearches: { query: string; count: number }[];
  repeatedFailures: { command: string; count: number }[];
  /** Provenance: which native log produced this session. */
  sourcePath?: string;
  nativeId?: string;
  model?: string;
  /** Working directory recorded by the native session, when available. */
  sessionCwd?: string;
  /** Precise session bounds when the native trace exposes timestamps. */
  startedAtMs?: number;
  endedAtMs?: number;
  /** Git/task/PR linkage (best-effort, local-first). */
  gitBranch?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  gitMessage?: string;
  prNumber?: number;
  prTitle?: string;
  prState?: string;
  taskTitle?: string;
  /** Enriched runtime signals. */
  cacheTokens?: { read?: number; creation?: number };
  /** Observed context/input size and configured model context window. */
  contextTokens?: number;
  contextWindowTokens?: number;
  approvalsCount?: number;
  retriesCount?: number;
  restoresCount?: number;
  failureReasons?: { action: string; reason: string }[];
  /** Data-quality + privacy markers. Never fabricate tokens/duration. */
  redactedFields?: number;
  durationUnknown?: boolean;
  tokensUnknown?: boolean;
}

export interface RuntimeScanOptions {
  /** Explicit --session file (auto-detected format). */
  sessionPath?: string;
  /** Scan global native log dirs for sessions matching this repo. Default true. */
  includeGlobal?: boolean;
  /** Keep secrets verbatim. Default false (redact). */
  allowSensitive?: boolean;
  /** Cap global sessions parsed per repo (mtime desc). Default 20. */
  maxGlobalSessions?: number;
}

export interface ScanResult {
  schemaVersion: typeof SCAN_SCHEMA_VERSION;
  repositoryName: string;
  repositoryRoot: string;
  branch: string;
  timestamp: string;
  projectProfile: ProjectProfile;
  overallScore: number; // 0 - 100
  scoreExplanation?: string;
  scores: {
    context: CategoryScore;
    repository: CategoryScore;
    verification: CategoryScore;
    security: CategoryScore;
    runtime: CategoryScore | null;
  };
  contextSignalDensity: ContextSignalDensity;
  verificationStatus: VerificationItem[];
  sessions: SessionMetrics[];
  findings: Finding[];
  availableFixes: Fix[];
  metadata: {
    schemaVersion: typeof SCAN_SCHEMA_VERSION;
    scannedFilesCount: number;
    scanDurationMs: number;
    hasRuntimeData: boolean;
    aiEnabled: boolean;
  };
}
