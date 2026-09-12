import * as path from "node:path";
import { startOtelReceiver } from "../../analyzers/runtime/otelReceiver.js";

export interface OtelCommandOptions {
  port?: string | number;
  out?: string;
  cwd?: string;
  allowSensitive?: boolean;
}

export async function runOtelCommand(options: OtelCommandOptions = {}) {
  const parsedPort = options.port ? parseInt(String(options.port), 10) : 4318;
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 4318;
  const destPath = options.out || path.join(options.cwd || process.cwd(), ".agent", "otel-traces.jsonl");

  const instance = await startOtelReceiver({
    port,
    destPath,
    allowSensitive: options.allowSensitive,
    onBatch: (spans) => console.log(`  received batch (${spans} spans) -> ${destPath}`),
  });

  console.log(`\n  OTLP receiver listening on ${instance.url}`);
  console.log(`  Configure your agent SDK:`);
  console.log(`    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${instance.url}/v1/traces`);
  console.log(`    OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
  console.log(`  Traces append to: ${destPath}`);
  console.log(`  Analyze with: agentdoctor scan --session ${destPath}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

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

  // Keep the process alive until signalled.
  await new Promise(() => {});
}
