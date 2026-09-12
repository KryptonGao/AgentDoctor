import { describe, expect, it } from "vitest";
import {
  describeAgentFileRole,
  isAgentConfigPath,
  isAgentInstructionPath,
} from "../../src/analyzers/context/agentFiles.js";

describe("agent file catalog", () => {
  it("classifies instruction and config paths for the expanded agent set", () => {
    expect(isAgentInstructionPath("GEMINI.md")).toBe(true);
    expect(isAgentInstructionPath("packages/api/.clinerules")).toBe(true);
    expect(isAgentInstructionPath(".windsurf/rules/style.md")).toBe(true);
    expect(isAgentInstructionPath("CONVENTIONS.md")).toBe(true);
    expect(isAgentInstructionPath(".roo/rules-code/mode.md")).toBe(true);
    expect(isAgentInstructionPath(".opencode/agents/review.md")).toBe(true);
    expect(isAgentInstructionPath("README.md")).toBe(false);
    expect(isAgentConfigPath(".mcp.json")).toBe(true);
    expect(isAgentConfigPath(".claude/settings.json")).toBe(true);
    expect(isAgentConfigPath("opencode.jsonc")).toBe(true);
    expect(isAgentConfigPath(".aider.conf.yml")).toBe(true);
    expect(isAgentConfigPath("AGENTS.md")).toBe(false);
  });

  it("labels roles for inventory display", () => {
    expect(describeAgentFileRole(".claude/settings.json").en).toBe("Claude Code Settings");
    expect(describeAgentFileRole(".mcp.json").en).toBe("MCP Server Config");
    expect(describeAgentFileRole("GEMINI.md").en).toBe("Gemini CLI Instructions");
    expect(describeAgentFileRole(".windsurf/rules/a.md").en).toBe("Windsurf Rules");
  });
});
