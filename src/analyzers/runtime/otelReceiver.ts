import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactStructured } from "./redact.js";

export interface OtelReceiverOptions {
  port?: number;
  /** JSONL file to append TracesData payloads to (file-exporter shape, one per line). */
  destPath?: string;
  /** Keep sensitive values in the persisted OTLP payload. Default false. */
  allowSensitive?: boolean;
  onBatch?: (spans: number) => void;
}

export interface OtelReceiverInstance {
  url: string;
  port: number;
  destPath: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function countSpans(doc: any): number {
  let n = 0;
  const rs = doc?.resourceSpans;
  if (!Array.isArray(rs)) return 0;
  for (const r of rs) {
    const ss = r?.scopeSpans;
    if (!Array.isArray(ss)) continue;
    for (const s of ss) {
      if (Array.isArray(s?.spans)) n += s.spans.length;
    }
  }
  return n;
}

/**
 * Minimal local OTLP/HTTP receiver for agent traces.
 * Accepts POST /v1/traces (JSON) and appends each TracesData doc as one JSONL
 * line to destPath, which `scan --session <destPath>` can then analyze.
 * Binds 127.0.0.1 only. Metrics/logs endpoints return 202 and are ignored.
 */
export async function startOtelReceiver(
  options: OtelReceiverOptions = {}
): Promise<OtelReceiverInstance> {
  const destPath =
    options.destPath || path.join(process.cwd(), ".agent", "otel-traces.jsonl");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/traces") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload too large (max 10MB)" }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const spans = countSpans(body);
          if (!body?.resourceSpans) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "expected OTLP TracesData JSON with resourceSpans" }));
            return;
          }
          const stored = options.allowSensitive ? body : redactStructured(body).value;
          fs.appendFileSync(destPath, `${JSON.stringify(stored)}\n`, "utf-8");
          options.onBatch?.(spans);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ partialSuccess: {} }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
        }
      });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/metrics" || url.pathname === "/v1/logs")) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  const desiredPort = options.port ?? 4318;
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(desiredPort, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : desiredPort);
    });
  });

  return {
    url: `http://localhost:${boundPort}`,
    port: boundPort,
    destPath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
