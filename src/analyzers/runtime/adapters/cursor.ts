import * as fs from "node:fs";
import * as path from "node:path";
import { SessionMetrics } from "../../../core/types.js";
import { estimateTokens } from "../../context/tokenCounter.js";
import { finalizeSession, emptyPartial } from "../sessionBuilder.js";
import { RawSessionRef, SessionAdapter, formatTimeOffset } from "../sessionTypes.js";

function parseTs(value: unknown): number | null {
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  return null;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, any>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return textFromContent(record.content);
    if (record.output !== undefined) return textFromContent(record.output);
  }
  return "";
}

function taskText(value: string): string {
  const query = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1];
  return (query || value).replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "").trim();
}

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function usageFrom(value: unknown): { input: number; output: number; total: number; cacheRead: number; cacheCreation: number } | null {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return null;
  const input = numberFrom(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens) ?? 0;
  const output = numberFrom(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens) ?? 0;
  const total = numberFrom(usage.total_tokens, usage.totalTokens, usage.total) ?? input + output;
  const cacheRead = numberFrom(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cacheReadInputTokens) ?? 0;
  const cacheCreation = numberFrom(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) ?? 0;
  if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && cacheCreation === 0) return null;
  return { input, output, total, cacheRead, cacheCreation };
}

function inputRecord(block: Record<string, any>): Record<string, any> {
  return asRecord(block.input ?? block.arguments ?? block.params ?? block.args);
}

function addFailure(partial: ReturnType<typeof emptyPartial>, action: string, reason: string, at: number): void {
  const detail = reason.slice(0, 300);
  partial.failedToolCalls++;
  partial.timeline.push({ timeOffset: formatTimeOffset(at), action: action.slice(0, 200), tool: "cursor", status: "failed", detail });
  if (!partial.failureReasons) partial.failureReasons = [];
  partial.failureReasons.push({ action: action.slice(0, 200), reason: detail });
}

/**
 * Cursor agent-transcripts JSONL. Current Cursor records use top-level
 * role/message objects and content blocks such as tool_use/tool_result.
 */
export function parseCursorLines(lines: string[], filePath: string): SessionMetrics | null {
  const base = path.basename(filePath, path.extname(filePath));
  const partial = emptyPartial(base, "Cursor");
  partial.sourcePath = filePath;

  let startSec: number | null = null;
  let endSec: number | null = null;
  let tokensSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedTotal = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let realTimestamps = false;
  let eventIndex = 0;
  let approvals = 0;
  let retries = 0;
  let restores = 0;
  const toolIndexes = new Map<string, number>();

  const noteTime = (sec: number | null) => {
    if (sec == null) return;
    realTimestamps = true;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
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
    eventIndex++;
    const message = asRecord(evt.message);
    const sec = parseTs(evt.timestamp ?? evt.createdAt ?? evt.created_at ?? message.timestamp);
    noteTime(sec);
    const at = sec ?? Math.max(0, (eventIndex - 1) * 30);

    const nativeId = evt.sessionId ?? evt.session_id ?? evt.conversationId ?? evt.conversation_id;
    if (!partial.nativeId && typeof nativeId === "string") partial.nativeId = nativeId;
    if (!partial.sessionCwd && typeof evt.cwd === "string") partial.sessionCwd = evt.cwd;
    if (!partial.sessionCwd && typeof evt.workspaceRoot === "string") partial.sessionCwd = evt.workspaceRoot;
    if (typeof evt.model === "string" && !partial.model) partial.model = evt.model;
    if (typeof evt.gitBranch === "string" && !partial.gitBranch) partial.gitBranch = evt.gitBranch;
    if (typeof evt.gitCommit === "string" && !partial.gitCommit) partial.gitCommit = evt.gitCommit;
    if (typeof evt.prNumber === "number" && partial.prNumber === undefined) partial.prNumber = evt.prNumber;
    if (typeof evt.prTitle === "string" && !partial.prTitle) partial.prTitle = evt.prTitle;

    const usage = usageFrom(evt.usage ?? message.usage ?? evt.tokens ?? message.tokens);
    if (usage) {
      inputTokens += usage.input;
      outputTokens += usage.output;
      reportedTotal += usage.total;
      cacheRead += usage.cacheRead;
      cacheCreation += usage.cacheCreation;
      tokensSeen = true;
      partial.contextTokens = Math.max(partial.contextTokens ?? 0, usage.input);
    }
    const contextWindow = numberFrom(
      evt.contextWindowTokens,
      evt.context_window,
      evt.modelContextWindow,
      evt.model_context_window,
      message.contextWindowTokens,
      message.context_window
    );
    if (contextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
    const observedContext = numberFrom(evt.contextTokens, evt.context_tokens, message.contextTokens, message.context_tokens);
    if (observedContext != null) partial.contextTokens = Math.max(partial.contextTokens ?? 0, observedContext);

    const role = String(evt.role ?? evt.type ?? message.role ?? "").toLowerCase();
    const eventType = String(evt.type ?? "").toLowerCase();
    const content = message.content ?? evt.content;
    const blocks = Array.isArray(content) ? content : content == null ? [] : [content];
    const recordText = textFromContent(content);
    const signalText = `${eventType} ${role} ${recordText} ${textFromContent(evt.error)}`;

    const explicitApproval = evt.approvalRequired === true || evt.approval_required === true || message.approvalRequired === true || message.approval_required === true;
    if (explicitApproval || (/approval|permission/i.test(signalText) && /request|requested|denied|blocked|confirm|approval/i.test(signalText))) approvals++;
    const explicitRetry = numberFrom(evt.retryCount, evt.retry_count, message.retryCount, message.retry_count);
    if (explicitRetry != null) retries += explicitRetry;
    else if (evt.retry === true || evt.retried === true || message.retry === true || message.retried === true || /\bretr(?:y|ied|ies)\b/i.test(eventType)) retries++;
    if (evt.restore === true || evt.restored === true || /restore|checkpoint|rollback/i.test(eventType)) restores++;

    if ((role === "user" || eventType === "user") && recordText.trim() && !partial.taskTitle) {
      partial.taskTitle = taskText(recordText).slice(0, 140);
    }

    for (const rawBlock of blocks) {
      const block = asRecord(rawBlock);
      const blockType = String(block.type ?? block.kind ?? "").toLowerCase();
      if (blockType === "tool_use" || blockType === "tool_call" || blockType === "tooluse") {
        const name = String(block.name ?? block.tool_name ?? block.toolName ?? "tool");
        const input = inputRecord(block);
        const callId = String(block.id ?? block.tool_use_id ?? block.call_id ?? `${partial.toolCalls}`);
        partial.toolCalls++;
        const lowerName = name.toLowerCase();
        const file = String(input.file_path ?? input.path ?? input.file ?? "");
        const query = String((input.pattern ?? input.query ?? input.glob_pattern ?? input.glob ?? file) || name);
        let action = name;
        if (/read|view|cat|open/.test(lowerName)) {
          if (file) partial.filesRead.push(file);
          action = `Read ${file || name}`;
        } else if (/write|edit|apply|replace|patch|delete/.test(lowerName)) {
          if (file) partial.filesEdited.push(file);
          action = `Edit ${file || name}`;
        } else if (/grep|glob|search|find/.test(lowerName)) {
          partial.searchOperations.push(query);
          action = `Search ${query}`;
        } else if (/bash|shell|terminal|command|exec|run/.test(lowerName)) {
          const command = String(input.command ?? input.cmd ?? input.script ?? name);
          partial.commandsExecuted++;
          action = `Run ${command}`;
        }
        const index = partial.timeline.length;
        partial.timeline.push({ timeOffset: formatTimeOffset(at), action: action.slice(0, 200), tool: name, status: "success" });
        toolIndexes.set(callId, index);

        const inlineResult = block.result ?? block.output;
        if (inlineResult !== undefined) {
          const output = textFromContent(inlineResult);
          if (output) partial.toolOutputTokens += estimateTokens(output);
          if (block.is_error === true || /error|failed|exception/i.test(output.slice(0, 400))) {
            partial.timeline[index].status = "failed";
            partial.timeline[index].detail = output.slice(0, 300);
            partial.failedToolCalls++;
            if (!partial.failureReasons) partial.failureReasons = [];
            partial.failureReasons.push({ action: action.slice(0, 200), reason: output.slice(0, 300) || "tool error" });
          }
        }
        continue;
      }

      if (blockType === "tool_result" || blockType === "tooloutput" || block.tool_use_id !== undefined) {
        const output = textFromContent(block.content ?? block.output ?? block.result ?? block.text);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const isError = block.is_error === true || block.isError === true || /error|failed|exception|denied|ENOENT/i.test(output.slice(0, 500));
        const callId = String(block.tool_use_id ?? block.toolCallId ?? block.call_id ?? "");
        const index = callId ? toolIndexes.get(callId) : undefined;
        if (isError) {
          if (index !== undefined) {
            partial.timeline[index].status = "failed";
            partial.timeline[index].detail = output.slice(0, 300) || "tool error";
            const action = partial.timeline[index].action;
            if (!partial.failureReasons) partial.failureReasons = [];
            partial.failureReasons.push({ action, reason: output.slice(0, 300) || "tool error" });
            partial.failedToolCalls++;
          } else {
            addFailure(partial, "Cursor tool", output || "tool error", at);
          }
        }
      }
    }

    if (eventType === "turn_ended" || eventType === "turn_end" || eventType === "error" || role === "error") {
      const status = String(evt.status ?? evt.state ?? "").toLowerCase();
      const errorText = textFromContent(evt.error ?? evt.message ?? evt.detail ?? evt.reason);
      if (/error|fail|cancel|abort/.test(status) || eventType === "error" || role === "error") {
        addFailure(partial, "Cursor turn", errorText || status || "session error", at);
      }
    }
  }

  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.taskTitle) return null;

  if (realTimestamps && startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1000;
    partial.endedAtMs = endSec * 1000;
    const date = new Date(startSec * 1000);
    partial.date = Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    partial.tokenUsage = { input: inputTokens, output: outputTokens, total: reportedTotal || inputTokens + outputTokens };
    partial.tokensUnknown = false;
    if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
  }
  partial.approvalsCount = approvals;
  partial.retriesCount = retries;
  partial.restoresCount = restores;
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}

export const cursorAdapter: SessionAdapter = {
  id: "cursor",
  async detect(): Promise<RawSessionRef[]> {
    return [];
  },
  async parse(ref: RawSessionRef): Promise<SessionMetrics | null> {
    try {
      return parseCursorLines(fs.readFileSync(ref.sourcePath, "utf-8").split("\n"), ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath: string, firstChunk: string): boolean {
    const normalized = filePath.replaceAll(path.sep, "/");
    if (normalized.includes("/.cursor/") || normalized.includes("/agent-transcripts/")) return true;
    const head = firstChunk.trimStart();
    return head.includes('"tool_use"') && (
      head.includes('"role":"assistant"') ||
      head.includes('"role": "assistant"') ||
      head.includes('"type":"tool_use"')
    );
  },
};
