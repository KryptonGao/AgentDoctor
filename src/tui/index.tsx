import React from "react";
import { render } from "ink";
import { scanRepository, ScanOptions } from "../core/scan/scanner.js";
import { AgentProfileId, EffectiveContextQuery } from "../analyzers/context/effectiveTypes.js";
import { simulateEffectiveContext } from "../analyzers/context/effectiveContext.js";
import { App } from "./App.js";

export interface TuiOptions {
  sessionPath?: string;
  cwd?: string;
  includeGlobal?: boolean;
  allowSensitive?: boolean;
  agent?: AgentProfileId;
  targetPaths?: string[];
  task?: string;
  rules?: string[];
  skills?: string[];
  subagent?: string;
  hookEvent?: string;
  toolName?: string;
  profile?: string;
  contextWindowTokens?: number;
  allowExternalImports?: boolean;
}

export async function launchTui(options: TuiOptions = {}) {
  const scanOptions: ScanOptions = {
    cwd: options.cwd,
    sessionPath: options.sessionPath,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
  };
  const contextQuery: EffectiveContextQuery = {
    agent: options.agent || "codex",
    cwd: options.cwd,
    targetPaths: options.targetPaths,
    task: options.task,
    rules: options.rules,
    skills: options.skills,
    subagent: options.subagent,
    hookEvent: options.hookEvent,
    toolName: options.toolName,
    profile: options.profile,
    includeGlobal: options.includeGlobal,
    contextWindowTokens: options.contextWindowTokens,
    allowExternalImports: options.allowExternalImports,
  };
  const [initialResult, initialEffectiveContext] = await Promise.all([
    scanRepository(scanOptions),
    simulateEffectiveContext(contextQuery),
  ]);

  const { waitUntilExit } = render(
    <App
      initialResult={initialResult}
      initialEffectiveContext={initialEffectiveContext}
      scanOptions={scanOptions}
      contextQuery={contextQuery}
    />
  );
  await waitUntilExit();
}
