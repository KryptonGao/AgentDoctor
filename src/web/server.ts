import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { buildWebPayload, WebDataPayload, BuildWebPayloadOptions } from "./payload.js";
import { AGENT_PROFILE_IDS, AGENT_PROFILE_LIST, AgentProfileId, EffectiveContextQuery } from "../analyzers/context/effectiveTypes.js";
import { simulateEffectiveContext } from "../analyzers/context/effectiveContext.js";

const EFFECTIVE_CONTEXT_BODY_LIMIT = 256 * 1024;
const EFFECTIVE_CONTEXT_AGENTS = new Set<AgentProfileId>(AGENT_PROFILE_IDS);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        reject(Object.assign(new Error(`Request body exceeds ${limit} bytes`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export interface WebServerOptions extends BuildWebPayloadOptions {
  port?: number;
  openBrowser?: boolean;
  onListening?: (url: string, port: number) => void;
}

export interface WebServerInstance {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
  getPayload: () => WebDataPayload;
}

export function openBrowser(url: string): void {
  try {
    const start =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
        ? "start"
        : "xdg-open";
    exec(`${start} ${url}`, () => {});
  } catch {
    // Ignore error if unable to launch browser
  }
}

export function findWebHtmlPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(currentDir, "../../web/index.html"),
    path.resolve(currentDir, "../web/index.html"),
    path.resolve(currentDir, "../../../web/index.html"),
    path.resolve(process.cwd(), "web/index.html"),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(`Could not locate web/index.html in candidate locations: ${candidatePaths.join(", ")}`);
}

export async function createWebServer(options: WebServerOptions = {}): Promise<WebServerInstance> {
  const htmlPath = findWebHtmlPath();
  const rawHtml = fs.readFileSync(htmlPath, "utf-8");

  let currentPayload = await buildWebPayload(options);

  const server = http.createServer(async (req, res) => {
    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      // Re-read html if in dev mode or use rawHtml
      let html = rawHtml;
      try {
        if (fs.existsSync(htmlPath)) {
          html = fs.readFileSync(htmlPath, "utf-8");
        }
      } catch {
        // use rawHtml fallback
      }

      // Inject initial data
      const dataScript = `<script id="__INITIAL_DATA__">window.__INITIAL_DATA__ = ${JSON.stringify(currentPayload).replace(/</g, "\\u003c")};</script>`;
      const rendered = html.includes("</head>")
        ? html.replace("</head>", `  ${dataScript}\n</head>`)
        : `${dataScript}\n${html}`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(rendered);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/data") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(currentPayload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/rescan") {
      try {
        currentPayload = await buildWebPayload(options);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(currentPayload));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message || String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/effective-context") {
      try {
        const body = await readJsonBody(req, EFFECTIVE_CONTEXT_BODY_LIMIT);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Request body must be a JSON object"), { statusCode: 400 });
        const input = body as Partial<EffectiveContextQuery>;
        if (!input.agent || !EFFECTIVE_CONTEXT_AGENTS.has(input.agent)) {
          throw Object.assign(new Error(`agent must be one of: ${AGENT_PROFILE_LIST}`), { statusCode: 400 });
        }
        const repositoryRoot = path.resolve(currentPayload.repositoryRoot);
        const requestedCwd = input.cwd
          ? path.resolve(repositoryRoot, input.cwd)
          : path.resolve(options.cwd || repositoryRoot);
        if (!isInside(repositoryRoot, requestedCwd)) {
          throw Object.assign(new Error("cwd must be inside the scanned repository"), { statusCode: 400 });
        }
        const report = await simulateEffectiveContext({ ...input, agent: input.agent, cwd: requestedCwd });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(report));
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        res.writeHead(err.statusCode || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message || String(error) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  const desiredPort = options.port || 4000;
  const boundPort = await new Promise<number>((resolve, reject) => {
    let portToTry = desiredPort;
    let attempts = 0;
    const maxAttempts = 10;

    const tryListen = () => {
      server.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && attempts < maxAttempts) {
          attempts++;
          portToTry++;
          tryListen();
        } else {
          reject(err);
        }
      });

      server.listen(portToTry, "127.0.0.1", () => {
        resolve(portToTry);
      });
    };

    tryListen();
  });

  const localUrl = `http://localhost:${boundPort}`;

  if (options.openBrowser !== false) {
    openBrowser(localUrl);
  }

  if (options.onListening) {
    options.onListening(localUrl, boundPort);
  }

  return {
    server,
    url: localUrl,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    getPayload: () => currentPayload,
  };
}
