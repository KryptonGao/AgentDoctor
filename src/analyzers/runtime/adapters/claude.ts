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

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const r = value as Record<string, any>;
    if (typeof r.text === "string") return r.text;
    if (r.content !== undefined) return textFrom(r.content);
    if (r.message !== undefined) return textFrom(r.message);
  }
  return "";
}

/**
 * Claude Code transcript JSONL: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 * Line types: user | assistant | system | progress | queue-operation | file-history-snapshot
 */
export function parseClaudeLines(lines: string[], filePath: string): SessionMetrics | null {
  const base = path.basename(filePath, path.extname(filePath));
  const partial = emptyPartial(base, "Claude Code");
  partial.sourcePath = filePath;

  let startSec: number | null = null;
  let endSec: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let tokensSeen = false;
  let approvals = 0;
  let retries = 0;
  let restores = 0;

  const noteTime = (sec: number | null) => {
    if (sec == null) return;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };

  const pushTimeline = (sec: number, action: string, tool: string | undefined, status: "success" | "failed", detail?: string) => {
    const offset = startSec != null ? Math.max(0, sec - startSec) : partial.timeline.length * 30;
    partial.timeline.push({ timeOffset: formatTimeOffset(offset), action, tool, status, detail });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const sec = parseTs(evt.timestamp);
    noteTime(sec);
    const at = sec ?? (endSec ?? 0);
    const type = evt.type as string | undefined;

    if (!partial.nativeId && typeof evt.sessionId === "string") partial.nativeId = evt.sessionId;
    if (!partial.nativeId && typeof evt.uuid === "string") partial.nativeId = evt.uuid;
    if (!partial.sessionCwd && typeof evt.cwd === "string") partial.sessionCwd = evt.cwd;
    if (typeof evt.gitBranch === "string" && !partial.gitBranch) partial.gitBranch = evt.gitBranch;
    if (typeof evt.gitCommit === "string" && !partial.gitCommit) partial.gitCommit = evt.gitCommit;
    if (typeof evt.prNumber === "number" && partial.prNumber === undefined) partial.prNumber = evt.prNumber;
    if (typeof evt.prTitle === "string" && !partial.prTitle) partial.prTitle = evt.prTitle;
    if (typeof evt.prState === "string" && !partial.prState) partial.prState = evt.prState;
    if (typeof evt.taskTitle === "string" && !partial.taskTitle) partial.taskTitle = evt.taskTitle.slice(0, 140);
    if (typeof evt.version === "string" && !partial.model) partial.model = `claude (${evt.version})`;
    const contextWindow = Number(evt.contextWindowTokens ?? evt.context_window ?? evt.modelContextWindow ?? evt.model_context_window);
    if (Number.isFinite(contextWindow) && contextWindow > 0) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
    const nativeRetry = Number(evt.retryCount ?? evt.retry_count ?? evt.retries);
    if (Number.isFinite(nativeRetry) && nativeRetry > 0) retries += nativeRetry;
    else if (evt.retry === true || evt.retried === true) retries++;
    if (evt.approvalRequired === true || evt.approval_required === true || evt.permissionRequired === true) approvals++;
    if (evt.permissionMode && typeof evt.permissionMode === "string") {
      // plan/default mode noted; approvals counted from system permission prompts below
    }

    if (type === "file-history-snapshot") {
      restores++;
      retries++;
      continue;
    }
    if (type === "queue-operation") {
      retries++; // subagent enqueue/dequeue ~ retry/fanout signal
      continue;
    }
    if (type === "progress") {
      const msg = String(evt.data?.message ?? evt.message ?? "");
      if (/permission|approv|confirm/i.test(msg)) approvals++;
      continue;
    }
    if (type === "system") {
      const msg = String(evt.message ?? evt.subtype ?? "");
      if (/permission|approv|hook/i.test(msg)) approvals++;
      continue;
    }

    if (type === "assistant") {
      const msg = evt.message ?? {};
      if (typeof msg.model === "string") partial.model = msg.model;
      const usage = msg.usage ?? evt.usage;
      if (usage && typeof usage === "object") {
        const i = Number(usage.input_tokens ?? 0);
        const o = Number(usage.output_tokens ?? 0);
        const cr = Number(usage.cache_read_input_tokens ?? 0);
        const cc = Number(usage.cache_creation_input_tokens ?? 0);
        if (i > 0 || o > 0 || cr > 0 || cc > 0) {
          inputTokens += i;
          outputTokens += o;
          cacheRead += cr;
          cacheCreation += cc;
          tokensSeen = true;
          partial.contextTokens = Math.max(partial.contextTokens ?? 0, i);
        }
      }
      const usageContext = Number(usage?.context_window ?? usage?.contextWindowTokens ?? usage?.model_context_window);
      if (Number.isFinite(usageContext) && usageContext > 0) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, usageContext);
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            // assistant prose — not tool output; skip token double count (usage already sums)
            continue;
          }
          if (block.type === "tool_use") {
            const name = String(block.name ?? "tool");
            const input = (block.input ?? {}) as Record<string, any>;
            partial.toolCalls++;
            if (name === "Read") {
              const fp = String(input.file_path ?? input.path ?? "");
              if (fp) partial.filesRead.push(fp);
              pushTimeline(at, `Read ${fp || name}`.slice(0, 200), name, "success");
            } else if (name === "Write" || name === "Edit") {
              const fp = String(input.file_path ?? input.path ?? "");
              if (fp) partial.filesEdited.push(fp);
              pushTimeline(at, `Edit ${fp || name}`.slice(0, 200), name, "success");
            } else if (name === "Bash") {
              const cmd = String(input.command ?? input.cmd ?? name);
              partial.commandsExecuted++;
              pushTimeline(at, `Run ${cmd}`.slice(0, 200), name, "success");
            } else if (name === "Grep" || name === "Glob") {
              const q = String(input.pattern ?? input.path ?? name);
              partial.searchOperations.push(q);
              pushTimeline(at, `Search ${q}`.slice(0, 200), name, "success");
            } else if (name === "Task") {
              retries++;
              const desc = String(input.description ?? input.prompt ?? name).slice(0, 120);
              pushTimeline(at, `Task ${desc}`.slice(0, 200), name, "success");
            } else {
              pushTimeline(at, `${name}`, name, "success");
            }
          }
        }
      }
      continue;
    }

    if (type === "user") {
      const content = evt.message?.content ?? evt.content;
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result" || block.tool_use_id) {
          const out = textFrom(block.content ?? block.text ?? "");
          if (out) partial.toolOutputTokens += estimateTokens(out);
          const isErr = block.is_error === true || /error|failed|exception|ENOENT/i.test(out.slice(0, 400));
          if (isErr) {
            partial.failedToolCalls++;
            const idx = partial.timeline.length - 1;
            const reason = out.slice(0, 300);
            if (idx >= 0) {
              partial.timeline[idx].status = "failed";
              partial.timeline[idx].detail = reason;
            }
            if (!partial.failureReasons) partial.failureReasons = [];
            const action = idx >= 0 ? partial.timeline[idx].action : "tool";
            partial.failureReasons.push({ action, reason });
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          // user prompt text — capture as task title from first message
          if (!partial.taskTitle && block.text.trim().length > 0) {
            partial.taskTitle = block.text.trim().slice(0, 140);
          }
        }
      }
      continue;
    }
  }

  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen) return null;

  if (startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1000;
    partial.endedAtMs = endSec * 1000;
    const d = new Date(startSec * 1000);
    partial.date = Number.isNaN(d.getTime()) ? "Unknown" : d.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    partial.tokenUsage = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
    partial.tokensUnknown = false;
    if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
  }
  partial.approvalsCount = approvals;
  partial.retriesCount = retries;
  partial.restoresCount = restores;
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId || base;

  return finalizeSession(partial);
}

export const claudeAdapter: SessionAdapter = {
  id: "claude",
  async detect(): Promise<RawSessionRef[]> {
    return [];
  },
  async parse(ref: RawSessionRef): Promise<SessionMetrics | null> {
    try {
      const content = fs.readFileSync(ref.sourcePath, "utf-8");
      return parseClaudeLines(content.split("\n"), ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath: string, firstChunk: string): boolean {
    if (filePath.includes(".claude/projects")) return true;
    const t = firstChunk.trimStart().split("\n")[0] || "";
    return t.includes('"tool_use"') && (t.includes('"sessionId"') || t.includes('"parentUuid"'));
  },
};
