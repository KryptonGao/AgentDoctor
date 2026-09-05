import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseSessionTrace, analyzeRuntimeSessions } from "../../src/analyzers/runtime/runtimeAnalyzer.js";

describe("Runtime Analyzer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-runtime-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses session trace and identifies repeated operations and output bloat", () => {
    const sessionData = {
      id: "session-123",
      agentName: "Claude Code",
      date: "Today 10:00",
      durationSeconds: 1200,
      tokenUsage: { input: 80000, output: 15000, total: 95000 },
      toolOutputTokens: 25000,
      timeline: [
        { timeOffset: "00:01", action: "Search auth", status: "success" },
        { timeOffset: "00:03", action: "Search auth", status: "success" },
        { timeOffset: "00:04", action: "Read src/auth/AuthService.ts", status: "success" },
        { timeOffset: "00:06", action: "Read src/auth/AuthService.ts", status: "success" },
        { timeOffset: "00:08", action: "Read src/auth/AuthService.ts", status: "success" },
        { timeOffset: "00:10", action: "Run npm test", status: "failed" },
        { timeOffset: "00:12", action: "Run npm test", status: "failed" },
      ],
    };

    const session = parseSessionTrace(JSON.stringify(sessionData), "test-session.json");
    expect(session).not.toBeNull();
    expect(session?.agentName).toBe("Claude Code");
    expect(session?.repeatedReads.length).toBe(1);
    expect(session?.repeatedReads[0].file).toBe("src/auth/AuthService.ts");
    expect(session?.repeatedReads[0].count).toBe(3);

    expect(session?.repeatedSearches.length).toBe(1);
    expect(session?.repeatedSearches[0].query).toBe("auth");

    expect(session?.repeatedFailures.length).toBe(1);
    expect(session?.repeatedFailures[0].command).toBe("Run npm test");
  });

  it("produces findings from session trace file", async () => {
    const sessionDir = path.join(tmpDir, ".claude", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionData = {
      id: "session-abc",
      agentName: "Codex",
      toolOutputTokens: 32000,
      filesRead: ["src/index.ts", "src/index.ts", "src/index.ts", "src/index.ts"],
      timeline: [
        { timeOffset: "00:01", action: "Run pnpm test", status: "failed" },
        { timeOffset: "00:03", action: "Run pnpm test", status: "failed" },
      ],
    };

    fs.writeFileSync(
      path.join(sessionDir, "session-abc.json"),
      JSON.stringify(sessionData)
    );

    const result = await analyzeRuntimeSessions(tmpDir);
    expect(result.sessions.length).toBe(1);

    const repeatedReadFinding = result.findings.find((f) => f.ruleId === "runtime/repeated-file-retrieval");
    expect(repeatedReadFinding).toBeDefined();

    const outputBloatFinding = result.findings.find((f) => f.ruleId === "runtime/oversized-tool-output");
    expect(outputBloatFinding).toBeDefined();
  });
});
