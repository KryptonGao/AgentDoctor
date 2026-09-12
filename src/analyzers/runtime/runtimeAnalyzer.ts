import * as fs from "node:fs";
import * as path from "node:path";
import { Finding, SessionMetrics, RuntimeScanOptions } from "../../core/types.js";
import { agentdoctorAdapter, parseAgentdoctorContent } from "./adapters/agentdoctor.js";
import { codexAdapter } from "./adapters/codex.js";
import { claudeAdapter } from "./adapters/claude.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { otelAdapter } from "./adapters/otel.js";
import { RawSessionRef, SessionAdapter } from "./sessionTypes.js";
import {
  detectRepoSessions,
  detectGlobalSessions,
  shouldIncludeGlobal,
} from "./sessionDetect.js";
import { redactSession } from "./redact.js";
import { getSessionGitContext, getSessionPrContext } from "./gitLink.js";

const ADAPTERS: SessionAdapter[] = [
  otelAdapter,
  codexAdapter,
  cursorAdapter,
  claudeAdapter,
  geminiAdapter,
  agentdoctorAdapter,
];

/** Back-compat entry: legacy AgentDoctor JSON string -> SessionMetrics. */
export function parseSessionTrace(content: string, filePath: string): SessionMetrics | null {
  return parseAgentdoctorContent(content, filePath);
}

function readHead(filePath: string, n = 4096): string {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(n);
      const read = fs.readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, read).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function pickAdapter(ref: RawSessionRef): SessionAdapter {
  const head = readHead(ref.sourcePath);
  for (const a of ADAPTERS) {
    try {
      if (a.canParseFile?.(ref.sourcePath, head)) return a;
    } catch {
      // try next
    }
  }
  // Fallback by extension/agent hint
  if (ref.agent === "codex") return codexAdapter;
  if (ref.agent === "claude") return claudeAdapter;
  if (ref.agent === "cursor") return cursorAdapter;
  if (ref.agent === "gemini") return geminiAdapter;
  if (ref.agent === "otel") return otelAdapter;
  if (ref.sourcePath.endsWith(".jsonl")) return claudeAdapter;
  return agentdoctorAdapter;
}

export interface AnalyzeRuntimeOptions extends RuntimeScanOptions {}

export async function analyzeRuntimeSessions(
  repoRoot: string,
  explicitSessionPath?: string,
  opts: AnalyzeRuntimeOptions = {}
): Promise<{
  findings: Finding[];
  sessions: SessionMetrics[];
}> {
  const findings: Finding[] = [];
  const sessions: SessionMetrics[] = [];

  const allowSensitive =
    opts.allowSensitive ?? process.env.AGENTDOCTOR_ALLOW_SENSITIVE === "1";
  const includeGlobal = shouldIncludeGlobal(opts.includeGlobal);
  const maxGlobal = opts.maxGlobalSessions ?? 20;

  const refs: RawSessionRef[] = [];
  if (explicitSessionPath && fs.existsSync(explicitSessionPath)) {
    const st = fs.statSync(explicitSessionPath);
    refs.push({ agent: "agentdoctor", sourcePath: explicitSessionPath, mtime: st.mtimeMs });
  } else {
    refs.push(...(await detectRepoSessions(repoRoot)));
    if (includeGlobal) {
      refs.push(...(await detectGlobalSessions(repoRoot, maxGlobal)));
    }
  }

  // De-dupe by realpath
  const seen = new Set<string>();
  const uniqueRefs = refs.filter((r) => {
    const key = path.resolve(r.sourcePath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const gitCtx = getSessionGitContext(repoRoot);
  const prCtx = getSessionPrContext(repoRoot, gitCtx.branch);

  for (const ref of uniqueRefs) {
    try {
      const adapter = pickAdapter(ref);
      const parsed = adapter.parseMany
        ? await adapter.parseMany(ref)
        : [(await adapter.parse(ref)) as SessionMetrics | null];
      for (const s of parsed) {
        if (!s) continue;
        const sessionPrCtx =
          s.gitBranch && s.gitBranch !== gitCtx.branch
            ? getSessionPrContext(repoRoot, s.gitBranch)
            : prCtx;
        // Stamp git/PR context without overwriting native values.
        if (!s.gitBranch && gitCtx.branch) s.gitBranch = gitCtx.branch;
        if (!s.gitCommit && gitCtx.commit) s.gitCommit = gitCtx.commit;
        if (s.gitDirty === undefined && gitCtx.dirty !== undefined) s.gitDirty = gitCtx.dirty;
        if (!s.gitMessage && gitCtx.message) s.gitMessage = gitCtx.message;
        if (s.prNumber === undefined && sessionPrCtx.number !== undefined) {
          s.prNumber = sessionPrCtx.number;
          s.prTitle = sessionPrCtx.title;
          s.prState = sessionPrCtx.state;
        }
        if (!s.sourcePath) s.sourcePath = ref.sourcePath;
        // Redact after enrichment so repository commit messages and PR titles
        // cannot bypass the same privacy boundary as native log fields.
        if (!allowSensitive) redactSession(s);
        sessions.push(s);
      }
    } catch {
      // ignore one bad session file
    }
  }

  for (const session of sessions) {
    const p = path.relative(repoRoot, session.sourcePath || session.id) || session.id;

    // 1. Repeated Reads Findings
    for (const rr of session.repeatedReads) {
      findings.push({
        id: `runtime-repeated-read-${session.id}-${rr.file.replace(/[^a-zA-Z0-9]/g, "-")}`,
        ruleId: "runtime/repeated-file-retrieval",
        category: "runtime",
        severity: "medium",
        confidence: session.tokensUnknown ? 0.75 : 0.9,
        title: `Repeated file retrieval: ${rr.file} (${rr.count} times)`,
        description: `${rr.file} was read ${rr.count} times in session ${session.id}. AI agents repeatedly retrieve files when instruction context lacks clear summaries or architectural relationships.`,
        evidence: [
          {
            file: rr.file,
            snippet: `Retrieved ${rr.count} times in session ${session.id}`,
            source: p,
          },
        ],
        impact: {
          tokens: rr.count * 1200,
          latency: rr.count * 3,
        },
        recommendation: `Add module summary or export structure of ${rr.file} to repository context docs so agent remembers interface without re-reading.`,
      });
    }

    // 2. Repeated Searches Findings
    for (const rs of session.repeatedSearches) {
      findings.push({
        id: `runtime-repeated-search-${session.id}-${rs.query.replace(/[^a-zA-Z0-9]/g, "-")}`,
        ruleId: "runtime/repeated-searches",
        category: "runtime",
        severity: "medium",
        confidence: 0.85,
        title: `Repeated search operations for "${rs.query}" (${rs.count} times)`,
        description: `Agent executed ${rs.count} repetitive search queries for "${rs.query}". Indicates poor directory discoverability or lack of documentation of key service locations.`,
        evidence: [
          {
            file: p,
            snippet: `Query "${rs.query}" repeated ${rs.count} times`,
            source: "session trace",
          },
        ],
        recommendation: `Document the entry point or implementation directory for "${rs.query}" in AGENTS.md.`,
      });
    }

    // 3. Repeated Command Failures Findings
    for (const rf of session.repeatedFailures) {
      findings.push({
        id: `runtime-repeated-failure-${session.id}-${rf.command.replace(/[^a-zA-Z0-9]/g, "-")}`,
        ruleId: "runtime/repeated-command-failures",
        category: "runtime",
        severity: "high",
        confidence: 0.95,
        title: `Repeated failed command: "${rf.command}" (${rf.count} times)`,
        description: `Same command failed ${rf.count} times in session without successful configuration adjustments. Agent wasted turns in trial-and-error loop.`,
        evidence: [
          {
            file: p,
            snippet: `Command "${rf.command}" failed ${rf.count} times`,
            source: "session trace",
          },
        ],
        impact: {
          reliability: 8,
        },
        recommendation: `Verify prerequisites for running "${rf.command}" or provide pre-run setup script in AGENTS.md.`,
      });
    }

    // 4. Oversized Tool Output Findings
    if (session.toolOutputTokens > 20000) {
      findings.push({
        id: `runtime-oversized-output-${session.id}`,
        ruleId: "runtime/oversized-tool-output",
        category: "runtime",
        severity: "medium",
        confidence: 0.85,
        title: `Tool output bloat detected (${session.toolOutputTokens.toLocaleString()} tokens)`,
        description: `Tool outputs consumed ${session.toolOutputTokens.toLocaleString()} tokens in session ${session.id}. Unfiltered logs or full build outputs flood agent context and dilute attention.`,
        evidence: [
          {
            file: p,
            snippet: `${session.toolOutputTokens.toLocaleString()} tool output tokens`,
            source: "session trace",
          },
        ],
        impact: {
          tokens: session.toolOutputTokens - 4000,
        },
        recommendation: "Configure commands with quiet flags (e.g. `vitest run --reporter=basic` or `pnpm test --silent`).",
      });
    }

    // 5. Retry loop (new): native retry/restore signals or heavy repeated failures
    const retries = session.retriesCount || 0;
    const restores = session.restoresCount || 0;
    if (retries >= 3 || restores >= 2) {
      findings.push({
        id: `runtime-retry-loop-${session.id}`,
        ruleId: "runtime/retry-loop",
        category: "runtime",
        severity: "medium",
        confidence: 0.8,
        title: `Retry/restore loop detected (${retries} retries, ${restores} restores)`,
        description: `Session ${session.id} shows ${retries} retries and ${restores} checkpoint restores. The agent is looping instead of converging — usually missing error context or flaky verification commands.`,
        evidence: [
          {
            file: p,
            snippet: `${retries} retries, ${restores} restores in session ${session.id}`,
            source: "session trace",
          },
        ],
        recommendation: "Capture the first failure reason into AGENTS.md troubleshooting notes so the next attempt doesn't repeat it.",
      });
    }

    // 6. Approval-blocked (new): many approvals but no edits
    const approvals = session.approvalsCount || 0;
    if (approvals >= 3 && session.filesEdited.length === 0) {
      findings.push({
        id: `runtime-approval-blocked-${session.id}`,
        ruleId: "runtime/approval-blocked",
        category: "runtime",
        severity: "low",
        confidence: 0.75,
        title: `Approval friction without progress (${approvals} approvals, 0 edits)`,
        description: `Session ${session.id} required ${approvals} approvals but produced no file edits. Approval gates may be blocking the agent, or the task is underspecified.`,
        evidence: [
          {
            file: p,
            snippet: `${approvals} approvals, 0 files edited`,
            source: "session trace",
          },
        ],
        recommendation: "Prefer scoped auto-approve for read-only tools (read/search) and keep approvals for write/exec.",
      });
    }
  }

  sessions.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id));
  return { findings, sessions };
}

/**
 * Collect parsed sessions whose trace files were last modified within
 * [startMs, endMs]. When native session bounds exist, they are checked too so
 * shared trace files do not pull historical sessions into a live run.
 */
export async function collectSessionsInRange(
  repoRoot: string,
  startMs: number,
  endMs: number,
  opts: AnalyzeRuntimeOptions = {}
): Promise<SessionMetrics[]> {
  const allowSensitive =
    opts.allowSensitive ?? process.env.AGENTDOCTOR_ALLOW_SENSITIVE === "1";
  const includeGlobal = shouldIncludeGlobal(opts.includeGlobal);
  const maxGlobal = opts.maxGlobalSessions ?? 20;

  const refs: RawSessionRef[] = [...(await detectRepoSessions(repoRoot))];
  if (includeGlobal) {
    refs.push(...(await detectGlobalSessions(repoRoot, maxGlobal)));
  }

  const sessions: SessionMetrics[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = path.resolve(ref.sourcePath);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.mtime < startMs || ref.mtime > endMs) continue;
    try {
      const adapter = pickAdapter(ref);
      const parsed = adapter.parseMany
        ? await adapter.parseMany(ref)
        : [(await adapter.parse(ref)) as SessionMetrics | null];
      for (const s of parsed) {
        if (!s) continue;
        const sessionStart =
          s.startedAtMs ?? (Date.parse(s.date || "") || undefined);
        const sessionEnd =
          s.endedAtMs ??
          (sessionStart !== undefined && !s.durationUnknown
            ? sessionStart + s.durationSeconds * 1000
            : undefined);
        // A shared OTLP/JSONL file can have a fresh mtime even when most of
        // its sessions are historical. Prefer native session bounds so only
        // evidence from this task window is correlated.
        if (sessionStart !== undefined && sessionStart > endMs) continue;
        if (sessionEnd !== undefined && sessionEnd < startMs) continue;
        if (!s.sourcePath) s.sourcePath = ref.sourcePath;
        if (!allowSensitive) redactSession(s);
        sessions.push(s);
      }
    } catch {
      // ignore one bad session file
    }
  }
  return sessions;
}
