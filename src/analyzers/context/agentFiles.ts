import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import micromatch from "micromatch";

export const AGENT_FILE_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/out/**",
  "**/coverage/**",
  "**/generated/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.venv/**",
  "**/venv/**",
];

/** Markdown/text instruction files that coding agents load as project context. */
export const AGENT_INSTRUCTION_GLOBS = [
  "**/AGENTS.md",
  "**/AGENTS.override.md",
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/GEMINI.md",
  "**/GEMINI.local.md",
  "**/CONVENTIONS.md",
  "**/.cursorrules",
  "**/.windsurfrules",
  "**/.clinerules",
  "**/.roorules",
  "**/.cursor/rules/**/*.{md,mdc}",
  "**/.github/copilot-instructions.md",
  "**/.github/instructions/**/*.md",
  "**/.claude/skills/**/*.md",
  "**/.claude/agents/**/*.{md,mdc}",
  "**/.claude/rules/**/*.md",
  "**/.codex/skills/**/*.md",
  "**/.codex/agents/**/*.{md,toml}",
  "**/.agents/skills/**/*.md",
  "**/.github/skills/**/*.md",
  "**/.windsurf/rules/**/*.{md,mdc}",
  "**/.clinerules/**/*.{md,mdc}",
  "**/.roo/rules/**/*.{md,mdc}",
  "**/.roo/rules-*/**/*.{md,mdc}",
  "**/.opencode/**/*.{md,mdc}",
];

/** MCP, hooks, permissions, and tool settings — not prose instructions. */
export const AGENT_CONFIG_GLOBS = [
  ".mcp.json",
  "**/.mcp.json",
  ".cursor/mcp.json",
  "**/.cursor/mcp.json",
  ".cursor/cli.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude.json",
  ".claude/hooks.json",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".gemini/settings.json",
  ".gemini/settings.local.json",
  ".github/hooks/**/*.json",
  "**/.github/copilot-mcp.json",
  ".github/mcp.json",
  ".windsurf/mcp.json",
  ".windsurf/mcp_config.json",
  "**/.windsurf/mcp.json",
  ".cline/mcp.json",
  ".cline/mcp_settings.json",
  "**/.cline/mcp*.json",
  ".roo/mcp.json",
  "**/.roo/mcp.json",
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
  "**/.aider.conf.yml",
  "**/.aider.conf.yaml",
  "**/.aider.conf.json",
  ".roomodes",
];

const GLOB_OPTIONS = { dot: true } as const;

export function normalizeAgentRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export function isAgentInstructionPath(relativePath: string): boolean {
  return micromatch.isMatch(normalizeAgentRelativePath(relativePath), AGENT_INSTRUCTION_GLOBS, GLOB_OPTIONS);
}

export function isAgentConfigPath(relativePath: string): boolean {
  return micromatch.isMatch(normalizeAgentRelativePath(relativePath), AGENT_CONFIG_GLOBS, GLOB_OPTIONS);
}

export function globAgentFilesSync(repoRoot: string, globs: string[]): string[] {
  return fg.sync(globs, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: AGENT_FILE_IGNORE,
  }).sort((a, b) => a.localeCompare(b));
}

export async function globAgentFiles(repoRoot: string, globs: string[]): Promise<string[]> {
  const relativePaths = await fg(globs, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: AGENT_FILE_IGNORE,
  });
  return relativePaths.sort((a, b) => a.localeCompare(b));
}

export function describeAgentFileRole(relativePath: string): { zh: string; en: string } {
  const norm = normalizeAgentRelativePath(relativePath);
  if (norm.endsWith("AGENTS.md") || norm.endsWith("AGENTS.override.md")) {
    return { zh: "单一事实来源 (Primary)", en: "Source of Truth (Primary)" };
  }
  if (norm.includes("mcp") || /(^|\/)\.mcp\.json$/.test(norm)) {
    return { zh: "MCP 服务器配置", en: "MCP Server Config" };
  }
  if (norm.includes(".claude/settings") || /(^|\/)\.claude\.json$/.test(norm)) {
    return { zh: "Claude Code 设置", en: "Claude Code Settings" };
  }
  if (norm.endsWith("CLAUDE.md") || norm.endsWith("CLAUDE.local.md") || norm.includes("/.claude/")) {
    return { zh: "Claude Code 指令", en: "Claude Code Instructions" };
  }
  if (norm.endsWith("GEMINI.md") || norm.endsWith("GEMINI.local.md") || norm.includes("/.gemini/")) {
    return { zh: "Gemini CLI 指令", en: "Gemini CLI Instructions" };
  }
  if (norm.includes("copilot-instructions") || norm.includes("/.github/instructions/")) {
    return { zh: "Copilot 补充指令", en: "Copilot Instructions" };
  }
  if (norm.includes(".cursor") || norm.endsWith(".cursorrules")) {
    return { zh: "Cursor IDE 规则", en: "Cursor IDE Rules" };
  }
  if (norm.includes(".windsurf") || norm.endsWith(".windsurfrules")) {
    return { zh: "Windsurf 规则", en: "Windsurf Rules" };
  }
  if (norm.includes(".cline") || norm.includes(".clinerules")) {
    return { zh: "Cline 规则", en: "Cline Rules" };
  }
  if (norm.endsWith("CONVENTIONS.md") || norm.includes(".aider.conf.")) {
    return { zh: "Aider 约定", en: "Aider Conventions" };
  }
  if (norm.includes(".opencode") || /(^|\/)opencode\.jsonc?$/.test(norm)) {
    return { zh: "OpenCode 配置", en: "OpenCode Config" };
  }
  if (norm.includes(".roo") || norm.endsWith(".roorules") || norm.endsWith(".roomodes")) {
    return { zh: "Roo 规则", en: "Roo Rules" };
  }
  return { zh: "辅助指令配置", en: "Instruction Config" };
}

export function readAgentTextFile(repoRoot: string, relativePath: string): {
  relativePath: string;
  absolutePath: string;
  content: string;
} | null {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;
    return {
      relativePath: normalizeAgentRelativePath(relativePath),
      absolutePath,
      content: fs.readFileSync(absolutePath, "utf-8"),
    };
  } catch {
    return null;
  }
}
