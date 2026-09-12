export interface AgentShimSpec {
  relativePath: string;
  agent: string;
  body: string;
}

/** Thin per-agent pointers. Wording is intentionally unique so they are not flagged as duplicates. */
export const AGENT_SHIM_SPECS: AgentShimSpec[] = [
  {
    relativePath: "CLAUDE.md",
    agent: "Claude Code",
    body: `# Claude Code

Claude Code loads \`AGENTS.md\` first for shared repository commands. Put Claude-only memory in this file and never copy the shared command table.
`,
  },
  {
    relativePath: "GEMINI.md",
    agent: "Gemini CLI",
    body: `# Gemini CLI

Gemini CLI should read \`AGENTS.md\` for install/test/build guidance. Keep Gemini-only notes here instead of restating project layout.
`,
  },
  {
    relativePath: ".cursorrules",
    agent: "Cursor",
    body: `# Cursor

Cursor Agent uses \`AGENTS.md\` as the repository source of truth. Add Cursor-only editor rules below; skip repeating package-manager or test commands.
`,
  },
  {
    relativePath: ".github/copilot-instructions.md",
    agent: "GitHub Copilot",
    body: `# GitHub Copilot

Copilot should follow \`AGENTS.md\` for this repository's verification loop. Reserve this file for Copilot-only review preferences, not a second architecture dump.
`,
  },
  {
    relativePath: "CONVENTIONS.md",
    agent: "Aider",
    body: `# Aider conventions

Aider should treat \`AGENTS.md\` as the canonical command list. Use this file only for Aider-specific conventions that do not belong in the shared document.
`,
  },
  {
    relativePath: ".windsurfrules",
    agent: "Windsurf",
    body: `# Windsurf

Windsurf reads \`AGENTS.md\` for repo-wide agent instructions. Limit this file to Windsurf trigger/glob rules rather than duplicating Critical Commands.
`,
  },
  {
    relativePath: ".clinerules",
    agent: "Cline",
    body: `# Cline

Cline should honor \`AGENTS.md\` for tests and generated-file policy. Keep Cline-only workspace notes here so the shared instruction file stays short.
`,
  },
  {
    relativePath: ".roorules",
    agent: "Roo Code",
    body: `# Roo Code

Roo Code should load \`AGENTS.md\` before mode-specific rules. Do not recopy layout or install steps into this Roo pointer file.
`,
  },
];

export function missingAgentShims(existingRelativePaths: Set<string> | string[]): AgentShimSpec[] {
  const existing = existingRelativePaths instanceof Set
    ? existingRelativePaths
    : new Set([...existingRelativePaths].map((value) => value.replace(/\\/g, "/")));
  return AGENT_SHIM_SPECS.filter((spec) => !existing.has(spec.relativePath));
}
