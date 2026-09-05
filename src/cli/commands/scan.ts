import { scanRepository } from "../../core/scan/scanner.js";
import { formatTerminalScanResult } from "../formatters/terminal.js";

export interface ScanCommandOptions {
  json?: boolean;
  session?: string;
  cwd?: string;
}

export async function runScanCommand(options: ScanCommandOptions = {}) {
  const result = await scanRepository({
    cwd: options.cwd,
    sessionPath: options.session,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTerminalScanResult(result));
  }
}
