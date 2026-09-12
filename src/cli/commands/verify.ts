import { runVerify, VerifyOptions } from "../../core/verify/verify.js";
import { VerifyConfigurationError } from "../../core/verify/types.js";
import { formatVerifyResult } from "../formatters/verify.js";

export interface VerifyCommandOptions extends VerifyOptions {
  json?: boolean;
  timeout?: string | number;
}

export async function runVerifyCommand(options: VerifyCommandOptions = {}): Promise<void> {
  try {
    const result = await runVerify({
      cwd: options.cwd,
      only: options.only,
      timeoutSeconds: options.timeout ?? options.timeoutSeconds,
      flakyRuns: options.flakyRuns,
      isolate: options.isolate,
      offline: options.offline,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatVerifyResult(result));
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof VerifyConfigurationError) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              passed: false,
              failures: [error.message],
              warnings: [],
              checks: [],
              findings: [],
              exitCode: 2,
            },
            null,
            2
          )
        );
      } else {
        console.error(error.message);
      }
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}
