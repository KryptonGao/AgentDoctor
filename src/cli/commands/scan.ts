import { scanRepository } from "../../core/scan/scanner.js";
import { formatTerminalScanResult } from "../formatters/terminal.js";
import { emitScanReports } from "../reportOutput.js";

export interface ScanCommandOptions {
  json?: boolean;
  session?: string;
  cwd?: string;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
  maxGlobalSessions?: string | number;
  sarif?: string;
  annotate?: boolean;
}

export async function runScanCommand(options: ScanCommandOptions = {}) {
  const maxGlobal = options.maxGlobalSessions !== undefined ? Number(options.maxGlobalSessions) : undefined;
  const result = await scanRepository({
    cwd: options.cwd,
    sessionPath: options.session,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
    maxGlobalSessions: Number.isFinite(maxGlobal) ? maxGlobal : undefined,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTerminalScanResult(result));
  }

  emitScanReports(result, { sarif: options.sarif, annotate: options.annotate });
}
