import { evaluateCheck, CheckOptions } from "../../core/regression/check.js";
import { CheckResult } from "../../core/types.js";
import { formatCheckResult } from "../formatters/check.js";
import { emitScanReports } from "../reportOutput.js";

export interface CheckCommandOptions extends CheckOptions {
  json?: boolean;
  sarif?: string;
  annotate?: boolean;
}

export async function runCheckCommand(options: CheckCommandOptions = {}): Promise<CheckResult> {
  const result = await evaluateCheck(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCheckResult(result, options.minScore));
  }

  emitScanReports(result.result, { sarif: options.sarif, annotate: options.annotate });

  return result;
}
