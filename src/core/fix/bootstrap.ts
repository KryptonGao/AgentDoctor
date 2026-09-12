import * as fs from "node:fs";
import * as path from "node:path";
import { FileChange, Finding, Fix, ProjectProfile, VerificationItem } from "../types.js";
import { globAgentFilesSync, AGENT_INSTRUCTION_GLOBS } from "../../analyzers/context/agentFiles.js";
import { generateAgentsMarkdown } from "./agentsMarkdown.js";
import { createFix } from "./fixEngine.js";
import { missingAgentShims } from "./shims.js";

export function buildMissingAgentsFix(
  repoRoot: string,
  profile: ProjectProfile,
  verificationStatus: VerificationItem[]
): Fix | null {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  if (fs.existsSync(agentsPath)) return null;
  const content = generateAgentsMarkdown({ repoRoot, profile, verificationStatus, repositoryName: path.basename(repoRoot) });
  return createFix({
    id: "fix-generate-agents-md",
    title: "Generate AGENTS.md from repository structure",
    description: "Create a high-signal AGENTS.md using detected layout, commands, and generated directories.",
    isSafe: true,
    file: agentsPath,
    oldText: "",
    newText: content,
    changes: [{ path: agentsPath, kind: "create", newText: content, replaceFile: true }],
  });
}

export function buildAgentShimFix(repoRoot: string): Fix | null {
  const existing = new Set(globAgentFilesSync(repoRoot, AGENT_INSTRUCTION_GLOBS).map((rel) => rel.replace(/\\/g, "/")));
  if (fs.existsSync(path.join(repoRoot, "AGENTS.md"))) existing.add("AGENTS.md");
  const missing = missingAgentShims(existing);
  if (missing.length === 0) return null;

  const changes: FileChange[] = missing.map((spec) => ({
    path: path.join(repoRoot, spec.relativePath),
    kind: "create" as const,
    newText: spec.body,
    replaceFile: true,
  }));

  return createFix({
    id: "fix-generate-agent-shims",
    title: `Create ${missing.length} agent shim file${missing.length === 1 ? "" : "s"}`,
    description: `Write pointer files for ${missing.map((spec) => spec.agent).join(", ")} that defer to AGENTS.md.`,
    isSafe: true,
    file: changes[0].path,
    oldText: "",
    newText: missing[0].body,
    changes,
  });
}

export function buildRegenerateAgentsFix(
  repoRoot: string,
  profile: ProjectProfile,
  verificationStatus: VerificationItem[]
): Fix {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const previous = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf-8") : "";
  const content = generateAgentsMarkdown({ repoRoot, profile, verificationStatus, repositoryName: path.basename(repoRoot) });
  return createFix({
    id: "fix-regenerate-agents-md",
    title: "Regenerate AGENTS.md from repository structure",
    description: "Replace AGENTS.md with a document generated from the live project profile and verification commands.",
    isSafe: false,
    file: agentsPath,
    oldText: previous,
    newText: content,
    fullOldContent: previous,
    changes: [{
      path: agentsPath,
      kind: previous ? "update" : "create",
      oldText: previous,
      newText: content,
      replaceFile: true,
    }],
  });
}

export function buildInstructionBootstrap(
  repoRoot: string,
  profile: ProjectProfile,
  verificationStatus: VerificationItem[]
): { findings: Finding[]; fixes: Fix[] } {
  const findings: Finding[] = [];
  const fixes: Fix[] = [];
  const agentsFix = buildMissingAgentsFix(repoRoot, profile, verificationStatus);
  if (agentsFix) {
    fixes.push(agentsFix);
    findings.push({
      id: "context-missing-agents-md",
      ruleId: "context/missing-agents-md",
      category: "context",
      severity: "high",
      confidence: 0.95,
      title: "Repository is missing AGENTS.md",
      description: "No AGENTS.md was found. Coding agents lack a single source of truth for layout, commands, and generated-file policy.",
      evidence: [{ file: "AGENTS.md", snippet: "File not found", source: "filesystem" }],
      recommendation: "Run `agentdoctor fix --safe` or `agentdoctor init` to generate AGENTS.md from the detected repository structure.",
      fix: agentsFix,
    });
  }
  return { findings, fixes };
}
