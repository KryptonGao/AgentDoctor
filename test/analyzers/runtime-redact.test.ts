import { describe, it, expect } from "vitest";
import { redactText, redactSession } from "../../src/analyzers/runtime/redact.js";
import { emptyPartial, finalizeSession } from "../../src/analyzers/runtime/sessionBuilder.js";

describe("Session redaction (default on)", () => {
  it("redacts known secret shapes but keeps key names", () => {
    const r = redactText('api_key=sk-abcdefghijklmnop and password: "hunter2hunter" ok');
    expect(r.text).not.toContain("sk-abcdefghijklmnop");
    expect(r.text).not.toContain("hunter2hunter");
    expect(r.text).toContain("api_key=");
    expect(r.redactedCount).toBe(2);
  });

  it("redacts github/slack/aws/bearer/private-key shapes", () => {
    const input = [
      "token ghp_abcdefghijklmnop123456",
      "xoxb-1234567890-abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer abcdefghijklmnop",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const r = redactText(input);
    expect(r.redactedCount).toBe(5);
    expect(r.text).not.toContain("ghp_");
    expect(r.text).not.toContain("PRIVATE KEY-----\nMIIB");
  });

  it("leaves normal paths and commands untouched", () => {
    const input = "Read src/auth/AuthService.ts then Run pnpm test";
    const r = redactText(input);
    expect(r.text).toBe(input);
    expect(r.redactedCount).toBe(0);
  });

  it("redactSession covers timeline/search/failures and counts", () => {
    const partial = emptyPartial("s1", "Codex");
    partial.timeline = [
      { timeOffset: "00:01", action: "Run deploy", status: "failed", detail: "api_key=supersecretvalue" },
    ];
    partial.searchOperations = ["sk-abcdefghijklmnop"];
    partial.failureReasons = [{ action: "Run deploy", reason: "token ghp_abcdefghijklmnop123456" }];
    const s = redactSession(finalizeSession(partial));
    expect(s.redactedFields).toBe(3);
    expect(JSON.stringify(s)).not.toContain("supersecretvalue");
  });

  it("redacts raw arrays and recomputes derived findings without leaking secrets", () => {
    const github = "ghp_abcdefghijklmnop123456";
    const openai = "sk-abcdefghijklmnop";
    const password = "hunter2hunter";
    const partial = emptyPartial("s2", "Cursor");
    partial.filesRead = [github, github, github];
    partial.filesEdited = [openai];
    partial.searchOperations = [github, github];
    partial.timeline = [
      { timeOffset: "00:01", action: "Run password: hunter2hunter", status: "failed", detail: github },
      { timeOffset: "00:02", action: "Run password: hunter2hunter", status: "failed", detail: github },
    ];
    partial.prTitle = "password: hunter2hunter";
    const session = redactSession(finalizeSession(partial));
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain(github);
    expect(serialized).not.toContain(openai);
    expect(serialized).not.toContain(password);
    expect(session.repeatedReads[0].file).not.toContain(github);
    expect(session.repeatedSearches[0].query).not.toContain(github);
    expect(session.repeatedFailures[0].command).not.toContain(password);
    expect(session.redactedFields).toBeGreaterThan(0);
  });
});
