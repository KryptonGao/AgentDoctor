import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRuntimeSessions, collectSessionsInRange } from "../../src/analyzers/runtime/runtimeAnalyzer.js";

describe("Runtime orchestrator: routing, redaction, new rules", () => {
  let tmpDir: string;
  const prevGlobal = process.env.AGENTDOCTOR_INCLUDE_GLOBAL;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-rt-orch-"));
    process.env.AGENTDOCTOR_INCLUDE_GLOBAL = "0";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevGlobal === undefined) delete process.env.AGENTDOCTOR_INCLUDE_GLOBAL;
    else process.env.AGENTDOCTOR_INCLUDE_GLOBAL = prevGlobal;
  });

  it("routes explicit Codex JSONL --session and redacts secrets by default", async () => {
    const file = path.join(tmpDir, "rollout.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-09-01T10:00:00Z",
        type: "session_meta",
        payload: { session_id: "redact-me", cwd: tmpDir, model: "gpt-5" },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T10:01:00Z",
        type: "response_item",
        payload: { type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":"deploy --token sk-abcdefghijklmnop"}' },
      }),
    ].join("\n");
    fs.writeFileSync(file, lines);

    const { sessions } = await analyzeRuntimeSessions(tmpDir, file);
    expect(sessions.length).toBe(1);
    expect(sessions[0].agentName).toBe("Codex");
    expect(sessions[0].timeline[0].action).not.toContain("sk-abcdefghijklmnop");
    expect(sessions[0].redactedFields).toBeGreaterThan(0);
  });

  it("keeps secrets with allowSensitive and parses OTLP multi-trace files", async () => {
    const file = path.join(tmpDir, "traces.jsonl");
    const doc = (conv: string) => ({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
          scopeSpans: [
            {
              scope: { name: "sdk" },
              spans: [
                {
                  traceId: conv,
                  name: "execute_tool Bash",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  attributes: [
                    { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
                    { key: "gen_ai.conversation.id", value: { stringValue: conv } },
                    { key: "gen_ai.tool.name", value: { stringValue: "Bash" } },
                  ],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    });
    fs.writeFileSync(file, `${JSON.stringify(doc("c1"))}\n${JSON.stringify(doc("c2"))}\n`);

    const { sessions } = await analyzeRuntimeSessions(tmpDir, file, { allowSensitive: true });
    expect(sessions.length).toBe(2);
    expect(sessions[0].toolCalls).toBe(1);
  });

  it("emits retry-loop and approval-blocked findings from native signals", async () => {
    const file = path.join(tmpDir, "session.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: "loop",
        agentName: "Claude Code",
        retriesCount: 4,
        approvalsCount: 5,
        timeline: [
          { timeOffset: "00:01", action: "Search auth", status: "success" },
          { timeOffset: "00:02", action: "Search auth", status: "success" },
        ],
      })
    );
    const { findings } = await analyzeRuntimeSessions(tmpDir, file);
    expect(findings.some((f) => f.ruleId === "runtime/retry-loop")).toBe(true);
    expect(findings.some((f) => f.ruleId === "runtime/approval-blocked")).toBe(true);
  });

  it("reports unknown duration/tokens as n/a instead of fabricated defaults", async () => {
    const file = path.join(tmpDir, "bare.json");
    fs.writeFileSync(file, JSON.stringify({ id: "bare", timeline: [] }));
    const { sessions } = await analyzeRuntimeSessions(tmpDir, file);
    expect(sessions.length).toBe(1);
    expect(sessions[0].durationUnknown).toBe(true);
    expect(sessions[0].tokensUnknown).toBe(true);
    expect(sessions[0].tokenUsage.total).toBe(0);
  });

  it("keeps secrets out of normalized sessions and generated findings", async () => {
    const file = path.join(tmpDir, "secret-session.json");
    const secret = "ghp_abcdefghijklmnop123456";
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: "secret-session",
        agentName: "Cursor",
        filesRead: [secret, secret, secret],
        searchOperations: [secret, secret],
        timeline: [
          { timeOffset: "00:01", action: `Search ${secret}`, status: "success" },
          { timeOffset: "00:02", action: `Search ${secret}`, status: "success" },
        ],
      })
    );
    const result = await analyzeRuntimeSessions(tmpDir, file);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.findings.some((f) => f.ruleId === "runtime/repeated-searches")).toBe(true);
  });

  it("filters historical sessions out of a shared OTLP file window", async () => {
    const file = path.join(tmpDir, ".agent", "otel-traces.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const toNano = (ms: number) => String(BigInt(Math.floor(ms)) * 1000000n);
    const trace = (id: string, startMs: number) => ({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: id,
                  name: "execute_tool Bash",
                  startTimeUnixNano: toNano(startMs),
                  endTimeUnixNano: toNano(startMs + 100),
                  attributes: [
                    { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
                    { key: "gen_ai.conversation.id", value: { stringValue: id } },
                    { key: "gen_ai.tool.name", value: { stringValue: "Bash" } },
                    { key: "gen_ai.usage.input_tokens", value: { intValue: 10 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const now = Date.now();
    fs.writeFileSync(file, `${JSON.stringify(trace("old", now - 60_000))}\n${JSON.stringify(trace("new", now))}\n`);

    const sessions = await collectSessionsInRange(tmpDir, now - 2_000, now + 2_000, {
      includeGlobal: false,
    });
    expect(sessions.map((session) => session.nativeId)).toEqual(["new"]);
  });
});
