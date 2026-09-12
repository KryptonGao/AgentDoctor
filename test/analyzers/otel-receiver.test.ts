import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startOtelReceiver } from "../../src/analyzers/runtime/otelReceiver.js";
import { parseOtelContent } from "../../src/analyzers/runtime/adapters/otel.js";

function postJson(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("OTLP receiver", () => {
  it("accepts OTLP/HTTP JSON, redacts persisted payloads and remains analyzable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-otel-"));
    const destPath = path.join(tmp, "traces.jsonl");
    const secret = "shortsecretvalue";
    const doc = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-1",
                  name: "execute_tool",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  attributes: [
                    { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
                    { key: "gen_ai.conversation.id", value: { stringValue: "conv-1" } },
                    { key: "gen_ai.tool.name", value: { stringValue: "Bash" } },
                    { key: "gen_ai.tool.call.arguments", value: { stringValue: `deploy --token ${secret}` } },
                    { key: "api_key", value: { stringValue: secret } },
                  ],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    };

    const receiver = await startOtelReceiver({ port: 0, destPath });
    try {
      const response = await postJson(`${receiver.url}/v1/traces`, doc);
      expect(response.status).toBe(200);
      const stored = fs.readFileSync(destPath, "utf8");
      expect(stored).not.toContain(secret);
      expect(parseOtelContent(stored, destPath)[0]?.toolCalls).toBe(1);
    } finally {
      await receiver.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
