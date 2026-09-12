import * as fs from "node:fs";
import * as path from "node:path";
import { SessionMetrics } from "../../../core/types.js";
import { estimateTokens } from "../../context/tokenCounter.js";
import { finalizeSession, emptyPartial } from "../sessionBuilder.js";
import { RawSessionRef, SessionAdapter, formatTimeOffset } from "../sessionTypes.js";

function parseTs(v: unknown): number | null {
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const r = value as Record<string, any>;
    if (typeof r.text === "string") return r.text;
    if (r.content !== undefined) return textFrom(r.content);
    if (r.output !== undefined) return textFrom(r.output);
    if (r.message !== undefined) return textFrom(r.message);
    if (r.summary !== undefined) return textFrom(r.summary);
  }
  return "";
}

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function contextWindowFrom(value: unknown): number | null {
  const direct = numberFrom(value);
  if (direct != null) return direct;
  const r = asRecord(value);
  return numberFrom(r.limit, r.tokens, r.size, r.max_tokens, r.context_window);
}

function safeJsonParseArgs(args: unknown): Record<string, any> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, any>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
      return { _raw: String(parsed) };
    } catch {
      return { _raw: args };
    }
  }
  return {};
}

type CodexPartial = ReturnType<typeof emptyPartial>;

function recordFailure(partial: CodexPartial, action: string, reason: string, at: number, index?: number): void {
  const safeAction = action.slice(0, 200);
  const safeReason = reason.slice(0, 300) || "failed";
  partial.failedToolCalls++;
  if (index !== undefined && partial.timeline[index]) {
    partial.timeline[index].status = "failed";
    partial.timeline[index].detail = safeReason;
  } else {
    partial.timeline.push({ timeOffset: formatTimeOffset(at), action: safeAction, tool: "codex", status: "failed", detail: safeReason });
  }
  if (!partial.failureReasons) partial.failureReasons = [];
  partial.failureReasons.push({ action: safeAction, reason: safeReason });
}

function classifyCommand(partial: CodexPartial, command: string): void {
  const trimmed = command.trim();
  if (/^(?:rg|ripgrep|grep|git\s+grep|find)\b/i.test(trimmed)) {
    partial.searchOperations.push(trimmed.slice(0, 200));
  } else if (/^(?:cat|head|tail|sed|less|more)\b/i.test(trimmed)) {
    const match = trimmed.match(/(?:^|\s)([^\s|>]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|css|html))(?:\s|$)/i);
    if (match?.[1]) partial.filesRead.push(match[1]);
  }
}

function addToolTimeline(
  partial: CodexPartial,
  at: number,
  name: string,
  args: Record<string, any>,
  status: "success" | "failed" = "success",
  detail?: string
): number {
  const lower = name.toLowerCase();
  const file = String(args.path ?? args.file ?? args.file_path ?? args.filename ?? "");
  let action = name;
  if (/shell|bash|command|exec|terminal|run/.test(lower)) {
    const command = String(args.command ?? args.cmd ?? args.script ?? args._raw ?? name);
    partial.commandsExecuted++;
    classifyCommand(partial, command);
    action = `Run ${command}`;
  } else if (/diff|edit|write|apply|patch|replace|delete/.test(lower)) {
    if (file) partial.filesEdited.push(file);
    action = `Edit ${file || name}`;
  } else if (/read|view|cat|open/.test(lower)) {
    if (file) partial.filesRead.push(file);
    action = `Read ${file || name}`;
  } else if (/search|grep|glob|find/.test(lower)) {
    const query = String(args.pattern ?? args.query ?? args.path ?? args._raw ?? name);
    partial.searchOperations.push(query);
    action = `Search ${query}`;
  }
  const index = partial.timeline.length;
  partial.timeline.push({ timeOffset: formatTimeOffset(at), action: action.slice(0, 200), tool: name, status, detail });
  return index;
}

function commandItemAction(item: Record<string, any>): { action: string; command: string } {
  const command = String(item.command ?? item.cmd ?? item.process ?? "command");
  return { action: `Run ${command}`.slice(0, 200), command };
}

/**
 * Codex CLI rollout JSONL: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Supports both the older function_call records and current response_item /
 * event_msg CommandExecution + token_usage_record records.
 */
export function parseCodexLines(lines: string[], filePath: string): SessionMetrics | null {
  const base = path.basename(filePath, path.extname(filePath));
  const partial = emptyPartial(base, "Codex");
  partial.sourcePath = filePath;

  let startSec: number | null = null;
  let endSec: number | null = null;
  let recordInput = 0;
  let recordOutput = 0;
  let recordTotal = 0;
  let recordCacheRead = 0;
  let recordCacheCreation = 0;
  let eventInput = 0;
  let eventOutput = 0;
  let eventTotal = 0;
  let eventCacheRead = 0;
  let eventCacheCreation = 0;
  let genericInput = 0;
  let genericOutput = 0;
  let genericTotal = 0;
  let genericCacheRead = 0;
  let genericCacheCreation = 0;
  let tokensSeen = false;
  let tokenUsageRecordSeen = false;
  let approvals = 0;
  let retries = 0;
  let completedNativeTools = false;
  const pendingCalls = new Map<string, { name: string; sec: number; timelineIndex: number }>();
  const customCalls: { id: string; name: string; args: Record<string, any>; sec: number }[] = [];
  const customOutputs = new Map<string, { text: string; failed: boolean; detail?: string }>();

  const noteTime = (sec: number | null) => {
    if (sec == null) return;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };

  const pushTimeline = (sec: number, action: string, tool: string | undefined, status: "success" | "failed", detail?: string): number => {
    const offset = startSec != null ? Math.max(0, sec - startSec) : partial.timeline.length * 30;
    const index = partial.timeline.length;
    partial.timeline.push({ timeOffset: formatTimeOffset(offset), action: action.slice(0, 200), tool, status, detail });
    return index;
  };

  const addUsage = (usageValue: unknown, target: "record" | "event" | "eventSnapshot" | "generic") => {
    const usage = asRecord(usageValue);
    if (Object.keys(usage).length === 0) return;
    const input = numberFrom(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens) ?? 0;
    const output = numberFrom(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens) ?? 0;
    const total = numberFrom(usage.total_tokens, usage.totalTokens, usage.total) ?? input + output;
    const cacheRead = numberFrom(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cacheReadInputTokens) ?? 0;
    const cacheCreation = numberFrom(usage.cache_write_input_tokens, usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) ?? 0;
    if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && cacheCreation === 0) return;
    tokensSeen = true;
    if (target === "record") {
      // Codex token_usage_record is a cumulative snapshot (input_tokens and
      // total_tokens grow across turns), so retain the newest record instead
      // of summing every snapshot.
      recordInput = input;
      recordOutput = output;
      recordTotal = total;
      recordCacheRead = cacheRead;
      recordCacheCreation = cacheCreation;
    } else if (target === "eventSnapshot") {
      // Some older event_msg payloads expose only total_token_usage, which is
      // also cumulative. Keep its latest snapshot just like token records.
      eventInput = input;
      eventOutput = output;
      eventTotal = total;
      eventCacheRead = cacheRead;
      eventCacheCreation = cacheCreation;
    } else if (target === "event") {
      eventInput += input;
      eventOutput += output;
      eventTotal += total;
      eventCacheRead += cacheRead;
      eventCacheCreation += cacheCreation;
    } else {
      genericInput += input;
      genericOutput += output;
      genericTotal += total;
      genericCacheRead += cacheRead;
      genericCacheCreation += cacheCreation;
    }
    partial.contextTokens = Math.max(partial.contextTokens ?? 0, input);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let evt: Record<string, any>;
    try {
      evt = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    const sec = parseTs(evt.timestamp ?? evt.time);
    noteTime(sec);
    const at = sec ?? (endSec ?? 0);
    const type = String(evt.type ?? "");
    const p = asRecord(evt.payload ?? evt);
    const payloadType = String(p.type ?? p.msg_type ?? p.msgType ?? "");

    // Metadata records must not swallow token_usage_record or other events
    // merely because those payloads also carry session_id/cwd.
    if (type === "session_meta" || type === "turn_context") {
      const meta = type === "session_meta" ? asRecord(p.session_meta ?? p) : p;
      if (typeof meta.session_id === "string") partial.nativeId = meta.session_id;
      if (typeof meta.sessionId === "string") partial.nativeId = meta.sessionId;
      if (typeof meta.id === "string" && !partial.nativeId) partial.nativeId = meta.id;
      if (typeof meta.model === "string") partial.model = meta.model;
      if (typeof meta.cwd === "string") partial.sessionCwd = meta.cwd;
      const task = textFrom(meta.task ?? meta.title ?? meta.summary ?? meta.prompt);
      if (task && !partial.taskTitle) partial.taskTitle = task.slice(0, 140);
      if (meta.git && typeof meta.git === "object") {
        const git = asRecord(meta.git);
        if (typeof git.branch === "string") partial.gitBranch = git.branch;
        if (typeof git.commit === "string") partial.gitCommit = git.commit;
        if (typeof git.commit_hash === "string" && !partial.gitCommit) partial.gitCommit = git.commit_hash;
        if (typeof git.sha === "string" && !partial.gitCommit) partial.gitCommit = git.sha;
        if (typeof git.dirty === "boolean") partial.gitDirty = git.dirty;
        if (typeof git.message === "string") partial.gitMessage = git.message;
      }
      const window = contextWindowFrom(meta.context_window ?? meta.contextWindowTokens ?? meta.model_context_window);
      if (window != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, window);
      if (type === "session_meta" || type === "turn_context") continue;
    }

    if (!partial.nativeId && typeof p.session_id === "string") partial.nativeId = p.session_id;
    if (!partial.sessionCwd && typeof p.cwd === "string") partial.sessionCwd = p.cwd;
    if (typeof p.model === "string" && !partial.model) partial.model = p.model;

    const genericContextWindow = contextWindowFrom(p.model_context_window ?? p.context_window ?? evt.model_context_window);
    if (genericContextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, genericContextWindow);

    if (type === "compacted" || payloadType === "compacted" || p.replacement_history || p.contextCompaction || p.context_compaction) {
      retries++;
    }

    if (type === "token_usage_record") {
      tokenUsageRecordSeen = true;
      addUsage(p.usage ?? p, "record");
    } else if (type === "event_msg" && payloadType === "token_count") {
      const info = asRecord(p.info);
      if (info.last_token_usage ?? p.count ?? p.tokens) addUsage(info.last_token_usage ?? p.count ?? p.tokens, "event");
      else if (info.total_token_usage) addUsage(info.total_token_usage, "eventSnapshot");
      const window = contextWindowFrom(info.model_context_window ?? p.model_context_window);
      if (window != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, window);
    } else {
      addUsage(p.usage ?? p.msg?.usage ?? p.payload?.usage, "generic");
    }

    const signal = `${type} ${payloadType} ${textFrom(p.info)} ${textFrom(p.message)}`;
    if (/approval|permission/i.test(signal) && /request|requested|denied|blocked|confirm|approval/i.test(signal)) approvals++;

    // Current Codex emits completed tool records inside event_msg. They are
    // authoritative; response_item custom calls are retained as a fallback
    // for older rollouts so the same call is never counted twice.
    if (type === "event_msg" && payloadType === "item_completed" && p.item && typeof p.item === "object") {
      const item = asRecord(p.item);
      const itemType = String(item.type ?? item.kind ?? "");
      if (itemType === "UserMessage") {
        const task = textFrom(item.content ?? item.message ?? item.text);
        if (task && !partial.taskTitle) partial.taskTitle = task.trim().slice(0, 140);
      } else if (itemType === "CommandExecution") {
        completedNativeTools = true;
        const { action, command } = commandItemAction(item);
        partial.toolCalls++;
        partial.commandsExecuted++;
        classifyCommand(partial, command);
        const exitCode = numberFrom(item.exit_code, item.exitCode);
        const itemStatus = String(item.status ?? "").toLowerCase();
        const failed = (exitCode != null && exitCode !== 0) || /fail|error|cancel|abort/.test(itemStatus);
        const output = textFrom(item.aggregated_output ?? item.stdout ?? item.stderr ?? item.output);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const detail = failed ? (textFrom(item.stderr) || output || (exitCode != null ? `exit ${exitCode}` : "command failed")).slice(0, 300) : undefined;
        const index = pushTimeline(at, action, "bash", failed ? "failed" : "success", detail);
        if (failed) recordFailure(partial, action, detail || "command failed", at, index);
      } else if (itemType === "Extension") {
        completedNativeTools = true;
        const name = String(item.kind ?? item.name ?? item.extension ?? "extension");
        const query = textFrom(item.query ?? item.input ?? item.arguments);
        partial.toolCalls++;
        if (/search|web|grep|find/i.test(name)) partial.searchOperations.push(query || name);
        const output = textFrom(item.output ?? item.result ?? item.aggregated_output);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const failed = /fail|error/i.test(String(item.status ?? ""));
        const action = /search|web/i.test(name) ? `Search ${query || name}` : name;
        const index = pushTimeline(at, action, name, failed ? "failed" : "success", failed ? output.slice(0, 300) : undefined);
        if (failed) recordFailure(partial, action, output || "extension failed", at, index);
      } else if (itemType === "FileChange") {
        completedNativeTools = true;
        const changes = item.changes && typeof item.changes === "object" ? Object.keys(item.changes) : [];
        for (const file of changes) partial.filesEdited.push(file);
        const output = textFrom(item.stdout ?? item.stderr ?? item.output);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const status = String(item.status ?? "").toLowerCase();
        const failed = /fail|error|cancel|abort/.test(status) || item.failed === true;
        const action = `Edit ${changes.length === 1 ? changes[0] : `${changes.length} files`}`;
        partial.toolCalls++;
        const index = pushTimeline(at, action, "FileChange", failed ? "failed" : "success", failed ? output.slice(0, 300) : undefined);
        if (failed) recordFailure(partial, action, output || "file change failed", at, index);
      }
    }

    if (type === "response_item") {
      const kind = payloadType || String(p.kind ?? "");
      if (kind === "function_call") {
        const name = String(p.name ?? "tool");
        const callId = String(p.call_id ?? p.callId ?? `${partial.toolCalls}`);
        partial.toolCalls++;
        const index = addToolTimeline(partial, at, name, safeJsonParseArgs(p.arguments));
        pendingCalls.set(callId, { name, sec: at, timelineIndex: index });
      } else if (kind === "custom_tool_call") {
        customCalls.push({
          id: String(p.call_id ?? p.callId ?? p.id ?? `${customCalls.length}`),
          name: String(p.name ?? p.tool_name ?? "tool"),
          args: safeJsonParseArgs(p.input ?? p.arguments ?? p.args),
          sec: at,
        });
      } else if (kind === "function_call_output") {
        const callId = String(p.call_id ?? p.callId ?? "");
        const pending = callId ? pendingCalls.get(callId) : undefined;
        const output = textFrom(p.output ?? p.result ?? p.text);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const commandExecution = asRecord(p.commandExecution ?? p.command_execution);
        const exitCode = numberFrom(commandExecution.exitCode, commandExecution.exit_code);
        const status = String(commandExecution.status ?? "").toLowerCase();
        const failed = (exitCode != null && exitCode !== 0) || /fail|error|cancel|abort/.test(status) || /error|fail|exception|traceback/i.test(output.slice(0, 500));
        if (failed) {
          const reason = output || (exitCode != null ? `exit ${exitCode}` : status) || "tool failed";
          recordFailure(partial, `Run ${commandExecution.command ?? pending?.name ?? "command"}`, reason, at, pending?.timelineIndex);
        }
        if (callId) pendingCalls.delete(callId);
      } else if (kind === "custom_tool_call_output") {
        const callId = String(p.call_id ?? p.callId ?? p.id ?? "");
        const output = textFrom(p.output ?? p.result ?? p.text);
        const failed = /error|fail|exception|traceback/i.test(output.slice(0, 500));
        if (callId) customOutputs.set(callId, { text: output, failed, detail: output.slice(0, 300) });
      } else if (kind === "message") {
        const content = textFrom(p.content);
        if (String(p.role ?? "").toLowerCase() === "user" && content && !partial.taskTitle) partial.taskTitle = content.trim().slice(0, 140);
        if (content) partial.toolOutputTokens += estimateTokens(content);
      }
    }
  }

  // Older Codex rollouts have no item_completed records. Materialize the
  // custom tool calls only in that case, and then apply their outputs.
  if (!completedNativeTools) {
    for (const call of customCalls) {
      partial.toolCalls++;
      const index = addToolTimeline(partial, call.sec, call.name, call.args);
      const result = customOutputs.get(call.id);
      if (result?.text) partial.toolOutputTokens += estimateTokens(result.text);
      if (result?.failed) recordFailure(partial, call.name, result.detail || "tool failed", call.sec, index);
    }
  }

  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.model && !partial.taskTitle) return null;

  if (startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1000;
    partial.endedAtMs = endSec * 1000;
    const d = new Date(startSec * 1000);
    partial.date = Number.isNaN(d.getTime()) ? "Unknown" : d.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    const input = tokenUsageRecordSeen ? recordInput : eventInput + genericInput;
    const output = tokenUsageRecordSeen ? recordOutput : eventOutput + genericOutput;
    const total = tokenUsageRecordSeen ? recordTotal : eventTotal + genericTotal;
    const cacheRead = tokenUsageRecordSeen ? recordCacheRead : eventCacheRead + genericCacheRead;
    const cacheCreation = tokenUsageRecordSeen ? recordCacheCreation : eventCacheCreation + genericCacheCreation;
    partial.tokenUsage = { input, output, total: total || input + output };
    partial.tokensUnknown = false;
    if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
  }
  partial.approvalsCount = approvals;
  partial.retriesCount = retries;
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}

export const codexAdapter: SessionAdapter = {
  id: "codex",
  async detect(): Promise<RawSessionRef[]> {
    return [];
  },
  async parse(ref: RawSessionRef): Promise<SessionMetrics | null> {
    try {
      const content = fs.readFileSync(ref.sourcePath, "utf-8");
      return parseCodexLines(content.split("\n"), ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath: string, firstChunk: string): boolean {
    if (filePath.includes(".codex") || /rollout-.*\.jsonl$/.test(filePath)) return true;
    const t = firstChunk.trimStart().split("\n")[0] || "";
    return t.includes('"session_meta"') || (t.includes('"type"') && t.includes('"response_item"'));
  },
};
