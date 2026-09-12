import { AGENT_PROFILE_LIST, isAgentProfileId } from "../../analyzers/context/effectiveTypes.js";
import { simulateEffectiveContext } from "../../analyzers/context/effectiveContext.js";
import { formatEffectiveContextReport } from "../formatters/context.js";

export interface ContextCommandOptions {
  agent: string;

  cwd?: string;
  path?: string[];
  task?: string;
  rule?: string[];
  skill?: string[];
  subagent?: string;
  hookEvent?: string;
  tool?: string;
  profile?: string;
  contextWindow?: string | number;
  includeGlobal?: boolean;
  allowExternalImports?: boolean;
  json?: boolean;
}

export async function runContextCommand(options: ContextCommandOptions) {
  if (!isAgentProfileId(options.agent)) {
    throw new Error(`Unsupported agent profile: ${options.agent}. Expected one of: ${AGENT_PROFILE_LIST}`);
  }
  const contextWindow = options.contextWindow === undefined ? undefined : Number(options.contextWindow);
  if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
    throw new Error("--context-window must be a positive number");
  }
  const report = await simulateEffectiveContext({
    agent: options.agent,
    cwd: options.cwd,
    targetPaths: options.path,
    task: options.task,
    rules: options.rule,
    skills: options.skill,
    subagent: options.subagent,
    hookEvent: options.hookEvent,
    toolName: options.tool,
    profile: options.profile,
    includeGlobal: options.includeGlobal,
    allowExternalImports: options.allowExternalImports,
    contextWindowTokens: contextWindow,
  });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatEffectiveContextReport(report));
  return report;
}
