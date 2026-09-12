import * as fs from "node:fs";
import { ScanResult } from "../core/types.js";
import { scanResultToSarif } from "../core/report/sarif.js";
import { formatGitHubAnnotations, shouldEmitGitHubAnnotations } from "../core/report/githubAnnotations.js";

export function emitScanReports(result: ScanResult, options: { sarif?: string; annotate?: boolean } = {}): void {
  if (options.sarif) {
    fs.writeFileSync(options.sarif, `${JSON.stringify(scanResultToSarif(result), null, 2)}\n`, "utf-8");
  }
  if (shouldEmitGitHubAnnotations(options.annotate)) {
    for (const line of formatGitHubAnnotations(result)) {
      console.log(line);
    }
  }
}
