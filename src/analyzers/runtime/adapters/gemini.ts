import * as fs from "node:fs";
import * as path from "node:path";
import { SessionMetrics } from "../../../core/types.js";
import { estimateTokens } from "../../context/tokenCounter.js";
import { finalizeSession, emptyPartial } from "../sessionBuilder.js";
import { RawSessionRef, SessionAdapter, formatTimeOffset } from "../sessionTypes.js";

function parseTs(value: unknown): number | null {
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === "string") {
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value);
      return Number.isFinite(n) ? (n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)) : null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
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
    if (r.result !== undefined) return textFrom(r.result);
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

function recordingToolInput(tool: Record<string, any>): Record<string, any> {
  const input = tool.args ?? tool.input ?? tool.inputs ?? tool.arguments;
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, any>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return asRecord(parsed);
    } catch {
      return { _raw: input };
    }
  }
  return {};
}

function parseGeminiRecording(records: Record<string, any>[], filePath: string): SessionMetrics | null {
  if (records.length === 0) return null;
  const base = path.basename(filePath, path.extname(filePath));
  const partial = emptyPartial(base, "Gemini CLI");
  partial.sourcePath = filePath;
  let startSec: number | null = null;
  let endSec: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheRead = 0;
  let tokensSeen = false;

  const noteTime = (value: unknown) => {
    const sec = parseTs(value);
    if (sec == null) return;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };

  const normalized: Record<string, any>[] = [];
  for (const record of records) {
    if (Array.isArray(record.messages)) {
      for (const message of record.messages) normalized.push(asRecord(message));
      if (record.sessionId) partial.nativeId = String(record.sessionId);
      if (typeof record.model === "string") partial.model = record.model;
      if (typeof record.cwd === "string") partial.sessionCwd = record.cwd;
      if (record.startTime !== undefined) noteTime(record.startTime);
      if (record.lastUpdated !== undefined) noteTime(record.lastUpdated);
    } else {
      normalized.push(record);
      if (record.sessionId && !partial.nativeId) partial.nativeId = String(record.sessionId);
      if (typeof record.model === "string" && !partial.model) partial.model = record.model;
      if (typeof record.cwd === "string" && !partial.sessionCwd) partial.sessionCwd = record.cwd;
      if (record.startTime !== undefined) noteTime(record.startTime);
      if (record.lastUpdated !== undefined) noteTime(record.lastUpdated);
    }
  }

  let messageIndex = 0;
  for (const message of normalized) {
    const type = String(message.type ?? message.role ?? "").toLowerCase();
    const at = parseTs(message.timestamp ?? message.time) ?? (messageIndex++ * 45);
    const content = message.content ?? message.message ?? message.text;
    const contentText = textFrom(content);
    if (type === "user" && contentText.trim() && !partial.taskTitle) partial.taskTitle = contentText.trim().slice(0, 140);

    if (type === "gemini" || type === "assistant" || message.model) {
      if (typeof message.model === "string") partial.model = message.model;
      const tokens = asRecord(message.tokens ?? message.usage);
      const i = numberFrom(tokens.input, tokens.input_tokens, tokens.prompt, tokens.prompt_tokens) ?? 0;
      const o = numberFrom(tokens.output, tokens.output_tokens, tokens.completion, tokens.completion_tokens) ?? 0;
      const thoughts = numberFrom(tokens.thoughts, tokens.thought_tokens) ?? 0;
      const total = numberFrom(tokens.total, tokens.total_tokens) ?? i + o + thoughts;
      const cached = numberFrom(tokens.cached, tokens.cached_input_tokens, tokens.cache_read_input_tokens) ?? 0;
      if (i > 0 || o > 0 || thoughts > 0 || total > 0 || cached > 0) {
        inputTokens += i;
        outputTokens += o + thoughts;
        totalTokens += total;
        cacheRead += cached;
        tokensSeen = true;
        partial.contextTokens = Math.max(partial.contextTokens ?? 0, i);
      }
      const contextWindow = numberFrom(message.contextWindowTokens, message.context_window, message.modelContextWindow, message.model_context_window);
      if (contextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
    }

    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawTool of toolCalls) {
      const tool = asRecord(rawTool);
      const name = String(tool.name ?? tool.tool ?? "tool");
      const lowerName = name.toLowerCase();
      const input = recordingToolInput(tool);
      const output = textFrom(tool.result ?? tool.output ?? tool.outputs);
      const status = String(tool.status ?? "success").toLowerCase();
      const failed = status === "error" || status === "failed" || status === "failure" || tool.ok === false || /error|failed|exception/i.test(output.slice(0, 500));
      partial.toolCalls++;
      if (output) partial.toolOutputTokens += estimateTokens(output);
      let action = name;
      if (/bash|shell|command|exec|run|terminal/.test(lowerName)) {
        partial.commandsExecuted++;
        action = `Run ${String(input.command ?? input.cmd ?? input.script ?? name)}`;
      } else if (/read|view|open|cat/.test(lowerName)) {
        const file = String(input.file_path ?? input.path ?? input.file ?? "");
        if (file) partial.filesRead.push(file);
        action = `Read ${file || name}`;
      } else if (/write|edit|replace|patch|delete/.test(lowerName)) {
        const file = String(input.file_path ?? input.path ?? input.file ?? "");
        if (file) partial.filesEdited.push(file);
        action = `Edit ${file || name}`;
      } else if (/search|grep|glob|find/.test(lowerName)) {
        const query = String(input.pattern ?? input.query ?? input.glob ?? input.path ?? name);
        partial.searchOperations.push(query);
        action = `Search ${query}`;
      }
      partial.timeline.push({
        timeOffset: formatTimeOffset(at),
        action: action.slice(0, 200),
        tool: name,
        status: failed ? "failed" : "success",
        detail: failed ? (output.slice(0, 300) || status || "tool error") : undefined,
      });
      if (failed) {
        partial.failedToolCalls++;
        if (!partial.failureReasons) partial.failureReasons = [];
        partial.failureReasons.push({ action: action.slice(0, 200), reason: output.slice(0, 300) || status || "tool error" });
      }
    }

    if (type === "error") {
      const reason = (contentText || textFrom(message.error) || "gemini error").slice(0, 300);
      partial.failedToolCalls++;
      partial.timeline.push({ timeOffset: formatTimeOffset(at), action: "Gemini error", tool: "gemini", status: "failed", detail: reason });
      if (!partial.failureReasons) partial.failureReasons = [];
      partial.failureReasons.push({ action: "Gemini error", reason });
    }
    const retryCount = numberFrom(message.retryCount, message.retry_count, message.retries);
    if (retryCount != null) partial.retriesCount = (partial.retriesCount || 0) + retryCount;
    else if (message.retry === true || message.retried === true || /\bretr(?:y|ied|ies)\b/i.test(`${type} ${contentText}`)) {
      partial.retriesCount = (partial.retriesCount || 0) + 1;
    }
    const approvalRequired = message.approvalRequired === true || message.approval_required === true || message.permissionRequired === true;
    if (approvalRequired || /approval|permission/i.test(`${type} ${contentText}`)) {
      partial.approvalsCount = (partial.approvalsCount || 0) + 1;
    }
  }

  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.taskTitle) return null;
  if (startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1000;
    partial.endedAtMs = endSec * 1000;
    const date = new Date(startSec * 1000);
    partial.date = Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    partial.tokenUsage = { input: inputTokens, output: outputTokens, total: totalTokens || inputTokens + outputTokens };
    partial.tokensUnknown = false;
    if (cacheRead > 0) partial.cacheTokens = { read: cacheRead };
  }
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}

/**
 * Gemini CLI chats: ~/.gemini/tmp/<project_hash>/chats/*.json
 * Shape: {prompts, responses, tool executions {inputs, outputs}, usage, thoughts}
 * Headless: {response, stats{session{duration}, model{turns}, tools{calls}, user{turns}}, error{}}
 */
export function parseGeminiContent(content: string, filePath: string): SessionMetrics | null {
  let data: any;
  const records: Record<string, any>[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as Record<string, any>);
    } catch {
      // Try the legacy single-document parser below.
    }
  }
  const isRecording = records.some((record) =>
    record.sessionId || record.projectHash || Array.isArray(record.messages) ||
    ["user", "gemini", "assistant", "error", "warning", "info"].includes(String(record.type ?? "").toLowerCase())
  );
  if (isRecording) {
    const recording = parseGeminiRecording(records, filePath);
    if (recording) return recording;
  }
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const base = path.basename(filePath, path.extname(filePath));
  const partial = emptyPartial(base, "Gemini CLI");
  partial.sourcePath = filePath;

  // Headless stats fast-path
  const stats = data.stats ?? {};
  const sessionStats = stats.session ?? {};
  const modelStats = stats.model ?? {};
  const toolStats = stats.tools ?? {};
  const err = data.error;

  let toolCalls = Number(toolStats.calls ?? data.toolCalls ?? 0);
  if (stats && (sessionStats.duration != null || toolCalls > 0 || modelStats.turns != null || err)) {
    const durMs = Number(sessionStats.duration ?? 0);
    if (durMs > 0) {
      partial.durationSeconds = Math.floor(durMs / 1000);
      partial.durationUnknown = false;
    }
    if (toolCalls > 0) partial.toolCalls = toolCalls;
    if (typeof data.response === "string" && data.response) {
      partial.toolOutputTokens += estimateTokens(data.response);
    }
    if (err && typeof err === "object") {
      partial.failedToolCalls = 1;
      partial.failureReasons = [
        { action: "gemini", reason: String(err.message ?? err.type ?? err.code ?? "error").slice(0, 300) },
      ];
      partial.timeline.push({
        timeOffset: formatTimeOffset(0),
        action: "gemini headless run",
        tool: "gemini",
        status: "failed",
        detail: String(err.message ?? err.type ?? "error").slice(0, 300),
      });
    } else if (toolCalls > 0 || typeof data.response === "string") {
      partial.timeline.push({
        timeOffset: formatTimeOffset(0),
        action: `gemini run (${modelStats.turns ?? "?"} turns, ${toolCalls} tool calls)`,
        tool: "gemini",
        status: "success",
      });
    }
    if (typeof data.model === "string") partial.model = data.model;
    if (!partial.nativeId) partial.nativeId = base;
    partial.id = partial.nativeId;
    return finalizeSession(partial);
  }

  // Chat transcript shape
  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  const responses = Array.isArray(data.responses) ? data.responses : [];
  const tools = Array.isArray(data.tools)
    ? data.tools
    : Array.isArray(data.toolExecutions)
      ? data.toolExecutions
      : [];
  const usage = data.usage && typeof data.usage === "object" ? data.usage : undefined;
  const hasUsage =
    !!usage &&
    (usage.input_tokens != null ||
      usage.inputTokens != null ||
      usage.output_tokens != null ||
      usage.outputTokens != null);
  if (prompts.length === 0 && responses.length === 0 && tools.length === 0 && !hasUsage) return null;

  if (!partial.taskTitle && typeof prompts[0] === "string") {
    partial.taskTitle = prompts[0].slice(0, 140);
  } else if (!partial.taskTitle && prompts[0]?.text) {
    partial.taskTitle = String(prompts[0].text).slice(0, 140);
  }

  let t = 0;
  const step = 45;
  for (let i = 0; i < Math.max(prompts.length, responses.length); i++) {
    const pr = prompts[i];
    const rs = responses[i];
    if (pr != null) {
      const text = typeof pr === "string" ? pr : String(pr.text ?? pr.content ?? "prompt");
      if (i === 0) partial.taskTitle = partial.taskTitle || text.slice(0, 140);
      t += step;
    }
    if (rs != null) {
      const text = typeof rs === "string" ? rs : String(rs.text ?? rs.content ?? "");
      if (text) partial.toolOutputTokens += estimateTokens(text);
      t += step;
    }
  }

  for (const tool of tools) {
    const name = String(tool.name ?? tool.tool ?? "tool");
    const input = tool.input ?? tool.inputs ?? {};
    const output = String(tool.output ?? tool.outputs ?? tool.result ?? "");
    partial.toolCalls++;
    if (/bash|shell|command|run/i.test(name)) {
      partial.commandsExecuted++;
      const cmd = String((input as any).command ?? name);
      const failed = /error|fail/i.test(output.slice(0, 300)) || tool.status === "error" || tool.ok === false;
      if (failed) partial.failedToolCalls++;
      partial.timeline.push({
        timeOffset: formatTimeOffset(t),
        action: `Run ${cmd}`.slice(0, 200),
        tool: name,
        status: failed ? "failed" : "success",
        detail: failed ? output.slice(0, 300) : undefined,
      });
    } else if (/read|view/i.test(name)) {
      const fp = String((input as any).path ?? (input as any).file ?? "");
      if (fp) partial.filesRead.push(fp);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: `Read ${fp || name}`.slice(0, 200), tool: name, status: "success" });
    } else if (/write|edit|replace/i.test(name)) {
      const fp = String((input as any).path ?? (input as any).file ?? "");
      if (fp) partial.filesEdited.push(fp);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: `Edit ${fp || name}`.slice(0, 200), tool: name, status: "success" });
    } else if (/search|grep|glob|find/i.test(name)) {
      const q = String((input as any).pattern ?? (input as any).query ?? name);
      partial.searchOperations.push(q);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: `Search ${q}`.slice(0, 200), tool: name, status: "success" });
    } else {
      if (output) partial.toolOutputTokens += estimateTokens(output);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: name.slice(0, 200), tool: name, status: "success" });
    }
    t += step;
  }

  const iu = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const ou = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  if (iu > 0 || ou > 0) {
    partial.tokenUsage = { input: iu, output: ou, total: iu + ou };
    partial.tokensUnknown = false;
  }
  if (typeof data.model === "string") partial.model = data.model;
  if (typeof data.durationMs === "number" && data.durationMs > 0) {
    partial.durationSeconds = Math.floor(data.durationMs / 1000);
    partial.durationUnknown = false;
  } else if (t > 0) {
    // Turn count is not elapsed time. Keep duration at zero and expose the
    // unknown marker instead of manufacturing a duration from a step count.
    partial.durationSeconds = 0;
    partial.durationUnknown = true;
  }
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;

  return finalizeSession(partial);
}

export const geminiAdapter: SessionAdapter = {
  id: "gemini",
  async detect(): Promise<RawSessionRef[]> {
    return [];
  },
  async parse(ref: RawSessionRef): Promise<SessionMetrics | null> {
    try {
      const content = fs.readFileSync(ref.sourcePath, "utf-8");
      return parseGeminiContent(content, ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath: string, firstChunk: string): boolean {
    if (filePath.includes(".gemini/tmp") || filePath.includes("/chats/")) return true;
    const t = firstChunk.trimStart();
    return t.startsWith("{") && (
      t.includes('"toolExecutions"') ||
      (t.includes('"stats"') && t.includes('"session"')) ||
      t.includes('"projectHash"') ||
      t.includes('"sessionId"') ||
      (t.includes('"type":"gemini"') && t.includes('"toolCalls"'))
    );
  },
};
