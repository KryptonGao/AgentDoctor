import { evaluateEval, EvalConfigurationError, EvalOptions } from "../../core/eval/eval.js";
import { initEvalSuite } from "../../core/eval/tasks.js";
import { getGitRoot } from "../../shared/git.js";
import { formatEvalResult } from "../formatters/eval.js";

export interface EvalCommandOptions extends EvalOptions {
  json?: boolean;
  init?: boolean;
}

export async function runEvalCommand(options: EvalCommandOptions = {}): Promise<void> {
  const repoRoot = getGitRoot(options.cwd || process.cwd());

  if (options.init) {
    const suitePath = initEvalSuite(repoRoot, options.tasks);
    if (options.json) {
      console.log(JSON.stringify({ created: suitePath }, null, 2));
    } else {
      console.log(`Created golden tasks suite at ${suitePath}`);
      console.log("Edit the tasks, then run: agentdoctor eval");
    }
    return;
  }

  try {
    const result = await evaluateEval(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatEvalResult(result));
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof EvalConfigurationError) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              mode: options.command ? "command" : "replay",
              suite: { name: undefined, path: undefined, taskCount: 0 },
              run: null,
              before: null,
              after: null,
              comparison: null,
              passed: false,
              failures: [error.message],
              warnings: [],
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
