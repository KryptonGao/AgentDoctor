import { describe, it, expect, afterAll } from "vitest";
import { createWebServer, WebServerInstance } from "../../src/web/server.js";
import { parseUnifiedDiffLines } from "../../src/web/payload.js";

describe("Web UI Server & Payload", () => {
  let instance: WebServerInstance | null = null;

  afterAll(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
  });

  it("should parse unified diff lines into typed chunks", () => {
    const rawDiff = `--- a/AGENTS.md
+++ b/AGENTS.md
@@ -10,3 +10,3 @@
- old line
+ new line
  context line`;

    const lines = parseUnifiedDiffLines(rawDiff);
    expect(lines).toEqual([
      { type: "hunk", text: "@@ -10,3 +10,3 @@" },
      { type: "del", text: "- old line" },
      { type: "add", text: "+ new line" },
      { type: "normal", text: "  context line" },
    ]);
  });

  it("should start web server, serve hydrated index.html and handle API requests", async () => {
    // Start on test port with browser opening disabled
    instance = await createWebServer({
      port: 48921,
      openBrowser: false,
    });

    expect(instance.url).toContain("http://localhost:48921");
    expect(instance.port).toBe(48921);

    // 1. Verify GET / serves HTML with embedded SSR data
    const rootRes = await fetch(instance.url);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    const html = await rootRes.text();
    expect(html).toContain("AgentDoctor DevTools");
    expect(html).toContain("id=\"__INITIAL_DATA__\"");
    expect(html).toContain("window.__INITIAL_DATA__");

    // 2. Verify GET /api/data returns current payload
    const dataRes = await fetch(`${instance.url}/api/data`);
    expect(dataRes.status).toBe(200);
    expect(dataRes.headers.get("content-type")).toContain("application/json");
    const data = await dataRes.json();
    expect(data.repositoryName).toBe("AgentDock");
    expect(typeof data.scanResult.overallScore).toBe("number");
    expect(data.scanResult.contextSignalDensity).toBeDefined();
    expect(Array.isArray(data.contextFiles)).toBe(true);
    expect(typeof data.batchFixPrompt).toBe("string");

    // 3. Verify POST /api/rescan triggers core scan and returns fresh data
    const rescanRes = await fetch(`${instance.url}/api/rescan`, { method: "POST" });
    expect(rescanRes.status).toBe(200);
    const freshData = await rescanRes.json();
    expect(freshData.repositoryName).toBe("AgentDock");
    expect(typeof freshData.scanResult.overallScore).toBe("number");
    expect(freshData.scanResult.metadata.scanDurationMs).toBeGreaterThanOrEqual(0);

    // 4. Verify 404 for unknown route
    const notFoundRes = await fetch(`${instance.url}/unknown-route-12345`);
    expect(notFoundRes.status).toBe(404);
  });
});
