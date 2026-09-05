import { evaluateCheck, CheckOptions } from "../../core/regression/check.js";
import { CheckResult } from "../../core/types.js";
import { formatCheckResult } from "../formatters/check.js";

export interface CheckCommandOptions extends CheckOptions {
  json?: boolean;
}

export async function runCheckCommand(options: CheckCommandOptions = {}): Promise<CheckResult> {
  const result = await evaluateCheck(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCheckResult(result, options.minScore));
  }

  return result;
}
