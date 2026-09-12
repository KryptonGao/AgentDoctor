import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { Finding } from "../../core/types.js";
import { SecurityFile } from "./files.js";
import {
  createFinding,
  isNegatedLine,
  isPlaceholderSecret,
  isRecord,
  lineAt,
  parseJsonRecord,
} from "./helpers.js";

const INJECTION_PATTERNS: Array<{ regex: RegExp; label: string; strong: boolean }> = [
  { regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|preceding)\s+(?:instructions?|prompts?|rules?|guidelines?)\b/i, label: "ignore-previous-instructions", strong: true },
  { regex: /\bdisregard\s+(?:the\s+)?(?:above|previous|prior)\s+(?:instructions?|prompts?|rules?)?\b/i, label: "disregard-previous", strong: true },
  { regex: /\bforget\s+(?:your|all|the)\s+(?:previous\s+)?(?:instructions?|rules?|guidelines?|system prompt)\b/i, label: "forget-instructions", strong: true },
  { regex: /\byou are now\s+(?:in\s+)?(?:DAN|developer mode|unrestricted|jailbreak)\b/i, label: "role-override", strong: true },
  { regex: /\b(?:enable|enter|activate)\s+(?:DAN mode|jailbreak)\b/i, label: "jailbreak", strong: true },
  { regex: /\boverride\s+(?:the\s+)?(?:system|developer|parent)\s+(?:prompt|instructions?|rules?)\b/i, label: "system-override", strong: true },
  { regex: /\b(?:new|these)\s+instructions?\s+(?:take|have)\s+priority\s+over\b/i, label: "priority-override", strong: true },
  { regex: /\bdo not follow\s+(?:the\s+)?(?:AGENTS\.md|CLAUDE\.md|system|developer)\b/i, label: "disable-system-file", strong: true },
  { regex: /<!--[\s\S]{0,240}?(?:ignore (?:all |previous )?instructions?|system prompt|you are now)[\s\S]{0,240}?-->/i, label: "html-comment-injection", strong: true },
  { regex: /<(?:system|important|secret_instruction)(?:\s[^>]*)?>[\s\S]{0,400}<\/(?:system|important|secret_instruction)>/i, label: "fake-system-tag", strong: true },
];

const UNICODE_POINTS: Array<{ code: number; name: string; severity: "high" | "medium" }> = [
  { code: 0x00ad, name: "SOFT HYPHEN", severity: "medium" },
  { code: 0x034f, name: "COMBINING GRAPHEME JOINER", severity: "high" },
  { code: 0x061c, name: "ARABIC LETTER MARK", severity: "high" },
  { code: 0x180e, name: "MONGOLIAN VOWEL SEPARATOR", severity: "high" },
  { code: 0x200b, name: "ZERO WIDTH SPACE", severity: "high" },
  { code: 0x200c, name: "ZERO WIDTH NON-JOINER", severity: "high" },
  { code: 0x200d, name: "ZERO WIDTH JOINER", severity: "high" },
  { code: 0x200e, name: "LEFT-TO-RIGHT MARK", severity: "high" },
  { code: 0x200f, name: "RIGHT-TO-LEFT MARK", severity: "high" },
  { code: 0x202a, name: "LEFT-TO-RIGHT EMBEDDING", severity: "high" },
  { code: 0x202b, name: "RIGHT-TO-LEFT EMBEDDING", severity: "high" },
  { code: 0x202c, name: "POP DIRECTIONAL FORMATTING", severity: "high" },
  { code: 0x202d, name: "LEFT-TO-RIGHT OVERRIDE", severity: "high" },
  { code: 0x202e, name: "RIGHT-TO-LEFT OVERRIDE", severity: "high" },
  { code: 0x2060, name: "WORD JOINER", severity: "high" },
  { code: 0x2061, name: "FUNCTION APPLICATION", severity: "medium" },
  { code: 0x2062, name: "INVISIBLE TIMES", severity: "medium" },
  { code: 0x2063, name: "INVISIBLE SEPARATOR", severity: "medium" },
  { code: 0x2064, name: "INVISIBLE PLUS", severity: "medium" },
  { code: 0x2066, name: "LEFT-TO-RIGHT ISOLATE", severity: "high" },
  { code: 0x2067, name: "RIGHT-TO-LEFT ISOLATE", severity: "high" },
  { code: 0x2068, name: "FIRST STRONG ISOLATE", severity: "high" },
  { code: 0x2069, name: "POP DIRECTIONAL ISOLATE", severity: "high" },
  { code: 0xfeff, name: "ZERO WIDTH NO-BREAK SPACE", severity: "high" },
  { code: 0xffa0, name: "HALFWIDTH HANGUL FILLER", severity: "medium" },
];

const UNICODE_LOOKUP = new Map(UNICODE_POINTS.map((item) => [item.code, item]));

const DANGEROUS_SHELL: Array<{ regex: RegExp; label: string; severity: "critical" | "high" }> = [
  { regex: /\brm\s+-rf\s+(?:\/|~|\$HOME|\.\.)(?:\s|$|[;&|])/ , label: "recursive-delete-root", severity: "critical" },
  { regex: /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, label: "fork-bomb", severity: "critical" },
  { regex: /\b(?:curl|wget)\b[^\n]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/i, label: "pipe-remote-shell", severity: "critical" },
  { regex: /\bbase64\s+-d\b[^\n]{0,80}\|\s*(?:ba)?sh\b/i, label: "decode-pipe-shell", severity: "critical" },
  { regex: /\beval\s*\(\s*(?:curl|wget)\b/i, label: "eval-remote", severity: "critical" },
  { regex: /\bbash\s+-i\s+>&\s*\/dev\/tcp\//i, label: "reverse-shell", severity: "critical" },
  { regex: /\b(?:nc|ncat|netcat)\b[^\n]{0,80}\s-e\s/i, label: "nc-exec", severity: "critical" },
  { regex: /\bchmod\s+(?:-R\s+)?777\b/, label: "chmod-777", severity: "high" },
  { regex: /\bdd\s+if=/, label: "dd-overwrite", severity: "high" },
  { regex: /\bmkfs(?:\.\w+)?\s+/, label: "mkfs", severity: "critical" },
  { regex: /\b(?:shutdown|reboot|halt)\b(?:\s|$)/, label: "power-control", severity: "high" },
];

const UNTRUSTED_FOLLOW: Array<{ regex: RegExp; label: string }> = [
  { regex: /\b(?:follow|obey|execute|treat)\s+(?:the\s+)?(?:readme|github issues?|issues?|pull requests?|prs?|tool outputs?|tool results?)\s+(?:as|like)\s+(?:your\s+)?(?:system\s+)?(?:instructions?|commands?|source of truth)\b/i, label: "follow-untrusted-as-instructions" },
  { regex: /\b(?:readme|github issues?|tool outputs?)\s+is\s+(?:your|the)\s+(?:only|source of)\s+(?:instruction|truth)\b/i, label: "untrusted-source-of-truth" },
  { regex: /\bexecute\s+(?:any|all|every)\s+commands?\s+(?:in|from|inside)\s+(?:the\s+)?(?:readme|issue|pr|tool output)\b/i, label: "execute-commands-from-untrusted" },
];

const GENERATED_EDIT = /\b(?:edit|modify|update|rewrite|patch|commit|check in)\s+(?:the\s+)?(?:files?\s+in\s+|code\s+in\s+)?(?:generated|dist|build|openapi-generated|\.next|out|target)\b/i;
const NETWORK_INSTRUCTION = /\b(?:always|must|should)\s+(?:use|call|run|enable)\s+(?:web_?search|web_?fetch|webfetch|websearch)\b/i;
const EXFIL = /\b(?:post|upload|send|exfiltrate)\s+(?:this|the|your)?\s*(?:diff|source|code|secret|token|key|prompt)\s+to\s+https?:\/\//i;
const BROAD_PERMISSION = /^(?:\*|bash\(\*\)|shell\(\*\)|webfetch\(\*\)|websearch\(\*\)|web_fetch\(\*\)|web_search\(\*\))$/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i;

function visibleSnippet(line: string): string {
  return [...line].map((char) => {
    const info = UNICODE_LOOKUP.get(char.codePointAt(0) || 0);
    if (!info) return char;
    return `<U+${info.code.toString(16).toUpperCase().padStart(4, "0")}>`;
  }).join("");
}

function isTagCharacter(code: number): boolean {
  return code === 0xe0001 || (code >= 0xe0020 && code <= 0xe007f);
}

export function detectPromptInjection(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind === "untrusted-doc") continue;
    for (const pattern of INJECTION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const flags = pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`;
      const global = new RegExp(pattern.regex.source, flags);
      let match: RegExpExecArray | null;
      while ((match = global.exec(file.content))) {
        const loc = lineAt(file.content, match.index);
        if (isNegatedLine(loc.text)) continue;
        findings.push(createFinding({
          file,
          ruleId: "security/prompt-injection",
          severity: "high",
          confidence: pattern.label.startsWith("html") || pattern.label.startsWith("fake") ? 0.88 : 0.92,
          title: `Prompt injection pattern in ${file.relativePath}`,
          description: `Instruction text matches a prompt-injection / jailbreak pattern (${pattern.label}). Coding agents that load this file may treat the injected directive as a higher-priority system instruction.`,
          recommendation: "Remove override/jailbreak language. Keep repository instructions additive and never tell the agent to ignore system or parent instructions.",
          line: loc.line,
          snippet: loc.text,
          idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`,
        }));
      }
    }
  }
  return findings;
}

export function detectHiddenUnicode(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const hits: Array<{ index: number; info: { code: number; name: string; severity: "high" | "medium" } }> = [];
    for (let i = 0; i < file.content.length; i++) {
      const code = file.content.codePointAt(i);
      if (code === undefined) continue;
      if (code > 0xffff) i++;
      if (code === 0xfeff && i === 0) continue;
      const info = UNICODE_LOOKUP.get(code);
      if (info) {
        hits.push({ index: i, info });
        continue;
      }
      if (isTagCharacter(code)) {
        hits.push({ index: i, info: { code, name: "UNICODE TAG CHARACTER", severity: "high" } });
      }
    }
    if (hits.length === 0) continue;
    const first = hits[0];
    const loc = lineAt(file.content, first.index);
    const names = [...new Set(hits.slice(0, 6).map((hit) => `U+${hit.info.code.toString(16).toUpperCase().padStart(4, "0")} ${hit.info.name}`))];
    const high = hits.some((hit) => hit.info.severity === "high");
    findings.push(createFinding({
      file,
      ruleId: "security/hidden-unicode",
      severity: high ? "high" : "medium",
      confidence: 0.96,
      title: `Hidden Unicode in ${file.relativePath}`,
      description: `${hits.length} invisible or bidirectional Unicode character(s) found (${names.join(", ")}). These can hide instructions, reverse displayed text, or smuggle payloads past human review.`,
      recommendation: "Delete zero-width, tag, and bidi override characters from agent-readable files. Keep the visible text identical to the bytes the model receives.",
      line: loc.line,
      snippet: visibleSnippet(loc.text),
      idSuffix: `${file.relativePath}-unicode`,
    }));
  }
  return findings;
}

export function detectInstructionSecrets(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  const prefixed = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|gho_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{10,}|xox[bpas]-[A-Za-z0-9-]{6,})\b/;
  const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
  const assignment = /(?:^|[\s,{])((?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*["']?)([^"'\s,;}]{8,})/gi;

  for (const file of files) {
    const liveAssignments: string[] = [];
    assignment.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = assignment.exec(file.content))) {
      if (!isPlaceholderSecret(match[2])) liveAssignments.push(match[2]);
    }
    const hasPrefixed = prefixed.test(file.content) || privateKey.test(file.content);
    if (!hasPrefixed && liveAssignments.length === 0) continue;
    const prefixAt = file.content.search(prefixed);
    const assignAt = (() => {
      assignment.lastIndex = 0;
      const found = assignment.exec(file.content);
      return found ? found.index : -1;
    })();
    const loc = lineAt(file.content, Math.max(0, prefixAt >= 0 ? prefixAt : assignAt));
    findings.push(createFinding({
      file,
      ruleId: "security/instruction-secrets",
      severity: "critical",
      confidence: 0.93,
      title: `Secret material in ${file.relativePath}`,
      description: "An agent instruction or MCP/hook config file contains a live-looking credential. Models and session logs will copy it into prompts, traces, and patches.",
      recommendation: "Remove the literal secret. Reference an environment variable name only, and rotate the exposed credential.",
      line: loc.line,
      snippet: loc.text,
      idSuffix: `${file.relativePath}-secret`,
    }));
  }
  return findings;
}

export function detectDangerousShell(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const pattern of DANGEROUS_SHELL) {
      const global = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = global.exec(file.content))) {
        const loc = lineAt(file.content, match.index);
        if (isNegatedLine(loc.text)) continue;
        findings.push(createFinding({
          file,
          ruleId: "security/dangerous-shell",
          severity: pattern.severity,
          confidence: file.kind === "agent-config" ? 0.94 : 0.9,
          title: `Dangerous shell command (${pattern.label})`,
          description: `A ${file.kind === "agent-config" ? "hook/MCP command" : "instruction"} contains a destructive or remote-execution shell pattern (${pattern.label}). Agents and hook runners may execute it with repository privileges.`,
          recommendation: "Delete the command. If documentation must mention it, keep a clear never/do-not prefix and do not place it in hooks, MCP stdio commands, or copy-pasteable fenced blocks without negation.",
          line: loc.line,
          snippet: loc.text,
          idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`,
        }));
      }
    }
  }
  return findings;
}

function parseConfig(file: SecurityFile): Record<string, unknown> | null {
  if (file.relativePath.endsWith(".toml")) {
    try {
      const value = parseToml(file.content);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  if (file.relativePath.endsWith(".yml") || file.relativePath.endsWith(".yaml")) {
    try {
      const value = YAML.parse(file.content);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  return parseJsonRecord(file.content);
}

function looksLikeMcpServerMap(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, config]) => {
    if (!isRecord(config)) return false;
    return (
      typeof config.command === "string" ||
      Array.isArray(config.command) ||
      typeof config.url === "string" ||
      typeof config.type === "string" ||
      Array.isArray(config.args)
    );
  });
}

function collectMcpServers(data: Record<string, unknown>): Array<{ name: string; config: Record<string, unknown> }> {
  const roots: unknown[] = [data.mcpServers, data.mcp_servers];
  if (isRecord(data.mcp)) {
    roots.push(data.mcp.servers, data.mcp.mcpServers);
    if (!isRecord(data.mcp.servers) && !isRecord(data.mcp.mcpServers) && looksLikeMcpServerMap(data.mcp)) {
      roots.push(data.mcp);
    }
  }
  const servers: Array<{ name: string; config: Record<string, unknown> }> = [];
  for (const root of roots) {
    if (!isRecord(root)) continue;
    for (const [name, config] of Object.entries(root)) {
      if (isRecord(config)) servers.push({ name, config });
    }
  }
  return servers;
}

function walkHookCommands(data: unknown, visit: (command: string, event: string, matcher: string) => void): void {
  if (!isRecord(data)) return;
  const hooksRoot = isRecord(data.hooks) ? data.hooks : data;
  for (const [event, groups] of Object.entries(hooksRoot)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : "*";
      const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const handler of handlers) {
        if (!isRecord(handler)) continue;
        if (typeof handler.command === "string" && handler.command.trim()) {
          visit(handler.command, event, matcher);
        }
      }
    }
  }
}

function permissionList(data: Record<string, unknown>): string[] {
  const permissions = isRecord(data.permissions) ? data.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const defaultMode = typeof permissions.defaultMode === "string" ? [permissions.defaultMode] : [];
  const autoApprove = Array.isArray(data.autoApprove) ? data.autoApprove : [];
  const alwaysAllow = Array.isArray(data.alwaysAllow) ? data.alwaysAllow : [];
  return [...allow, ...defaultMode, ...autoApprove, ...alwaysAllow].filter((item): item is string => typeof item === "string");
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function detectMcpAndHookPermissions(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind !== "agent-config") continue;
    const data = parseConfig(file);
    if (!data) continue;

    const permissions = permissionList(data);
    const broad = permissions.filter((item) => BROAD_PERMISSION.test(item.trim()) || item.trim() === "bypassPermissions");
    if (broad.length > 0) {
      findings.push(createFinding({
        file,
        ruleId: "security/mcp-hook-permissions",
        severity: "high",
        confidence: 0.92,
        title: `Unrestricted agent tool permission in ${file.relativePath}`,
        description: `Permissions allow unrestricted execution (${broad.join(", ")}). Combined with a prompt-injection in any loaded file, the agent can run arbitrary shell or network tools without an approval gate.`,
        recommendation: "Replace wildcard allow-lists with explicit tools and commands. Keep Bash/WebFetch denied or require approval.",
        snippet: broad.join(", "),
        idSuffix: `${file.relativePath}-perm`,
      }));
    }

    const approval = String(data.approval_policy || data.approvalPolicy || "");
    const sandbox = String(data.sandbox_mode || data.sandbox || data.sandboxMode || "");
    if (/^(?:never|untrusted|danger-full-access)$/i.test(approval) || /danger-full-access/i.test(sandbox)) {
      findings.push(createFinding({
        file,
        ruleId: "security/mcp-hook-permissions",
        severity: "high",
        confidence: 0.9,
        title: `Agent sandbox/approval disabled in ${file.relativePath}`,
        description: `approval_policy=${approval || "unset"} sandbox=${sandbox || "unset"} removes the human approval or filesystem sandbox that normally contains a compromised agent.`,
        recommendation: "Use an approval policy that prompts on unknown commands and a sandbox that cannot write outside the workspace.",
        snippet: `approval_policy=${approval} sandbox=${sandbox}`,
        idSuffix: `${file.relativePath}-sandbox`,
      }));
    }

    for (const server of collectMcpServers(data)) {
      const alwaysAllow = server.config.alwaysAllow === true || server.config.autoApprove === true;
      const autoList = Array.isArray(server.config.autoApprove) ? server.config.autoApprove : [];
      const star = autoList.some((item) => item === "*" || item === "all");
      if (alwaysAllow || star) {
        findings.push(createFinding({
          file,
          ruleId: "security/mcp-hook-permissions",
          severity: "high",
          confidence: 0.91,
          title: `MCP server "${server.name}" auto-approves tools`,
          description: "This MCP server skips tool approval. A poisoned server or injected tool call can run without a human in the loop.",
          recommendation: `Remove alwaysAllow/autoApprove from MCP server "${server.name}" and approve tools per session.`,
          snippet: `mcpServers.${server.name}`,
          idSuffix: `${file.relativePath}-mcp-${server.name}`,
        }));
      }
    }

    walkHookCommands(data, (command, event, matcher) => {
      if (matcher !== "*" && matcher !== "") return;
      findings.push(createFinding({
        file,
        ruleId: "security/mcp-hook-permissions",
        severity: "medium",
        confidence: 0.84,
        title: `Unscoped ${event} hook command`,
        description: `Hook event "${event}" runs \`${command}\` for matcher "${matcher || "*"}". Broad matchers fire on every tool call, which is a privilege-escalation path if the command is network-capable or mutates the tree.`,
        recommendation: "Scope the hook matcher to the specific tool (for example Bash or Write) and keep the command read-only unless it is a local formatter.",
        snippet: `${event} ${matcher}: ${command}`,
        idSuffix: `${file.relativePath}-hook-${event}`,
      }));
    });
  }
  return findings;
}

export function detectExternalNetwork(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind === "instruction") {
      const patterns = [NETWORK_INSTRUCTION, EXFIL];
      for (const regex of patterns) {
        const global = new RegExp(regex.source, "gi");
        let match: RegExpExecArray | null;
        while ((match = global.exec(file.content))) {
          const loc = lineAt(file.content, match.index);
          if (isNegatedLine(loc.text)) continue;
          findings.push(createFinding({
            file,
            ruleId: "security/external-network",
            severity: EXFIL.test(match[0]) ? "critical" : "medium",
            confidence: 0.88,
            title: "Instruction grants or directs external network access",
            description: "Agent instructions tell the model to call web tools or send repository data to a remote URL. That is an exfiltration and supply-chain channel.",
            recommendation: "Do not instruct agents to fetch or post to the public internet by default. If a specific host is required, name it and keep WebFetch/WebSearch behind approval.",
            line: loc.line,
            snippet: loc.text,
            idSuffix: `${file.relativePath}-${loc.line}-net`,
          }));
        }
      }
    }

    if (file.kind !== "agent-config") continue;
    const data = parseConfig(file);
    if (!data) continue;

    for (const server of collectMcpServers(data)) {
      const url = typeof server.config.url === "string" ? server.config.url : "";
      if (!/^https?:\/\//i.test(url)) continue;
      const host = hostFromUrl(url);
      if (LOCAL_HOST.test(host)) continue;
      findings.push(createFinding({
        file,
        ruleId: "security/external-network",
        severity: "medium",
        confidence: 0.9,
        title: `Remote MCP server "${server.name}"`,
        description: `MCP server "${server.name}" connects to ${host || url}. Tool names, file contents, and secrets in env can leave the machine.`,
        recommendation: "Prefer local stdio MCP servers. If a remote server is required, pin a trusted host, strip secrets from env, and keep tool auto-approve off.",
        snippet: url,
        idSuffix: `${file.relativePath}-mcp-url-${server.name}`,
      }));
    }

    walkHookCommands(data, (command, event) => {
      if (!/\b(?:curl|wget|nc|ncat|fetch)\b/i.test(command) && !/https?:\/\//i.test(command)) return;
      const loc = lineAt(file.content, file.content.indexOf(command));
      findings.push(createFinding({
        file,
        ruleId: "security/external-network",
        severity: "high",
        confidence: 0.9,
        title: `Hook ${event} performs outbound network I/O`,
        description: "A hook command reaches the network. Prompt injection in any later tool output can turn this into data theft.",
        recommendation: "Remove network calls from hooks. If a webhook is required, pin the destination and pass no file contents or secrets.",
        line: loc.line > 0 ? loc.line : undefined,
        snippet: command,
        idSuffix: `${file.relativePath}-hook-net-${event}`,
      }));
    });
  }
  return findings;
}

export function detectGeneratedEdits(files: SecurityFile[], generatedDirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind !== "instruction" && file.kind !== "agent-config") continue;
    const global = new RegExp(GENERATED_EDIT.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = global.exec(file.content))) {
      const loc = lineAt(file.content, match.index);
      if (isNegatedLine(loc.text)) continue;
      findings.push(createFinding({
        file,
        ruleId: "security/generated-file-edit",
        severity: "high",
        confidence: 0.9,
        title: "Instructions tell the agent to edit generated output",
        description: "The agent is directed to modify build/generated artifacts. Those edits are overwritten on the next build and often bypass source review.",
        recommendation: "Tell agents never to edit generated directories. Point them at the generator input instead.",
        line: loc.line,
        snippet: loc.text,
        idSuffix: `${file.relativePath}-${loc.line}-generated`,
      }));
    }
  }

  for (const file of files) {
    if (file.kind !== "agent-config" || generatedDirs.length === 0) continue;
    const data = parseConfig(file);
    if (!data) continue;
    walkHookCommands(data, (command, event) => {
      const touches = generatedDirs.some((dir) => command.includes(`${dir}/`) || command.includes(`${dir} `));
      if (!touches) return;
      findings.push(createFinding({
        file,
        ruleId: "security/generated-file-edit",
        severity: "medium",
        confidence: 0.86,
        title: `Hook ${event} writes generated directories`,
        description: `Hook command \`${command}\` targets generated output (${generatedDirs.join(", ")}).`,
        recommendation: "Keep hooks away from dist/generated/. Run the generator from source instead.",
        snippet: command,
        idSuffix: `${file.relativePath}-hook-generated-${event}`,
      }));
    });
  }
  return findings;
}

export function detectUntrustedInput(files: SecurityFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind === "instruction") {
      for (const pattern of UNTRUSTED_FOLLOW) {
        const global = new RegExp(pattern.regex.source, "gi");
        let match: RegExpExecArray | null;
        while ((match = global.exec(file.content))) {
          const loc = lineAt(file.content, match.index);
          if (isNegatedLine(loc.text)) continue;
          findings.push(createFinding({
            file,
            ruleId: "security/untrusted-content-injection",
            severity: "high",
            confidence: 0.91,
            title: "Untrusted README/issue/tool output treated as instructions",
            description: "The agent is told to follow README, GitHub issues, or tool output as commands. Those sources are attacker-controlled in many workflows (copied issues, malicious READMEs, poisoned tool results).",
            recommendation: "State explicitly that README, issues, PRs, and tool output are untrusted data. The agent must not execute commands found there unless they already exist in repository instructions.",
            line: loc.line,
            snippet: loc.text,
            idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`,
          }));
        }
      }
    }

    if (file.kind !== "untrusted-doc") continue;
    for (const pattern of INJECTION_PATTERNS) {
      const global = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = global.exec(file.content))) {
        const loc = lineAt(file.content, match.index);
        if (isNegatedLine(loc.text)) continue;
        if (/security\/[a-z0-9-]+/.test(loc.text) || /ignore-previous-instructions/.test(loc.text)) continue;
        findings.push(createFinding({
          file,
          ruleId: "security/untrusted-content-injection",
          severity: "high",
          confidence: 0.9,
          title: `Injection payload in untrusted ${file.relativePath}`,
          description: `README/issue/PR text contains a prompt-injection pattern (${pattern.label}). Agents that dump this file into the prompt can be steered by repository visitors or copied issue bodies.`,
          recommendation: "Delete hidden or jailbreak language from README and issue templates. Add an instruction that those documents are data, not system commands.",
          line: loc.line,
          snippet: loc.text,
          idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`,
        }));
      }
    }
  }
  return findings;
}
