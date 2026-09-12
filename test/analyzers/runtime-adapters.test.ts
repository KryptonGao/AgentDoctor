import { describe, it, expect } from "vitest";
import { parseCodexLines } from "../../src/analyzers/runtime/adapters/codex.js";
import { parseClaudeLines } from "../../src/analyzers/runtime/adapters/claude.js";
import { parseCursorLines } from "../../src/analyzers/runtime/adapters/cursor.js";
import { parseGeminiContent } from "../../src/analyzers/runtime/adapters/gemini.js";
import { parseOtelContent } from "../../src/analyzers/runtime/adapters/otel.js";

describe("Native log adapters", () => {
  it("parses Codex rollout JSONL with tokens, duration, git and failure", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-09-01T10:00:00Z",
        type: "session_meta",
        payload: {
          session_id: "abc",
          cwd: "/tmp/x",
          model: "gpt-5",
          git: { branch: "main", commit: "deadbeef", dirty: false },
        },
      }),
      "not-json{{{",
      JSON.stringify({
        timestamp: "2026-09-01T10:01:00Z",
        type: "response_item",
        payload: { type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":"pnpm test"}' },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:01:30Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          commandExecution: { command: "pnpm test", exitCode: 1, status: "fail", output: "ERR boom" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:02:00Z",
        type: "event_msg",
        payload: { msg_type: "token_count", count: { input_tokens: 1000, output_tokens: 200 } },
      }),
    ];
    const s = parseCodexLines(lines, "rollout-test.jsonl");
    expect(s).not.toBeNull();
    expect(s!.agentName).toBe("Codex");
    expect(s!.nativeId).toBe("abc");
    expect(s!.model).toBe("gpt-5");
    expect(s!.toolCalls).toBe(1);
    expect(s!.failedToolCalls).toBe(1);
    expect(s!.commandsExecuted).toBe(1);
    expect(s!.tokenUsage.total).toBe(1200);
    expect(s!.tokensUnknown).toBe(false);
    expect(s!.durationSeconds).toBe(120);
    expect(s!.durationUnknown).toBe(false);
    expect(s!.gitBranch).toBe("main");
    expect(s!.gitCommit).toBe("deadbeef");
    expect(s!.failureReasons!.length).toBeGreaterThan(0);
  });

  it("parses Claude transcript JSONL with tool_use, usage cache and error result", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-01T10:00:00Z",
        sessionId: "s1",
        uuid: "u1",
        message: { content: [{ type: "text", text: "Fix auth bug" }] },
        gitBranch: "feat",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-01T10:01:00Z",
        uuid: "u2",
        message: {
          model: "claude-opus-4-6",
          usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-01T10:02:00Z",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "ENOENT boom" }] },
      }),
    ];
    const s = parseClaudeLines(lines, "sess.jsonl");
    expect(s).not.toBeNull();
    expect(s!.agentName).toBe("Claude Code");
    expect(s!.toolCalls).toBe(1);
    expect(s!.failedToolCalls).toBe(1);
    expect(s!.filesRead).toContain("src/a.ts");
    expect(s!.tokenUsage.total).toBe(600);
    expect(s!.cacheTokens).toEqual({ read: 50, creation: 10 });
    expect(s!.taskTitle).toBe("Fix auth bug");
    expect(s!.gitBranch).toBe("feat");
    expect(s!.model).toBe("claude-opus-4-6");
  });

  it("parses current Codex response_item/event_msg records without double counting", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-09-01T10:00:00Z",
        type: "session_meta",
        payload: {
          session_id: "codex-current",
          cwd: "/tmp/x",
          context_window: 258400,
          git: { branch: "feat/auth", commit: "abc123", dirty: true },
        },
      }),
      JSON.stringify({ timestamp: "2026-09-01T10:00:01Z", type: "turn_context", payload: { model: "gpt-5-codex", cwd: "/tmp/x" } }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:02Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Fix auth" }] } },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:03Z",
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "pnpm test" },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:04Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "CommandExecution", id: "call-1", command: "pnpm test", status: "failed", exit_code: 1, stderr: "ERR boom" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:04Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "FileChange", changes: { "src/a.ts": { type: "edit" } }, status: "completed" } },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:05Z",
        type: "token_usage_record",
        payload: { session_id: "codex-current", usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 100, total_tokens: 1200 } },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:05Z",
        type: "token_usage_record",
        payload: { session_id: "codex-current", usage: { input_tokens: 1100, output_tokens: 220, cached_input_tokens: 120, total_tokens: 1320 } },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:00:06Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, output_tokens: 999 }, model_context_window: 258400 } },
      }),
    ];
    const s = parseCodexLines(lines, "rollout-current.jsonl");
    expect(s).not.toBeNull();
    expect(s!.toolCalls).toBe(2);
    expect(s!.failedToolCalls).toBe(1);
    expect(s!.commandsExecuted).toBe(1);
    expect(s!.filesEdited).toContain("src/a.ts");
    expect(s!.tokenUsage).toEqual({ input: 1100, output: 220, total: 1320 });
    expect(s!.cacheTokens).toEqual({ read: 120, creation: 0 });
    expect(s!.contextWindowTokens).toBe(258400);
    expect(s!.taskTitle).toBe("Fix auth");
    expect(s!.gitCommit).toBe("abc123");
  });

  it("parses Cursor agent-transcripts JSONL tool blocks and turn failures", () => {
    const lines = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Fix cursor bug" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { path: "src/a.ts" } }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", is_error: true, content: "ENOENT" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Grep", input: { pattern: "auth" } }] } }),
      JSON.stringify({ type: "turn_ended", status: "error", error: "permission denied" }),
    ];
    const s = parseCursorLines(lines, "/tmp/.cursor/agent-transcripts/session.jsonl");
    expect(s).not.toBeNull();
    expect(s!.agentName).toBe("Cursor");
    expect(s!.toolCalls).toBe(2);
    expect(s!.filesRead).toContain("src/a.ts");
    expect(s!.searchOperations).toContain("auth");
    expect(s!.failedToolCalls).toBeGreaterThanOrEqual(1);
    expect(s!.taskTitle).toBe("Fix cursor bug");
    expect(s!.durationUnknown).toBe(true);
  });

  it("parses current Gemini CLI session JSONL recordings", () => {
    const records = [
      { sessionId: "g1", projectHash: "hash", startTime: "2026-09-01T10:00:00Z", lastUpdated: "2026-09-01T10:02:00Z" },
      { id: "u1", timestamp: "2026-09-01T10:00:01Z", type: "user", content: [{ text: "Fix auth" }] },
      {
        id: "a1",
        timestamp: "2026-09-01T10:00:10Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        toolCalls: [{ id: "t1", name: "read_file", args: { file_path: "src/a.ts" }, result: [{ text: "ok" }], status: "success" }],
        tokens: { input: 100, output: 20, cached: 10, total: 120 },
      },
    ];
    const s = parseGeminiContent(records.map(JSON.stringify).join("\n"), "session-g1.jsonl");
    expect(s).not.toBeNull();
    expect(s!.nativeId).toBe("g1");
    expect(s!.toolCalls).toBe(1);
    expect(s!.filesRead).toContain("src/a.ts");
    expect(s!.tokenUsage).toEqual({ input: 100, output: 20, total: 120 });
    expect(s!.cacheTokens).toEqual({ read: 10 });
    expect(s!.taskTitle).toBe("Fix auth");
    expect(s!.durationSeconds).toBe(120);
  });

  it("parses Gemini headless stats JSON without fabricating tokens", () => {
    const s = parseGeminiContent(
      JSON.stringify({
        response: "done",
        stats: { session: { duration: 90000 }, model: { turns: 3 }, tools: { calls: 2 }, user: { turns: 2 } },
      }),
      "chat.json"
    );
    expect(s).not.toBeNull();
    expect(s!.agentName).toBe("Gemini CLI");
    expect(s!.toolCalls).toBe(2);
    expect(s!.durationSeconds).toBe(90);
    expect(s!.durationUnknown).toBe(false);
    expect(s!.tokensUnknown).toBe(true);
    expect(s!.tokenUsage.total).toBe(0);
  });

  it("parses Gemini error payload into failed tool call", () => {
    const s = parseGeminiContent(
      JSON.stringify({
        stats: { session: {}, model: {}, tools: { calls: 0 }, user: {} },
        error: { type: "ApiError", message: "quota exceeded" },
      }),
      "chat.json"
    );
    expect(s!.failedToolCalls).toBe(1);
    expect(s!.failureReasons![0].reason).toContain("quota");
  });

  it("parses OTLP traces grouped by conversation with legacy+new token coalescing", () => {
    const span = (name: string, op: string, extra: any, start: string, end: string, status = 0) => ({
      traceId: "aaa",
      spanId: "s1",
      name,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: [
        { key: "gen_ai.operation.name", value: { stringValue: op } },
        { key: "gen_ai.conversation.id", value: { stringValue: "conv1" } },
        ...extra,
      ],
      status: { code: status },
    });
    const doc = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
          scopeSpans: [
            {
              scope: { name: "sdk" },
              spans: [
                span("chat claude", "chat", [
                  { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-6" } },
                  { key: "gen_ai.request.context_window", value: { intValue: "200000" } },
                  { key: "gen_ai.task.title", value: { stringValue: "Fix auth" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "50" } },
                ], "1700000000000000000", "1700000005000000000"),
                span("execute_tool Read", "execute_tool", [
                  { key: "gen_ai.tool.name", value: { stringValue: "Read" } },
                ], "1700000001000000000", "1700000002000000000"),
                span("execute_tool Bash", "execute_tool", [
                  { key: "gen_ai.tool.name", value: { stringValue: "Bash" } },
                  { key: "error.type", value: { stringValue: "non-zero-exit" } },
                ], "1700000002000000000", "1700000003000000000", 2),
              ],
            },
          ],
        },
      ],
    };
    const sessions = parseOtelContent(JSON.stringify(doc), "otel.jsonl");
    expect(sessions.length).toBe(1);
    const s = sessions[0];
    expect(s.agentName).toBe("Claude Code");
    expect(s.toolCalls).toBe(2);
    expect(s.failedToolCalls).toBe(1);
    expect(s.commandsExecuted).toBe(1);
    expect(s.tokenUsage.total).toBe(150);
    expect(s.model).toBe("claude-opus-4-6");
    expect(s.contextWindowTokens).toBe(200000);
    expect(s.taskTitle).toBe("Fix auth");
  });

  it("returns null/empty for garbage input instead of fabricated sessions", () => {
    expect(parseCodexLines(["{{{", ""], "x.jsonl")).toBeNull();
    expect(parseClaudeLines(["hello"], "x.jsonl")).toBeNull();
    expect(parseGeminiContent("{}", "x.json")).toBeNull();
    expect(parseOtelContent("{}", "x.jsonl")).toEqual([]);
  });
});
