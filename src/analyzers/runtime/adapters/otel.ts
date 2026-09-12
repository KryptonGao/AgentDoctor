import * as fs from "node:fs";
import * as path from "node:path";
import { SessionMetrics } from "../../../core/types.js";
import { estimateTokens } from "../../context/tokenCounter.js";
import { finalizeSession, emptyPartial } from "../sessionBuilder.js";
import { RawSessionRef, SessionAdapter, formatTimeOffset } from "../sessionTypes.js";

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: { key: string; value: AnyValue }[] };
};

function anyValue(v: AnyValue | undefined): string | number | boolean | undefined {
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (Array.isArray(v.arrayValue?.values)) return JSON.stringify(v.arrayValue.values);
  if (Array.isArray(v.kvlistValue?.values)) {
    return JSON.stringify(Object.fromEntries(v.kvlistValue.values.map((entry) => [entry.key, anyValue(entry.value)])));
  }
  return undefined;
}

function attrsToMap(attrs: { key: string; value: AnyValue }[] | undefined): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>();
  if (!Array.isArray(attrs)) return m;
  for (const a of attrs) {
    if (!a || typeof a.key !== "string") continue;
    const v = anyValue(a.value);
    if (v !== undefined) m.set(a.key, v);
  }
  return m;
}

function attrText(attrs: Map<string, string | number | boolean>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs.get(key);
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function attrNumber(attrs: Map<string, string | number | boolean>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = attrs.get(key);
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function parseToolArgs(value: string | number | boolean | undefined): Record<string, any> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { _raw: String(parsed) };
  } catch {
    return { _raw: value };
  }
}

function nanoToSec(v: unknown): number | null {
  if (typeof v === "number") return Math.floor(v / 1e9);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = BigInt(v.trim());
    return Number(n / 1000000000n);
  }
  return null;
}

interface FlatSpan {
  traceId: string;
  name: string;
  startSec: number | null;
  endSec: number | null;
  attrs: Map<string, string | number | boolean>;
  events: { name: string; attrs: Map<string, string | number | boolean> }[];
  statusCode: number;
  serviceName?: string;
}

function extractSpans(doc: any): FlatSpan[] {
  const out: FlatSpan[] = [];
  const resourceSpans = doc?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans) {
    const resAttrs = attrsToMap(rs?.resource?.attributes);
    const serviceName =
      (resAttrs.get("service.name") as string | undefined) ||
      (resAttrs.get("service.namespace") as string | undefined);
    const scopeSpans = rs?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = ss?.spans;
      if (!Array.isArray(spans)) continue;
      for (const s of spans) {
        const attrs = new Map(resAttrs);
        for (const [key, value] of attrsToMap(s?.attributes)) attrs.set(key, value);
        out.push({
          traceId: String(s?.traceId ?? ""),
          name: String(s?.name ?? "span"),
          startSec: nanoToSec(s?.startTimeUnixNano),
          endSec: nanoToSec(s?.endTimeUnixNano),
          attrs,
          events: Array.isArray(s?.events)
            ? s.events.map((event: any) => ({ name: String(event?.name ?? "event"), attrs: attrsToMap(event?.attributes) }))
            : [],
          statusCode:
            typeof s?.status?.code === "number"
              ? s.status.code
              : String(s?.status?.code ?? "").toLowerCase() === "error"
                ? 2
                : 0,
          serviceName: typeof serviceName === "string" ? serviceName : undefined,
        });
      }
    }
  }
  return out;
}

function mapAgentName(serviceName: string | undefined, provider: unknown): SessionMetrics["agentName"] {
  const hay = `${serviceName ?? ""} ${provider ?? ""}`.toLowerCase();
  if (hay.includes("claude")) return "Claude Code";
  if (hay.includes("codex") || hay.includes("openai")) return "Codex";
  if (hay.includes("cursor")) return "Cursor";
  if (hay.includes("gemini") || hay.includes("google") || hay.includes("gcp")) return "Gemini CLI";
  if (hay.includes("opencode")) return "OpenCode";
  return "Other";
}

/**
 * OTLP file-exporter JSONLines: one TracesData per line.
 * Groups by gen_ai.conversation.id (fallback traceId).
 */
export function parseOtelContent(content: string, filePath: string): SessionMetrics[] {
  const docs: any[] = [];
  const trimmed = content.trim();
  if (!trimmed) return [];
  // Try single JSON doc first, fall back to JSONL.
  try {
    const single = JSON.parse(trimmed);
    if (single?.resourceSpans) docs.push(single);
    else throw new Error("not otlp");
  } catch {
    for (const raw of trimmed.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const doc = JSON.parse(line);
        if (doc?.resourceSpans) docs.push(doc);
      } catch {
        continue;
      }
    }
  }
  if (docs.length === 0) return [];

  const spans: FlatSpan[] = docs.flatMap(extractSpans).filter((s) => s.traceId);
  if (spans.length === 0) return [];

  const groups = new Map<string, FlatSpan[]>();
  for (const s of spans) {
    const conv = s.attrs.get("gen_ai.conversation.id");
    const key = (typeof conv === "string" && conv) || s.traceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const base = path.basename(filePath, path.extname(filePath));
  const sessions: SessionMetrics[] = [];

  for (const [key, list] of groups) {
    list.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
    const first = list.find((s) => s.attrs.get("gen_ai.agent.name") || s.serviceName) ?? list[0];
    const provider = first.attrs.get("gen_ai.provider.name") ?? first.attrs.get("gen_ai.system");
    const agent = first.attrs.get("gen_ai.agent.name") ?? provider;
    const partial = emptyPartial(key.slice(0, 32) || base, mapAgentName(first.serviceName, agent));
    partial.sourcePath = filePath;
    partial.nativeId = key;

    const task = attrText(first.attrs, "gen_ai.task.title", "gen_ai.task", "agent.task.title", "task.title");
    if (task) partial.taskTitle = task.slice(0, 140);
    const cwd = attrText(first.attrs, "gen_ai.session.cwd", "process.cwd", "code.workspace");
    if (cwd) partial.sessionCwd = cwd;
    const branch = attrText(first.attrs, "vcs.repository.ref.name", "git.branch", "vcs.ref.name");
    const commit = attrText(first.attrs, "vcs.ref.head.revision", "git.commit", "vcs.commit");
    if (branch) partial.gitBranch = branch;
    if (commit) partial.gitCommit = commit;
    const prNumber = attrNumber(first.attrs, "vcs.pull_request.number", "git.pr.number", "pr.number");
    if (prNumber != null) partial.prNumber = prNumber;
    const prTitle = attrText(first.attrs, "vcs.pull_request.title", "git.pr.title", "pr.title");
    if (prTitle) partial.prTitle = prTitle.slice(0, 200);

    const starts = list.map((s) => s.startSec).filter((v): v is number => v != null);
    const ends = list.map((s) => s.endSec).filter((v): v is number => v != null);
    const startSec = starts.length ? Math.min(...starts) : null;
    const endSec = ends.length ? Math.max(...ends) : null;
    if (startSec != null && endSec != null && endSec >= startSec) {
      partial.durationSeconds = endSec - startSec;
      partial.durationUnknown = false;
      partial.startedAtMs = startSec * 1000;
      partial.endedAtMs = endSec * 1000;
      const d = new Date(startSec * 1000);
      partial.date = Number.isNaN(d.getTime()) ? "Unknown" : d.toISOString().slice(0, 10);
    }

    const model =
      (first.attrs.get("gen_ai.request.model") as string | undefined) ||
      (first.attrs.get("gen_ai.response.model") as string | undefined);
    if (model) partial.model = model;

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let tokensSeen = false;

    for (const s of list) {
      const op = String(s.attrs.get("gen_ai.operation.name") ?? "");
      const lowerOp = op.toLowerCase();
      const at = s.startSec ?? startSec ?? 0;
      const offset = startSec != null && s.startSec != null ? Math.max(0, s.startSec - startSec) : 0;
      const errorType = attrText(s.attrs, "error.type", "exception.type", "error.code");
      const errorMessage = attrText(s.attrs, "error.message", "exception.message", "exception.stacktrace");
      const eventFailure = s.events.some((event) => /error|exception|failure/i.test(event.name));
      const eventErrorMessage = s.events.map((event) => attrText(event.attrs, "error.message", "exception.message", "message")).find(Boolean);
      const failed = s.statusCode === 2 || !!errorType || eventFailure;
      const finish = s.attrs.get("gen_ai.response.finish_reasons");

      for (const event of s.events) {
        const retryCount = attrNumber(event.attrs, "gen_ai.retry.count", "retry.count", "agent.retry.count");
        if (retryCount != null) partial.retriesCount = (partial.retriesCount || 0) + retryCount;
        else if (/retry|restore|checkpoint/i.test(event.name)) partial.retriesCount = (partial.retriesCount || 0) + 1;
        const approval = attrText(event.attrs, "gen_ai.approval.status", "gen_ai.approval.required", "approval.status", "permission.status");
        if (approval && /request|pending|denied|blocked|true|approval/i.test(approval)) partial.approvalsCount = (partial.approvalsCount || 0) + 1;
      }

      const iNew = attrNumber(s.attrs, "gen_ai.usage.input_tokens", "gen_ai.response.input_tokens");
      const oNew = attrNumber(s.attrs, "gen_ai.usage.output_tokens", "gen_ai.response.output_tokens");
      const iLegacy = attrNumber(s.attrs, "gen_ai.usage.prompt_tokens");
      const oLegacy = attrNumber(s.attrs, "gen_ai.usage.completion_tokens");
      const i = iNew ?? iLegacy ?? 0;
      const o = oNew ?? oLegacy ?? 0;
      if (i > 0 || o > 0) {
        input += i;
        output += o;
        tokensSeen = true;
        partial.contextTokens = Math.max(partial.contextTokens ?? 0, i);
      }
      const cr = attrNumber(s.attrs, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_tokens", "gen_ai.usage.cached_input_tokens") ?? 0;
      const cc = attrNumber(s.attrs, "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_tokens") ?? 0;
      if (cr > 0 || cc > 0) {
        cacheRead += cr;
        cacheCreation += cc;
        tokensSeen = true;
      }
      const contextWindow = attrNumber(
        s.attrs,
        "gen_ai.request.max_tokens",
        "gen_ai.request.context_window",
        "gen_ai.request.context_window_tokens",
        "gen_ai.response.model_context_window",
        "context.window.size",
        "context_window_tokens"
      );
      if (contextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);

      const retryCount = attrNumber(s.attrs, "gen_ai.retry.count", "retry.count", "agent.retry.count");
      if (retryCount != null) partial.retriesCount = (partial.retriesCount || 0) + retryCount;
      else if (/retry|restore|checkpoint/i.test(`${s.name} ${op}`)) partial.retriesCount = (partial.retriesCount || 0) + 1;
      const approval = attrText(s.attrs, "gen_ai.approval.status", "gen_ai.approval.required", "approval.status", "permission.status");
      if (approval && /request|pending|denied|blocked|true|approval/i.test(approval)) partial.approvalsCount = (partial.approvalsCount || 0) + 1;

      if (lowerOp === "execute_tool" || lowerOp === "tool") {
        const toolName = String(s.attrs.get("gen_ai.tool.name") ?? "tool");
        partial.toolCalls++;
        if (failed) {
          partial.failedToolCalls++;
          if (!partial.failureReasons) partial.failureReasons = [];
          partial.failureReasons.push({
            action: `Tool ${toolName}`.slice(0, 200),
            reason: (errorMessage || errorType || eventErrorMessage || "span error").slice(0, 300),
          });
        }
        const argsValue = s.attrs.get("gen_ai.tool.call.arguments") ?? s.attrs.get("gen_ai.tool.input");
        const args = parseToolArgs(argsValue);
        const toolOutput = attrText(s.attrs, "gen_ai.tool.call.result", "gen_ai.tool.output", "gen_ai.tool.response");
        if (toolOutput) partial.toolOutputTokens += estimateTokens(toolOutput);
        const file = String(args.path ?? args.file ?? args.file_path ?? "");
        const lowerTool = toolName.toLowerCase();
        let action = `Tool ${toolName}`;
        if (/bash|shell|command|exec|terminal|run/.test(lowerTool)) {
          partial.commandsExecuted++;
          action = `Run ${String(args.command ?? args.cmd ?? args._raw ?? toolName)}`;
        } else if (/read|view|open|cat/.test(lowerTool)) {
          if (file) partial.filesRead.push(file);
          action = `Read ${file || toolName}`;
        } else if (/write|edit|patch|replace|delete/.test(lowerTool)) {
          if (file) partial.filesEdited.push(file);
          action = `Edit ${file || toolName}`;
        } else if (/search|grep|glob|find/.test(lowerTool)) {
          const query = String(args.pattern ?? args.query ?? args.path ?? args._raw ?? toolName);
          partial.searchOperations.push(query);
          action = `Search ${query}`;
        }
        partial.timeline.push({
          timeOffset: formatTimeOffset(offset),
          action: action.slice(0, 200),
          tool: toolName,
          status: failed ? "failed" : "success",
          detail: failed ? (errorMessage || errorType || eventErrorMessage || String(finish ?? "span error")).slice(0, 300) : finish != null ? String(finish).slice(0, 200) : undefined,
        });
        void at;
        continue;
      }

      if (lowerOp === "chat" || lowerOp === "generate_content" || lowerOp === "text_completion" || lowerOp === "invoke_agent") {
        if (lowerOp === "invoke_agent" && partial.timeline.length < 200) {
          partial.timeline.push({
            timeOffset: formatTimeOffset(offset),
            action: s.name.slice(0, 200),
            status: failed ? "failed" : "success",
            detail: failed ? (errorMessage || errorType || eventErrorMessage || "span error").slice(0, 300) : finish != null ? String(finish).slice(0, 200) : undefined,
          });
        }
        if (failed) {
          if (!partial.failureReasons) partial.failureReasons = [];
          partial.failedToolCalls++;
          partial.failureReasons.push({ action: s.name.slice(0, 200), reason: (errorMessage || errorType || eventErrorMessage || "span error").slice(0, 300) });
        }
        continue;
      }

      if (lowerOp === "retrieval") {
        const q = attrText(s.attrs, "gen_ai.retrieval.query_text", "gen_ai.tool.call.query");
        if (q) partial.searchOperations.push(q.slice(0, 200));
        continue;
      }
    }

    if (tokensSeen) {
      partial.tokenUsage = { input, output, total: input + output };
      partial.tokensUnknown = false;
      if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
    } else {
      // No output payload was observed. Do not turn tool names into fabricated
      // token counts; tokenUsage remains zero with tokensUnknown=true.
      partial.toolOutputTokens = 0;
    }

    if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.taskTitle && partial.contextWindowTokens == null) continue;
    sessions.push(finalizeSession(partial));
  }

  return sessions;
}

export const otelAdapter: SessionAdapter = {
  id: "otel",
  async detect(): Promise<RawSessionRef[]> {
    return [];
  },
  async parse(ref: RawSessionRef): Promise<SessionMetrics | null> {
    const all = await this.parseMany!(ref);
    return all[0] ?? null;
  },
  async parseMany(ref: RawSessionRef): Promise<SessionMetrics[]> {
    try {
      const content = fs.readFileSync(ref.sourcePath, "utf-8");
      return parseOtelContent(content, ref.sourcePath);
    } catch {
      return [];
    }
  },
  canParseFile(_filePath: string, firstChunk: string): boolean {
    const t = firstChunk.trimStart().slice(0, 500);
    return t.includes('"resourceSpans"');
  },
};
