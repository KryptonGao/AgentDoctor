export const AGENT_PROFILE_IDS = [
  "codex",
  "claude",
  "cursor",
  "copilot",
  "gemini",
  "windsurf",
  "cline",
  "aider",
  "opencode",
  "roo",
] as const;

export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];

export const AGENT_PROFILE_META: Record<AgentProfileId, { name: string; surface: string }> = {
  codex: { name: "Codex", surface: "CLI / IDE (local)" },
  claude: { name: "Claude Code", surface: "CLI / IDE (local)" },
  cursor: { name: "Cursor Agent", surface: "Agent / CLI (local)" },
  copilot: { name: "GitHub Copilot", surface: "Copilot CLI (local)" },
  gemini: { name: "Gemini CLI", surface: "CLI (local)" },
  windsurf: { name: "Windsurf", surface: "Cascade / IDE (local)" },
  cline: { name: "Cline", surface: "VS Code extension (local)" },
  aider: { name: "Aider", surface: "CLI (local)" },
  opencode: { name: "OpenCode", surface: "CLI / TUI (local)" },
  roo: { name: "Roo Code", surface: "VS Code extension (local)" },
};

export function isAgentProfileId(value: string): value is AgentProfileId {
  return (AGENT_PROFILE_IDS as readonly string[]).includes(value);
}

export const AGENT_PROFILE_LIST = AGENT_PROFILE_IDS.join(", ");

export type EffectiveContextScope =
  | "system"
  | "managed"
  | "global"
  | "repository"
  | "local"
  | "import"
  | "plugin"
  | "runtime";

export type EffectiveContextStatus =
  | "loaded"
  | "candidate"
  | "excluded"
  | "overridden"
  | "truncated"
  | "invalid";

export type EffectiveContextEntryKind =
  | "instruction"
  | "rule"
  | "import"
  | "skill-metadata"
  | "skill"
  | "hook"
  | "subagent-instruction";

export interface EffectiveContextQuery {
  agent: AgentProfileId;
  /** Agent launch directory. The repository root is derived from this path. */
  cwd?: string;
  /** Repository-relative or absolute files the simulated task will touch. */
  targetPaths?: string[];
  /** Used to rank conditional candidates; never silently activates them. */
  task?: string;
  /** Explicitly selected/manual rules. */
  rules?: string[];
  /** Explicitly invoked skills. */
  skills?: string[];
  /** Explicitly selected subagent/custom agent. */
  subagent?: string;
  /** Optional hook event and tool matcher inputs. */
  hookEvent?: string;
  toolName?: string;
  /** Codex profile name. Ignored by other adapters. */
  profile?: string;
  /** Defaults to true. */
  includeGlobal?: boolean;
  /** Opt in to imports that resolve outside the repository/global config roots. */
  allowExternalImports?: boolean;
  /** Optional known model context window. Unknown is represented as null. */
  contextWindowTokens?: number;
}

export interface EffectiveInstructionBlock {
  id: string;
  entryId: string;
  source: string;
  line: number;
  heading?: string;
  content: string;
  estimatedTokens: number;
}

export interface EffectiveContextEntry {
  id: string;
  kind: EffectiveContextEntryKind;
  source: string;
  scope: EffectiveContextScope;
  status: EffectiveContextStatus;
  order: number;
  line?: number;
  name?: string;
  content: string;
  rawBytes: number;
  estimatedTokens: number;
  matchReason: string;
  condition?: string;
  overriddenBy?: string;
  blocks: EffectiveInstructionBlock[];
  redactedFields: number;
}

export type EffectiveContextCapabilityKind =
  | "skill"
  | "hook"
  | "subagent"
  | "mcp"
  | "permission"
  | "configuration";

export interface EffectiveContextCapability {
  id: string;
  kind: EffectiveContextCapabilityKind;
  name: string;
  source: string;
  scope: EffectiveContextScope;
  status: "available" | "selected" | "matched" | "disabled" | "overridden" | "invalid" | "unknown";
  reason: string;
  overriddenBy?: string;
  details?: Record<string, string | number | boolean | string[] | null>;
}

export interface EffectiveContextRelationship {
  id: string;
  type: "overrides" | "duplicates" | "conflicts" | "merges" | "imports" | "merged-unresolved";
  from: string;
  to: string;
  certainty: "certain" | "conservative";
  reason: string;
}

export interface EffectiveContextDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  source?: string;
}

export interface EffectiveContextBudget {
  unit: "estimated_tokens";
  promptTokens: number;
  candidateTokens: number;
  promptBytes: number;
  byScope: Record<string, number>;
  byKind: Record<string, number>;
  contextWindowTokens: number | null;
  remainingTokens: number | null;
  usagePercent: number | null;
  knownLimits: Array<{
    name: string;
    unit: "bytes" | "characters" | "tokens";
    limit: number;
    used: number;
    exceeded: boolean;
  }>;
}

export interface EffectiveContextReport {
  schemaVersion: 1;
  profile: {
    id: AgentProfileId;
    name: string;
    surface: string;
    deterministic: true;
  };
  query: Required<Pick<EffectiveContextQuery, "agent">> & {
    cwd: string;
    repositoryRoot: string;
    targetPaths: string[];
    task: string;
    rules: string[];
    skills: string[];
    subagent: string | null;
    hookEvent: string | null;
    toolName: string | null;
    profile: string | null;
    includeGlobal: boolean;
    allowExternalImports: boolean;
    contextWindowTokens: number | null;
  };
  prompt: EffectiveContextEntry[];
  candidates: EffectiveContextEntry[];
  capabilities: EffectiveContextCapability[];
  relationships: EffectiveContextRelationship[];
  finalInstructions: string;
  budget: EffectiveContextBudget;
  diagnostics: EffectiveContextDiagnostic[];
}
