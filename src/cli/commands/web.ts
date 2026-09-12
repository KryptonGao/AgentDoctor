import { createWebServer, WebServerInstance } from "../../web/server.js";

export interface WebCommandOptions {
  port?: string | number;
  cwd?: string;
  baseline?: string;
  session?: string;
  open?: boolean;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
}

export async function runWebCommand(options: WebCommandOptions = {}): Promise<WebServerInstance> {
  const parsedPort = options.port ? parseInt(String(options.port), 10) : 4000;
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 4000;

  const instance = await createWebServer({
    port,
    cwd: options.cwd,
    baseline: options.baseline,
    sessionPath: options.session,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
    openBrowser: options.open !== false,
    onListening: (url) => {
      console.log(`\n  \x1b[36m\x1b[1m⚡ AgentDoctor DevTools Web UI\x1b[0m`);
      console.log(`  Local:   \x1b[32m\x1b[4m${url}\x1b[0m`);
      console.log(`  Mode:    \x1b[90mDeterministic Core Diagnostics (Zero-Lag)\x1b[0m\n`);
      console.log(`  \x1b[90mPress Ctrl+C to shut down.\x1b[0m\n`);
    },
  });

  const onExit = async () => {
    try {
      await instance.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  return instance;
}
