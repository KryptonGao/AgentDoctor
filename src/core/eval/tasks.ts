import * as fs from "node:fs";
import * as path from "node:path";
import { EvalSuite, EvalTask } from "./types.js";

export const DEFAULT_EVAL_SUITE_PATH = path.join(".agentdoctor", "eval", "golden-tasks.json");

export class EvalConfigurationError extends Error {
  readonly exitCode = 2 as const;
}

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function fail(message: string): never {
  throw new EvalConfigurationError(message);
}

function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${where} must be a non-empty string.`);
  }
  return value;
}

function optionalNumber(value: unknown, where: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    fail(`${where} must be a number >= ${min}.`);
  }
  return value;
}

/**
 * Validate and normalize a golden-task suite. Throws EvalConfigurationError
 * (exit code 2) on any problem so CI fails loudly instead of silently
 * evaluating an empty or misattributed suite.
 */
export function parseEvalSuite(raw: unknown, source: string): EvalSuite {
  const root = expectObject(raw, `Eval suite ${source}`);
  const schemaVersion = root.schemaVersion === undefined ? 1 : root.schemaVersion;
  if (schemaVersion !== 1) {
    fail(`Eval suite ${source} has unsupported schemaVersion ${String(schemaVersion)} (expected 1).`);
  }

  const rawTasks = root.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    fail(`Eval suite ${source} must define a non-empty "tasks" array.`);
  }

  const tasks: EvalTask[] = rawTasks.map((entry, index) => {
    const where = `task[${index}]`;
    const raw = expectObject(entry, `Eval suite ${source}: ${where}`);
    const id = optionalString(raw.id, `${where}.id`);
    if (!id || !TASK_ID_PATTERN.test(id)) {
      fail(`Eval suite ${source}: ${where}.id must match ${TASK_ID_PATTERN.source}.`);
    }
    const prompt = optionalString(raw.prompt, `${where}.prompt`);
    if (!prompt) fail(`Eval suite ${source}: ${where}.prompt must be a non-empty string.`);

    let verify: EvalTask["verify"];
    if (raw.verify !== undefined) {
      const rawVerify = expectObject(raw.verify, `${where}.verify`);
      const command = optionalString(rawVerify.command, `${where}.verify.command`);
      if (!command) fail(`Eval suite ${source}: ${where}.verify.command must be a non-empty string.`);
      verify = {
        command,
        expectPass: rawVerify.expectPass === undefined ? true : Boolean(rawVerify.expectPass),
        timeoutSeconds: optionalNumber(rawVerify.timeoutSeconds, `${where}.verify.timeoutSeconds`, 1),
      };
    }

    let match: EvalTask["match"];
    if (raw.match !== undefined) {
      const rawMatch = expectObject(raw.match, `${where}.match`);
      const sessionRegex = optionalString(rawMatch.sessionRegex, `${where}.match.sessionRegex`);
      if (sessionRegex) {
        try {
          // eslint-disable-next-line no-new
          new RegExp(sessionRegex, "i");
        } catch {
          fail(`Eval suite ${source}: ${where}.match.sessionRegex is not a valid regex.`);
        }
      }
      match = { sessionRegex };
    }

    const maxAttempts = optionalNumber(raw.maxAttempts, `${where}.maxAttempts`, 1);
    return {
      id,
      title: optionalString(raw.title, `${where}.title`),
      prompt,
      setup: optionalString(raw.setup, `${where}.setup`),
      verify,
      maxAttempts: maxAttempts === undefined ? undefined : Math.floor(maxAttempts),
      timeoutSeconds: optionalNumber(raw.timeoutSeconds, `${where}.timeoutSeconds`, 1),
      match,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    };
  });

  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      fail(`Eval suite ${source} contains duplicate task id "${task.id}".`);
    }
    ids.add(task.id);
  }

  let pricing: EvalSuite["pricing"];
  if (root.pricing !== undefined) {
    const rawPricing = expectObject(root.pricing, "pricing");
    pricing = {
      inputPerMTok: optionalNumber(rawPricing.inputPerMTok, "pricing.inputPerMTok", 0),
      outputPerMTok: optionalNumber(rawPricing.outputPerMTok, "pricing.outputPerMTok", 0),
    };
  }

  return {
    schemaVersion: 1,
    name: optionalString(root.name, "name"),
    description: optionalString(root.description, "description"),
    pricing,
    tasks,
  };
}

/** Resolve the suite path: explicit --tasks wins, else .agentdoctor/eval/golden-tasks.json. */
export function resolveEvalSuitePath(repoRoot: string, explicitPath?: string): string {
  if (explicitPath && explicitPath.trim() !== "") {
    return path.isAbsolute(explicitPath) ? explicitPath : path.join(repoRoot, explicitPath);
  }
  return path.join(repoRoot, DEFAULT_EVAL_SUITE_PATH);
}

export function loadEvalSuite(repoRoot: string, explicitPath?: string): { suite: EvalSuite; suitePath: string } {
  const suitePath = resolveEvalSuitePath(repoRoot, explicitPath);
  let text: string;
  try {
    text = fs.readFileSync(suitePath, "utf-8");
  } catch {
    fail(
      `Golden tasks file not found at ${suitePath}. ` +
        `Create one with "agentdoctor eval --init" or pass --tasks <path>.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(`Eval suite ${suitePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { suite: parseEvalSuite(raw, suitePath), suitePath };
}

export function scaffoldEvalSuiteText(repoName: string): string {
  const suite = {
    schemaVersion: 1,
    name: `${repoName} golden tasks`,
    description:
      "Tasks that prove the agent is actually effective in this repository. " +
      "Run `agentdoctor eval` (replay from session traces) or " +
      "`agentdoctor eval --command \"<agent cmd>\"` to execute tasks live.",
    // Optional, per-million-token USD rates for cost estimates:
    // pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    tasks: [
      {
        id: "fix-failing-test",
        title: "Fix the failing test",
        prompt:
          "Run the test suite, find the failing test, and fix the source code " +
          "(not the test) so `npm test` passes.",
        // Optional: prepare a deterministic failing fixture before the agent.
        // setup: "node scripts/seed-eval-fixture.js",
        verify: { command: "npm test", timeoutSeconds: 300 },
        maxAttempts: 2,
        match: { sessionRegex: "fix.*failing.*test" },
      },
      {
        id: "add-missing-readme-section",
        title: "Document the build command",
        prompt:
          "Read AGENTS.md and the package scripts, then make sure AGENTS.md " +
          "documents the exact build command developers should run.",
        verify: { command: "node -e \"process.exit(require('fs').readFileSync('AGENTS.md','utf8').includes('npm run build') ? 0 : 1)\"" },
        maxAttempts: 1,
      },
    ],
  };
  return JSON.stringify(suite, null, 2) + "\n";
}

/** Write a starter golden-task suite unless one already exists. Returns the path. */
export function initEvalSuite(repoRoot: string, explicitPath?: string): string {
  const suitePath = resolveEvalSuitePath(repoRoot, explicitPath);
  if (fs.existsSync(suitePath)) {
    fail(`Eval suite already exists at ${suitePath}.`);
  }
  fs.mkdirSync(path.dirname(suitePath), { recursive: true });
  fs.writeFileSync(suitePath, scaffoldEvalSuiteText(path.basename(repoRoot)));
  return suitePath;
}
