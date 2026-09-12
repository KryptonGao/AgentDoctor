import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import fg from "fast-glob";
import micromatch from "micromatch";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { getGitRoot } from "../../shared/git.js";
import { redactStructured, redactText } from "../runtime/redact.js";
import { estimateTokens } from "./tokenCounter.js";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILE_META,
  AgentProfileId,
  EffectiveContextBudget,
  EffectiveContextCapability,
  EffectiveContextDiagnostic,
  EffectiveContextEntry,
  EffectiveContextEntryKind,
  EffectiveContextQuery,
  EffectiveContextRelationship,
  EffectiveContextReport,
  EffectiveContextScope,
  EffectiveInstructionBlock,
  isAgentProfileId,
} from "./effectiveTypes.js";

type UnknownRecord = Record<string, unknown>;

interface NormalizedContext {
  agent: AgentProfileId;
  cwd: string;
  repositoryRoot: string;
  targetPaths: string[];
  task: string;
  rules: string[];
  skills: string[];
  subagent: string | null;
  hookEvent: string | null;
  toolName: string | null;
  profile: string | null;
  includeGlobal: boolean;
  allowExternalImports: boolean;
  contextWindowTokens: number | null;
  homeDir: string;
}

interface BuildState {
  ctx: NormalizedContext;
  prompt: EffectiveContextEntry[];
  candidates: EffectiveContextEntry[];
  capabilities: EffectiveContextCapability[];
  relationships: EffectiveContextRelationship[];
  diagnostics: EffectiveContextDiagnostic[];
  knownLimits: EffectiveContextBudget["knownLimits"];
  order: number;
  imported: Set<string>;
}

interface FrontmatterResult {
  data: UnknownRecord;
  body: string;
  bodyLine: number;
  error?: string;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function displayPath(state: BuildState, absolutePath: string): string {
  if (isInside(state.ctx.repositoryRoot, absolutePath)) {
    return normalizeSlashes(path.relative(state.ctx.repositoryRoot, absolutePath) || ".");
  }
  if (isInside(state.ctx.homeDir, absolutePath)) {
    return `~/${normalizeSlashes(path.relative(state.ctx.homeDir, absolutePath))}`;
  }
  return normalizeSlashes(absolutePath);
}

function directoryChain(root: string, cwd: string): string[] {
  if (!isInside(root, cwd)) return [root];
  const rel = path.relative(root, cwd);
  const parts = rel ? rel.split(path.sep) : [];
  const dirs = [root];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    dirs.push(current);
  }
  return dirs;
}

function nearestProjectRoot(cwd: string): string {
  const markerNames = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  let current = cwd;
  while (true) {
    if (markerNames.some((name) => fs.existsSync(path.join(current, name)))) return current;
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function readText(state: BuildState, file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    state.diagnostics.push({
      severity: "warning",
      code: "source-unreadable",
      message: error instanceof Error ? error.message : String(error),
      source: displayPath(state, file),
    });
    return null;
  }
}

function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---")) return { data: {}, body: content, bodyLine: 1 };
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!match) return { data: {}, body: content, bodyLine: 1, error: "Unclosed YAML frontmatter" };
  try {
    const parsed = YAML.parse(match[1]);
    return {
      data: isRecord(parsed) ? parsed : {},
      body: content.slice(match[0].length),
      bodyLine: match[0].split(/\r?\n/).length,
    };
  } catch (error) {
    return {
      data: {},
      body: content.slice(match[0].length),
      bodyLine: match[0].split(/\r?\n/).length,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseBlocks(entryId: string, source: string, content: string, startLine = 1): EffectiveInstructionBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: EffectiveInstructionBlock[] = [];
  let heading: string | undefined;
  let paragraph: string[] = [];
  let paragraphLine = startLine;
  let fenced = false;

  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) {
      blocks.push({
        id: stableId("block", `${entryId}:${paragraphLine}:${text}`),
        entryId,
        source,
        line: paragraphLine,
        heading,
        content: text,
        estimatedTokens: estimateTokens(text),
      });
    }
    paragraph = [];
  };

  lines.forEach((line, index) => {
    const lineNumber = startLine + index;
    if (/^\s*```/.test(line)) {
      if (paragraph.length === 0) paragraphLine = lineNumber;
      paragraph.push(line);
      fenced = !fenced;
      return;
    }
    if (!fenced) {
      const headingMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
      if (headingMatch) {
        flush();
        heading = headingMatch[1];
        return;
      }
      if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
        flush();
        paragraphLine = lineNumber;
        paragraph = [line];
        flush();
        return;
      }
      if (line.trim() === "") {
        flush();
        return;
      }
    }
    if (paragraph.length === 0) paragraphLine = lineNumber;
    paragraph.push(line);
  });
  flush();
  return blocks;
}

function addEntry(
  state: BuildState,
  target: "prompt" | "candidates",
  input: {
    kind: EffectiveContextEntryKind;
    source: string;
    scope: EffectiveContextScope;
    status?: EffectiveContextEntry["status"];
    content: string;
    matchReason: string;
    name?: string;
    condition?: string;
    line?: number;
  }
): EffectiveContextEntry {
  const rawBytes = Buffer.byteLength(input.content, "utf8");
  const estimatedTokens = estimateTokens(input.content);
  const redacted = redactText(input.content);
  const source = normalizeSlashes(input.source);
  const id = stableId("entry", `${state.ctx.agent}:${source}:${input.kind}:${input.name || ""}:${state.order}`);
  const entry: EffectiveContextEntry = {
    id,
    kind: input.kind,
    source,
    scope: input.scope,
    status: input.status || (target === "prompt" ? "loaded" : "candidate"),
    order: state.order++,
    line: input.line,
    name: input.name,
    content: redacted.text,
    rawBytes,
    estimatedTokens,
    matchReason: input.matchReason,
    condition: input.condition,
    blocks: parseBlocks(id, source, redacted.text, input.line || 1),
    redactedFields: redacted.redactedCount,
  };
  state[target].push(entry);
  return entry;
}

function addFileEntry(
  state: BuildState,
  target: "prompt" | "candidates",
  file: string,
  scope: EffectiveContextScope,
  kind: EffectiveContextEntryKind,
  reason: string,
  options: { name?: string; condition?: string; content?: string; line?: number } = {}
): EffectiveContextEntry | null {
  const content = options.content ?? readText(state, file);
  if (content === null) return null;
  return addEntry(state, target, {
    kind,
    source: displayPath(state, file),
    scope,
    content,
    matchReason: reason,
    name: options.name,
    condition: options.condition,
    line: options.line,
  });
}

function addCapability(state: BuildState, capability: Omit<EffectiveContextCapability, "id">): EffectiveContextCapability {
  const sanitized = redactStructured(capability.details || {});
  const item: EffectiveContextCapability = {
    ...capability,
    id: stableId("cap", `${capability.kind}:${capability.name}:${capability.scope}:${capability.source}`),
    details: sanitized.value as EffectiveContextCapability["details"],
  };
  state.capabilities.push(item);
  return item;
}

function parseJson(state: BuildState, file: string): UnknownRecord | null {
  const text = readText(state, file);
  if (text === null) return null;
  const tryParse = (raw: string): UnknownRecord | null => {
    const value = JSON.parse(raw);
    if (isRecord(value)) return value;
    throw new Error("Expected a JSON object");
  };
  try {
    return tryParse(text);
  } catch (firstError) {
    try {
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      return tryParse(stripped);
    } catch {
      state.diagnostics.push({ severity: "error", code: "invalid-json", message: firstError instanceof Error ? firstError.message : String(firstError), source: displayPath(state, file) });
      return null;
    }
  }
}

function parseYamlFile(state: BuildState, file: string): UnknownRecord | null {
  const text = readText(state, file);
  if (text === null) return null;
  try {
    const value = YAML.parse(text);
    if (isRecord(value)) return value;
    throw new Error("Expected a YAML object");
  } catch (error) {
    state.diagnostics.push({ severity: "error", code: "invalid-yaml", message: error instanceof Error ? error.message : String(error), source: displayPath(state, file) });
    return null;
  }
}

function parseTomlFile(state: BuildState, file: string): UnknownRecord | null {
  const text = readText(state, file);
  if (text === null) return null;
  try {
    const value = parseToml(text);
    if (isRecord(value)) return value;
    throw new Error("Expected a TOML object");
  } catch (error) {
    state.diagnostics.push({ severity: "error", code: "invalid-toml", message: error instanceof Error ? error.message : String(error), source: displayPath(state, file) });
    return null;
  }
}

function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child)) {
      for (const [nestedKey, nestedValue] of flatten(child, next)) result.set(nestedKey, nestedValue);
    } else {
      result.set(next, child);
    }
  }
  return result;
}

function mergeConfigLayers(
  state: BuildState,
  layers: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord }>
): UnknownRecord {
  const merged: UnknownRecord = {};
  const owners = new Map<string, { capability: EffectiveContextCapability; source: string }>();
  for (const layer of layers) {
    const source = displayPath(state, layer.file);
    for (const [key, value] of flatten(layer.data)) {
      const previous = owners.get(key);
      setDeep(merged, key.split("."), value);
      const isEnvironmentValue = /(?:^|\.)env\.[^.]+$/i.test(key);
      const capability = addCapability(state, {
        kind: "configuration",
        name: key,
        source,
        scope: layer.scope,
        status: previous ? "selected" : "available",
        reason: previous ? "Highest-precedence value seen so far" : "Effective configuration value",
        details: isEnvironmentValue ? { configured: value !== undefined && value !== "" } : { value: safeScalar(value) },
      });
      if (previous) {
        previous.capability.status = "overridden";
        previous.capability.overriddenBy = source;
        state.relationships.push({
          id: stableId("rel", `${capability.id}:${previous.capability.id}:overrides`),
          type: "overrides",
          from: capability.id,
          to: previous.capability.id,
          certainty: "certain",
          reason: `Higher-precedence configuration redefines ${key}`,
        });
      }
      owners.set(key, { capability, source });
    }
  }
  return merged;
}

function setDeep(target: UnknownRecord, keys: string[], value: unknown): void {
  let current = target;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      current[key] = value;
      return;
    }
    if (!isRecord(current[key])) current[key] = {};
    current = current[key] as UnknownRecord;
  });
}

function safeScalar(value: unknown): string | number | boolean | string[] | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return "[object]";
}

function getDeep(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function targetMatches(state: BuildState, patterns: string[]): boolean {
  if (patterns.length === 0 || state.ctx.targetPaths.length === 0) return false;
  return state.ctx.targetPaths.some((target) => micromatch.isMatch(target, patterns, { dot: true }));
}

function normalizePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? item.split(",") : []).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function isExplicit(name: string, selected: string[], task: string, prefix: "$" | "@" = "$" ): boolean {
  return selected.some((item) => item.toLowerCase() === name.toLowerCase()) || task.toLowerCase().includes(`${prefix}${name.toLowerCase()}`);
}

function discoverSkillFiles(root: string, pattern: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fg.sync(pattern, { cwd: root, absolute: true, dot: true, onlyFiles: true, followSymbolicLinks: true }).sort();
}

function skillMetadata(content: string, fallbackName: string): { name: string; description: string; body: string; line: number; error?: string } {
  const fm = parseFrontmatter(content);
  return {
    name: typeof fm.data.name === "string" ? fm.data.name : fallbackName,
    description: typeof fm.data.description === "string" ? fm.data.description : "No description",
    body: fm.body,
    line: fm.bodyLine,
    error: fm.error,
  };
}

function addSkills(
  state: BuildState,
  items: Array<{ file: string; scope: EffectiveContextScope; rank?: number }>,
  options: { codexCatalog?: boolean; overrideSameName?: boolean } = {}
): void {
  const parsed = items.flatMap((item) => {
    const content = readText(state, item.file);
    if (content === null) return [];
    const meta = skillMetadata(content, path.basename(path.dirname(item.file)));
    if (meta.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: meta.error, source: displayPath(state, item.file) });
    return [{ ...item, ...meta }];
  });

  const winners = new Map<string, typeof parsed[number]>();
  if (options.overrideSameName) {
    for (const item of parsed) {
      const current = winners.get(item.name);
      if (!current || (item.rank || 0) > (current.rank || 0)) winners.set(item.name, item);
    }
  }

  let catalogChars = 0;
  let catalogExceeded = false;
  const catalogLimit = options.codexCatalog
    ? Math.min(8000, state.ctx.contextWindowTokens ? Math.floor(state.ctx.contextWindowTokens * 0.02 * 4) : 8000)
    : Number.POSITIVE_INFINITY;

  for (const item of parsed) {
    const source = displayPath(state, item.file);
    const overridden = options.overrideSameName && winners.get(item.name) !== item;
    if (item.error) {
      addCapability(state, { kind: "skill", name: item.name, source, scope: item.scope, status: "invalid", reason: "Skill frontmatter is invalid", details: { description: item.description } });
      addEntry(state, "candidates", { kind: "skill", source, scope: item.scope, status: "invalid", name: item.name, content: item.body, matchReason: "Invalid skill frontmatter prevents deterministic loading", line: item.line });
      continue;
    }
    const cap = addCapability(state, {
      kind: "skill",
      name: item.name,
      source,
      scope: item.scope,
      status: overridden ? "overridden" : isExplicit(item.name, state.ctx.skills, state.ctx.task) ? "selected" : "available",
      reason: overridden ? "A higher-precedence skill has the same name" : "Discovered skill",
      overriddenBy: overridden ? displayPath(state, winners.get(item.name)!.file) : undefined,
      details: { description: item.description },
    });

    if (overridden) {
      const winner = winners.get(item.name)!;
      state.relationships.push({
        id: stableId("rel", `${cap.id}:${winner.file}:skill-override`),
        type: "overrides",
        from: stableId("cap", `skill:${item.name}:${winner.scope}:${displayPath(state, winner.file)}`),
        to: cap.id,
        certainty: "certain",
        reason: "Higher-precedence skill definition has the same name",
      });
    }

    if (overridden) continue;
    const metadataText = `${item.name}: ${item.description}`;
    if (catalogChars + metadataText.length <= catalogLimit) {
      addEntry(state, "prompt", {
        kind: "skill-metadata",
        source,
        scope: item.scope,
        name: item.name,
        content: metadataText,
        matchReason: "Skill discovery metadata is available to the agent",
      });
      catalogChars += metadataText.length;
    } else {
      catalogExceeded = true;
      const entry = addEntry(state, "candidates", {
        kind: "skill-metadata",
        source,
        scope: item.scope,
        name: item.name,
        content: metadataText,
        matchReason: "Skill metadata exceeded the discovery catalogue budget",
      });
      entry.status = "truncated";
    }

    if (cap.status === "selected") {
      addFileEntry(state, "prompt", item.file, item.scope, "skill", "Skill was explicitly invoked", { name: item.name, content: item.body, line: item.line });
    } else {
      addFileEntry(state, "candidates", item.file, item.scope, "skill", "Skill may be selected when its description matches the task", { name: item.name, content: item.body, line: item.line });
    }
  }

  if (options.codexCatalog && Number.isFinite(catalogLimit)) {
    state.knownLimits.push({ name: "Codex initial skill catalogue", unit: "characters", limit: catalogLimit, used: catalogChars, exceeded: catalogExceeded });
  }
}

function addSubagents(
  state: BuildState,
  files: Array<{ file: string; scope: EffectiveContextScope; format: "markdown" | "toml"; rank: number }>,
  overrideSameName: boolean
): void {
  const parsed = files.flatMap((item) => {
    if (item.format === "toml") {
      const data = parseTomlFile(state, item.file);
      if (!data) return [];
      const name = typeof data.name === "string" ? data.name : path.basename(item.file, path.extname(item.file));
      return [{ ...item, name, description: typeof data.description === "string" ? data.description : "No description", instructions: typeof data.developer_instructions === "string" ? data.developer_instructions : "", error: undefined as string | undefined }];
    }
    const content = readText(state, item.file);
    if (content === null) return [];
    const fm = parseFrontmatter(content);
    const name = typeof fm.data.name === "string" ? fm.data.name : path.basename(item.file, path.extname(item.file));
    if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, item.file) });
    return [{ ...item, name, description: typeof fm.data.description === "string" ? fm.data.description : "No description", instructions: fm.body, error: fm.error }];
  });
  const winners = new Map<string, typeof parsed[number]>();
  for (const item of parsed) {
    const current = winners.get(item.name);
    if (!current || item.rank > current.rank) winners.set(item.name, item);
  }
  for (const item of parsed) {
    const overridden = overrideSameName && winners.get(item.name) !== item;
    const selected = !item.error && !overridden && state.ctx.subagent?.toLowerCase() === item.name.toLowerCase();
    const capability = addCapability(state, {
      kind: "subagent",
      name: item.name,
      source: displayPath(state, item.file),
      scope: item.scope,
      status: item.error ? "invalid" : overridden ? "overridden" : selected ? "selected" : "available",
      reason: item.error ? "Custom agent frontmatter is invalid" : overridden ? "A higher-precedence definition has the same name" : selected ? "Explicitly selected subagent" : "Available for delegation",
      overriddenBy: overridden ? displayPath(state, winners.get(item.name)!.file) : undefined,
      details: { description: item.description },
    });
    if (overridden) {
      const winner = winners.get(item.name)!;
      state.relationships.push({
        id: stableId("rel", `${capability.id}:${winner.file}:subagent-override`),
        type: "overrides",
        from: stableId("cap", `subagent:${item.name}:${winner.scope}:${displayPath(state, winner.file)}`),
        to: capability.id,
        certainty: "certain",
        reason: "Higher-precedence custom agent definition has the same name",
      });
    }
    if (item.error) {
      addEntry(state, "candidates", { kind: "subagent-instruction", source: displayPath(state, item.file), scope: item.scope, status: "invalid", name: item.name, content: item.instructions, matchReason: "Invalid custom agent frontmatter prevents selection" });
    } else if (selected && item.instructions) {
      addEntry(state, "prompt", { kind: "subagent-instruction", source: displayPath(state, item.file), scope: item.scope, name: item.name, content: item.instructions, matchReason: "Selected subagent instructions" });
    }
  }
}

function looksLikeMcpServerMap(value: UnknownRecord): boolean {
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, config]) => {
    if (!isRecord(config)) return false;
    return typeof config.command === "string" || Array.isArray(config.command) || typeof config.url === "string" || typeof config.type === "string" || Array.isArray(config.args);
  });
}

function mcpServerMaps(data: UnknownRecord, keys?: string[]): UnknownRecord[] {
  if (keys && keys.length) {
    let root: unknown = data;
    for (const key of keys) root = getDeep(root, [key]);
    return isRecord(root) ? [root] : [];
  }
  const maps: UnknownRecord[] = [];
  if (isRecord(data.mcpServers)) maps.push(data.mcpServers);
  if (isRecord(data.mcp_servers)) maps.push(data.mcp_servers);
  if (isRecord(data.mcp)) {
    if (isRecord(data.mcp.servers)) maps.push(data.mcp.servers);
    else if (isRecord(data.mcp.mcpServers)) maps.push(data.mcp.mcpServers);
    else if (looksLikeMcpServerMap(data.mcp)) maps.push(data.mcp);
  }
  return maps;
}

function addMcpServers(
  state: BuildState,
  sources: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number; keys?: string[] }>
): void {
  const winners = new Map<string, { source: typeof sources[number]; config: UnknownRecord }>();
  const all: Array<{ name: string; source: typeof sources[number]; config: UnknownRecord }> = [];
  for (const source of sources) {
    const seenInSource = new Set<string>();
    for (const root of mcpServerMaps(source.data, source.keys)) {
      for (const [name, config] of Object.entries(root)) {
        if (!isRecord(config) || seenInSource.has(name)) continue;
        seenInSource.add(name);
        const item = { name, source, config };
        all.push(item);
        const current = winners.get(name);
        if (!current || source.rank > current.source.rank) winners.set(name, { source, config });
      }
    }
  }
  for (const item of all) {
    const winner = winners.get(item.name)!;
    const overridden = winner.source !== item.source;
    const envConfig = isRecord(item.config.env) ? item.config.env : {};
    const env = Object.keys(envConfig);
    const enabled = item.config.enabled !== false && !overridden;
    const capability = addCapability(state, {
      kind: "mcp",
      name: item.name,
      source: displayPath(state, item.source.file),
      scope: item.source.scope,
      status: overridden ? "overridden" : enabled ? "available" : "disabled",
      reason: overridden ? "A higher-precedence MCP server uses the same name" : enabled ? "Effective MCP server configuration" : "Server is disabled",
      overriddenBy: overridden ? displayPath(state, winner.source.file) : undefined,
      details: {
        transport: typeof item.config.url === "string" ? "http" : "stdio",
        command: typeof item.config.command === "string" ? item.config.command : "",
        url: typeof item.config.url === "string" ? item.config.url : "",
        envKeys: env.map((key) => `${key}:${envConfig[key] === undefined || envConfig[key] === "" ? "unset" : "set"}`),
      },
    });
    if (overridden) {
      const winnerId = stableId("cap", `mcp:${item.name}:${winner.source.scope}:${displayPath(state, winner.source.file)}`);
      state.relationships.push({
        id: stableId("rel", `${winnerId}:${capability.id}:mcp-override`),
        type: "overrides",
        from: winnerId,
        to: capability.id,
        certainty: "certain",
        reason: "Higher-precedence MCP server configuration has the same name",
      });
    }
  }
}

function hookMatches(matcher: unknown, ctx: NormalizedContext): boolean {
  if (!ctx.hookEvent) return false;
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  const value = ctx.toolName || ctx.hookEvent;
  try { return new RegExp(matcher).test(value); } catch { return matcher === value; }
}

function addHooksFromObject(state: BuildState, data: UnknownRecord, sourceFile: string, scope: EffectiveContextScope): void {
  const hooksRoot = isRecord(data.hooks) ? data.hooks : data;
  for (const [event, groups] of Object.entries(hooksRoot)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isRecord(group)) return;
      const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
      handlers.forEach((handler, handlerIndex) => {
        if (!isRecord(handler)) return;
        const matcher = group.matcher ?? handler.matcher;
        const eventMatches = state.ctx.hookEvent === event && hookMatches(matcher, state.ctx);
        const previous = state.capabilities.findLast((item) => item.kind === "hook" && item.details?.event === event);
        const capability = addCapability(state, {
          kind: "hook",
          name: `${event}[${groupIndex}:${handlerIndex}]`,
          source: displayPath(state, sourceFile),
          scope,
          status: eventMatches ? "matched" : "available",
          reason: eventMatches ? "Hook event and matcher are satisfied" : state.ctx.hookEvent ? "Hook does not match the simulated event/tool" : "No hook event was supplied",
          details: {
            event,
            matcher: typeof matcher === "string" ? matcher : "*",
            type: typeof handler.type === "string" ? handler.type : "command",
            command: typeof handler.command === "string" ? handler.command : "",
          },
        });
        if (!eventMatches) {
          addEntry(state, "candidates", {
            kind: "hook",
            source: displayPath(state, sourceFile),
            scope,
            name: capability.name,
            content: JSON.stringify({ event, matcher: typeof matcher === "string" ? matcher : "*" }),
            matchReason: state.ctx.hookEvent ? "Hook event or tool matcher is not satisfied" : "Hook event was not supplied",
            condition: `${event}:${typeof matcher === "string" ? matcher : "*"}`,
          });
        }
        if (previous) {
          state.relationships.push({
            id: stableId("rel", `${capability.id}:${previous.id}:hook-merge`),
            type: "merges",
            from: capability.id,
            to: previous.id,
            certainty: "certain",
            reason: "Hook definitions are additive; all matching hooks run",
          });
        }
      });
    });
  }
}

function loadImports(state: BuildState, parent: EffectiveContextEntry, file: string, syntax: "claude" | "cursor" | "copilot", depth = 0): void {
  const maxDepth = syntax === "claude" ? 4 : 5;
  if (depth >= maxDepth) {
    state.diagnostics.push({ severity: "warning", code: "import-depth", message: `Import depth limit (${maxDepth}) reached`, source: displayPath(state, file) });
    return;
  }
  let fenced = false;
  const refs: Array<{ ref: string; line: number }> = [];
  parent.content.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const regex = syntax === "copilot" ? /^\s*@([^\s]+)\s*$/g : /(?:^|\s)@([^\s`]+)/g;
    for (const match of line.matchAll(regex)) refs.push({ ref: match[1].replace(/[.,;:]+$/, ""), line: index + 1 });
  });
  for (const ref of refs) {
    const expanded = ref.ref.startsWith("~/") ? path.join(state.ctx.homeDir, ref.ref.slice(2)) : ref.ref;
    const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(path.dirname(file), expanded);
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    const sourceIsGlobal = isInside(state.ctx.homeDir, file) && !isInside(state.ctx.repositoryRoot, file);
    const insideGlobalSourceRoot = sourceIsGlobal && isInside(path.dirname(file), real);
    const outside = !isInside(state.ctx.repositoryRoot, real) && !insideGlobalSourceRoot;
    if (outside && !state.ctx.allowExternalImports) {
      state.diagnostics.push({ severity: "warning", code: "external-import-blocked", message: `External import requires --allow-external-imports: ${resolved}`, source: parent.source });
      addEntry(state, "candidates", { kind: "import", source: normalizeSlashes(resolved), scope: "import", status: "excluded", content: "", line: ref.line, matchReason: "External import expansion was not authorized" });
      continue;
    }
    if (state.imported.has(real)) {
      state.diagnostics.push({ severity: "warning", code: "import-cycle", message: `Import cycle or duplicate import skipped: ${displayPath(state, resolved)}`, source: parent.source });
      continue;
    }
    const content = readText(state, resolved);
    if (content === null) {
      state.diagnostics.push({ severity: "warning", code: "import-missing", message: `Imported file does not exist: ${displayPath(state, resolved)}`, source: parent.source });
      addEntry(state, "candidates", { kind: "import", source: displayPath(state, resolved), scope: "import", status: "invalid", content: "", line: ref.line, matchReason: "Imported file is missing or unreadable" });
      continue;
    }
    state.imported.add(real);
    const imported = addFileEntry(state, "prompt", resolved, "import", "import", `Imported by ${parent.source}:${ref.line}`, { content });
    if (!imported) continue;
    state.relationships.push({ id: stableId("rel", `${parent.id}:${imported.id}:imports`), type: "imports", from: parent.id, to: imported.id, certainty: "certain", reason: `Explicit @ import on line ${ref.line}` });
    loadImports(state, imported, resolved, syntax, depth + 1);
  }
}

function addInstructionFile(state: BuildState, file: string, scope: EffectiveContextScope, reason: string, syntax?: "claude" | "cursor" | "copilot"): EffectiveContextEntry | null {
  const entry = addFileEntry(state, "prompt", file, scope, "instruction", reason);
  if (entry && syntax) {
    state.imported.add(fs.existsSync(file) ? fs.realpathSync(file) : file);
    loadImports(state, entry, file, syntax);
  }
  return entry;
}

async function buildCodex(state: BuildState): Promise<void> {
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(state.ctx.homeDir, ".codex");
  const configLayers: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord }> = [];
  const systemConfig = "/etc/codex/config.toml";
  if (fs.existsSync(systemConfig)) {
    const data = parseTomlFile(state, systemConfig);
    if (data) configLayers.push({ file: systemConfig, scope: "system", data });
  }
  const userConfig = path.join(codexHome, "config.toml");
  let userConfigData: UnknownRecord | null = null;
  if (state.ctx.includeGlobal && fs.existsSync(userConfig)) {
    const data = parseTomlFile(state, userConfig);
    if (data) {
      userConfigData = data;
      const { profiles: _profiles, ...baseData } = data;
      configLayers.push({ file: userConfig, scope: "global", data: baseData });
    }
  }
  if (state.ctx.profile) {
    const profileData = userConfigData ? getDeep(userConfigData, ["profiles", state.ctx.profile]) : undefined;
    if (isRecord(profileData)) {
      configLayers.push({ file: `${userConfig}#profiles.${state.ctx.profile}`, scope: "global", data: profileData });
    } else {
      state.diagnostics.push({ severity: "warning", code: "profile-missing", message: `Codex profile not found: ${state.ctx.profile}`, source: displayPath(state, userConfig) });
    }
  }
  for (const dir of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd)) {
    const file = path.join(dir, ".codex", "config.toml");
    if (fs.existsSync(file)) {
      const data = parseTomlFile(state, file);
      if (data) configLayers.push({ file, scope: dir === state.ctx.repositoryRoot ? "repository" : "local", data });
    }
  }
  const config = mergeConfigLayers(state, configLayers);
  const approvalPolicy = config.approval_policy;
  const sandboxMode = config.sandbox_mode;
  if (typeof approvalPolicy === "string" || typeof sandboxMode === "string") {
    addCapability(state, {
      kind: "permission",
      name: "Codex execution policy",
      source: "effective Codex configuration",
      scope: "runtime",
      status: "available",
      reason: "Effective approval and sandbox policy",
      details: {
        approvalPolicy: typeof approvalPolicy === "string" ? approvalPolicy : "default",
        sandboxMode: typeof sandboxMode === "string" ? sandboxMode : "default",
      },
    });
  }
  state.diagnostics.push({ severity: "info", code: "cloud-config-unavailable", message: "Cloud-managed Codex defaults cannot be reconstructed from local files." });

  const fallbacks = normalizePatterns(config.project_doc_fallback_filenames);
  const maxBytesValue = config.project_doc_max_bytes;
  const maxBytes = typeof maxBytesValue === "number" && maxBytesValue > 0 ? maxBytesValue : 32 * 1024;
  let usedBytes = 0;
  const files: Array<{ file: string; scope: EffectiveContextScope; reason: string }> = [];
  if (state.ctx.includeGlobal) {
    const override = path.join(codexHome, "AGENTS.override.md");
    const normal = path.join(codexHome, "AGENTS.md");
    const chosen = [override, normal].find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
    if (chosen) files.push({ file: chosen, scope: "global", reason: "First non-empty global Codex instruction file" });
    for (const file of [override, normal]) {
      if (file === chosen || !fs.existsSync(file) || fs.statSync(file).size === 0) continue;
      const entry = addFileEntry(state, "candidates", file, "global", "instruction", `Excluded because ${path.basename(chosen!)} wins global single-file selection`);
      if (entry) entry.status = "excluded";
    }
  }
  for (const dir of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd)) {
    const candidates = ["AGENTS.override.md", "AGENTS.md", ...fallbacks].map((name) => path.join(dir, name));
    const chosen = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
    if (chosen) files.push({ file: chosen, scope: dir === state.ctx.repositoryRoot ? "repository" : "local", reason: "Closest applicable instruction selected for this directory" });
    for (const file of candidates) {
      if (file === chosen || !fs.existsSync(file) || fs.statSync(file).size === 0) continue;
      const scope = dir === state.ctx.repositoryRoot ? "repository" : "local";
      const entry = addFileEntry(state, "candidates", file, scope, "instruction", `Excluded because ${path.basename(chosen!)} wins this directory's single-file selection`);
      if (entry) entry.status = "excluded";
    }
  }
  for (const item of files) {
    const content = readText(state, item.file);
    if (content === null) continue;
    const bytes = Buffer.byteLength(content, "utf8");
    if (usedBytes >= maxBytes) {
      const candidate = addFileEntry(state, "candidates", item.file, item.scope, "instruction", "Excluded after Codex project document byte limit", { content });
      if (candidate) candidate.status = "truncated";
      continue;
    }
    const available = maxBytes - usedBytes;
    if (bytes > available) {
      const truncated = truncateUtf8(content, available);
      const entry = addFileEntry(state, "prompt", item.file, item.scope, "instruction", `${item.reason}; truncated after ${usedBytes + Buffer.byteLength(truncated, "utf8")} cumulative bytes`, { content: truncated, condition: `byte range 0..${available}` });
      if (entry) entry.status = "truncated";
      usedBytes = maxBytes;
    } else {
      addFileEntry(state, "prompt", item.file, item.scope, "instruction", item.reason, { content });
      usedBytes += bytes;
    }
  }
  state.knownLimits.push({ name: "Codex project instructions", unit: "bytes", limit: maxBytes, used: usedBytes, exceeded: files.reduce((sum, item) => sum + (fs.existsSync(item.file) ? fs.statSync(item.file).size : 0), 0) > maxBytes });

  const skillItems: Array<{ file: string; scope: EffectiveContextScope; rank: number }> = [];
  for (const [index, dir] of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd).entries()) {
    skillItems.push(...discoverSkillFiles(path.join(dir, ".agents", "skills"), "*/SKILL.md").map((file) => ({ file, scope: dir === state.ctx.repositoryRoot ? "repository" as const : "local" as const, rank: 2 + index })));
  }
  if (state.ctx.includeGlobal) skillItems.push(...discoverSkillFiles(path.join(state.ctx.homeDir, ".agents", "skills"), "*/SKILL.md").map((file) => ({ file, scope: "global" as const, rank: 1 })));
  skillItems.push(...discoverSkillFiles("/etc/codex/skills", "*/SKILL.md").map((file) => ({ file, scope: "system" as const, rank: 0 })));
  addSkills(state, skillItems, { codexCatalog: true, overrideSameName: true });

  const agentFiles: Array<{ file: string; scope: EffectiveContextScope; format: "toml"; rank: number }> = [];
  if (state.ctx.includeGlobal) agentFiles.push(...discoverSkillFiles(path.join(codexHome, "agents"), "*.toml").map((file) => ({ file, scope: "global" as const, format: "toml" as const, rank: 1 })));
  agentFiles.push(...discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".codex", "agents"), "*.toml").map((file) => ({ file, scope: "repository" as const, format: "toml" as const, rank: 2 })));
  addSubagents(state, agentFiles, true);

  const hookFiles = [
    ...(state.ctx.includeGlobal ? [{ file: path.join(codexHome, "hooks.json"), scope: "global" as const }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".codex", "hooks.json"), scope: "repository" as const },
  ];
  hookFiles.forEach((item) => { if (fs.existsSync(item.file)) { const data = parseJson(state, item.file); if (data) addHooksFromObject(state, data, item.file, item.scope); } });
  configLayers.forEach((layer) => { if (isRecord(layer.data.hooks)) addHooksFromObject(state, { hooks: layer.data.hooks }, layer.file, layer.scope); });

  const mcpSources = configLayers.map((layer, index) => ({ ...layer, rank: index, keys: ["mcp_servers"] }));
  addMcpServers(state, mcpSources);
}

async function buildClaude(state: BuildState): Promise<void> {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(state.ctx.homeDir, ".claude");
  const managed = process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/CLAUDE.md"
    : process.platform === "win32" ? "C:/Program Files/ClaudeCode/CLAUDE.md" : "/etc/claude-code/CLAUDE.md";
  if (fs.existsSync(managed)) addInstructionFile(state, managed, "managed", "Managed organization instructions", "claude");
  if (state.ctx.includeGlobal) {
    const global = path.join(claudeHome, "CLAUDE.md");
    if (fs.existsSync(global)) addInstructionFile(state, global, "global", "User instructions load before project instructions", "claude");
  }
  const loaded = new Set<string>();
  for (const dir of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd)) {
    for (const rel of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
      const file = path.join(dir, rel);
      if (!fs.existsSync(file) || loaded.has(fs.realpathSync(file))) continue;
      loaded.add(fs.realpathSync(file));
      addInstructionFile(state, file, rel === "CLAUDE.local.md" ? "local" : dir === state.ctx.repositoryRoot ? "repository" : "local", "Ancestor memory file in filesystem-root to cwd order", "claude");
    }
  }
  for (const target of state.ctx.targetPaths) {
    const absolute = path.join(state.ctx.repositoryRoot, target);
    const dir = path.extname(absolute) ? path.dirname(absolute) : absolute;
    for (const current of directoryChain(state.ctx.cwd, dir).slice(1)) {
      for (const rel of ["CLAUDE.md", "CLAUDE.local.md"]) {
        const file = path.join(current, rel);
        if (!fs.existsSync(file) || loaded.has(fs.realpathSync(file))) continue;
        loaded.add(fs.realpathSync(file));
        addInstructionFile(state, file, "local", `Loaded on demand for target ${target}`, "claude");
      }
    }
  }

  const ruleRoots: Array<{ root: string; scope: EffectiveContextScope }> = [];
  if (state.ctx.includeGlobal) ruleRoots.push({ root: path.join(claudeHome, "rules"), scope: "global" });
  ruleRoots.push({ root: path.join(state.ctx.repositoryRoot, ".claude", "rules"), scope: "repository" });
  for (const root of ruleRoots) {
    for (const file of discoverSkillFiles(root.root, "**/*.md")) {
      const content = readText(state, file);
      if (content === null) continue;
      const fm = parseFrontmatter(content);
      if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, file) });
      const patterns = normalizePatterns(fm.data.paths);
      const matched = patterns.length === 0 || targetMatches(state, patterns);
      const entry = addFileEntry(state, fm.error ? "candidates" : matched ? "prompt" : "candidates", file, root.scope, "rule", fm.error ? "Invalid frontmatter prevents deterministic loading" : matched ? patterns.length ? `Target path matches ${patterns.join(", ")}` : "Rule has no paths condition" : "Path-scoped rule has no matching target", { content: fm.body, line: fm.bodyLine, condition: patterns.join(", ") });
      if (entry && fm.error) entry.status = "invalid";
      if (entry && matched && !fm.error) loadImports(state, entry, file, "claude");
    }
  }

  const settings: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord }> = [];
  const managedSettings = process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : process.platform === "win32" ? "C:/Program Files/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";
  const settingsFiles = [
    ...(state.ctx.includeGlobal ? [{ file: path.join(claudeHome, "settings.json"), scope: "global" as const }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".claude", "settings.json"), scope: "repository" as const },
    { file: path.join(state.ctx.repositoryRoot, ".claude", "settings.local.json"), scope: "local" as const },
    ...(fs.existsSync(managedSettings) ? [{ file: managedSettings, scope: "managed" as const }] : []),
  ];
  for (const item of settingsFiles) if (fs.existsSync(item.file)) { const data = parseJson(state, item.file); if (data) settings.push({ ...item, data }); }
  mergeConfigLayers(state, settings);
  settings.forEach((item) => { if (isRecord(item.data.hooks)) addHooksFromObject(state, { hooks: item.data.hooks }, item.file, item.scope); });
  settings.forEach((item) => {
    const permissions = isRecord(item.data.permissions) ? item.data.permissions : null;
    if (!permissions) return;
    const allow = Array.isArray(permissions.allow) ? permissions.allow.map(String) : [];
    const deny = Array.isArray(permissions.deny) ? permissions.deny.map(String) : [];
    addCapability(state, {
      kind: "permission",
      name: "Claude Code permissions",
      source: displayPath(state, item.file),
      scope: item.scope,
      status: "available",
      reason: "Tool permission policy discovered in settings",
      details: { allow, deny },
    });
  });

  const skills = [
    ...(state.ctx.includeGlobal ? discoverSkillFiles(path.join(claudeHome, "skills"), "*/SKILL.md").map((file) => ({ file, scope: "global" as const, rank: 1 })) : []),
    ...discoverSkillFiles(state.ctx.repositoryRoot, "**/.claude/skills/*/SKILL.md").map((file) => ({ file, scope: "repository" as const, rank: 2 })),
  ];
  addSkills(state, skills, { overrideSameName: true });
  const agents = [
    ...(state.ctx.includeGlobal ? discoverSkillFiles(path.join(claudeHome, "agents"), "*.md").map((file) => ({ file, scope: "global" as const, format: "markdown" as const, rank: 1 })) : []),
    ...discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".claude", "agents"), "*.md").map((file) => ({ file, scope: "repository" as const, format: "markdown" as const, rank: 2 })),
  ];
  addSubagents(state, agents, true);

  const mcpSources: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number; keys?: string[] }> = [];
  const homeJson = path.join(state.ctx.homeDir, ".claude.json");
  if (state.ctx.includeGlobal && fs.existsSync(homeJson)) {
    const data = parseJson(state, homeJson);
    if (data) {
      mcpSources.push({ file: homeJson, scope: "global", data, rank: 1 });
      const projectData = getDeep(data, ["projects", state.ctx.repositoryRoot]);
      if (isRecord(projectData)) mcpSources.push({ file: homeJson, scope: "local", data: projectData, rank: 3 });
    }
  }
  const projectMcp = path.join(state.ctx.repositoryRoot, ".mcp.json");
  if (fs.existsSync(projectMcp)) { const data = parseJson(state, projectMcp); if (data) mcpSources.push({ file: projectMcp, scope: "repository", data, rank: 2 }); }
  addMcpServers(state, mcpSources);
}

async function buildCursor(state: BuildState): Promise<void> {
  for (const name of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
    const file = path.join(state.ctx.repositoryRoot, name);
    if (fs.existsSync(file)) addInstructionFile(state, file, "repository", "Cursor Agent CLI root instruction", name === ".cursorrules" ? undefined : "cursor");
  }
  const ruleFiles = fg.sync("**/.cursor/rules/**/*.{md,mdc}", { cwd: state.ctx.repositoryRoot, absolute: true, dot: true, onlyFiles: true, ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"] }).sort();
  for (const file of ruleFiles) {
    const content = readText(state, file);
    if (content === null) continue;
    const fm = parseFrontmatter(content);
    const name = path.basename(file, path.extname(file));
    if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, file) });
    const patterns = normalizePatterns(fm.data.globs);
    const always = fm.data.alwaysApply === true;
    const explicit = isExplicit(name, state.ctx.rules, state.ctx.task, "@");
    const nestedRoot = path.dirname(path.dirname(path.dirname(file)));
    const nestedMatch = nestedRoot === state.ctx.repositoryRoot || state.ctx.targetPaths.some((target) => isInside(nestedRoot, path.join(state.ctx.repositoryRoot, target))) || isInside(nestedRoot, state.ctx.cwd);
    const globMatch = targetMatches(state, patterns);
    const loaded = !fm.error && nestedMatch && (always || explicit || (patterns.length > 0 && globMatch));
    const reason = fm.error ? "Invalid frontmatter prevents deterministic loading" : !nestedMatch ? "Rule is outside the target/cwd directory scope" : always ? "alwaysApply=true" : explicit ? "Rule explicitly selected" : globMatch ? `Target matches ${patterns.join(", ")}` : typeof fm.data.description === "string" ? "Agent Requested rule; semantic activation is not predicted" : "Manual rule was not selected";
    const entry = addFileEntry(state, loaded ? "prompt" : "candidates", file, nestedRoot === state.ctx.repositoryRoot ? "repository" : "local", "rule", reason, { name, content: fm.body, line: fm.bodyLine, condition: patterns.join(", ") });
    if (entry && fm.error) entry.status = "invalid";
    if (entry && loaded) loadImports(state, entry, file, "cursor");
  }
  state.diagnostics.push({ severity: "info", code: "cursor-user-rules-unavailable", message: "Cursor user rules and memories are stored by the application and have no documented portable file source; they are not guessed." });
  state.diagnostics.push({ severity: "info", code: "cursor-extension-unsupported", message: "Cursor skills, hooks, and subagent files are not simulated because the local Agent documentation does not define portable formats for them." });

  const mcpSources: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number }> = [];
  const global = path.join(state.ctx.homeDir, ".cursor", "mcp.json");
  const project = path.join(state.ctx.repositoryRoot, ".cursor", "mcp.json");
  if (state.ctx.includeGlobal && fs.existsSync(global)) { const data = parseJson(state, global); if (data) mcpSources.push({ file: global, scope: "global", data, rank: 1 }); }
  if (fs.existsSync(project)) { const data = parseJson(state, project); if (data) mcpSources.push({ file: project, scope: "repository", data, rank: 2 }); }
  addMcpServers(state, mcpSources);

  const permissionSources = [
    ...(state.ctx.includeGlobal ? [{ file: path.join(state.ctx.homeDir, ".cursor", "cli-config.json"), scope: "global" as const }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".cursor", "cli.json"), scope: "repository" as const },
  ];
  for (const item of permissionSources) {
    if (!fs.existsSync(item.file)) continue;
    const data = parseJson(state, item.file);
    const permissions = data && isRecord(data.permissions) ? data.permissions : null;
    if (!permissions) continue;
    const allow = Array.isArray(permissions.allow) ? permissions.allow.map(String) : [];
    const deny = Array.isArray(permissions.deny) ? permissions.deny.map(String) : [];
    addCapability(state, { kind: "permission", name: "Cursor CLI permissions", source: displayPath(state, item.file), scope: item.scope, status: "available", reason: "Deny rules take precedence over allow rules", details: { allow, deny } });
  }
}

async function buildCopilot(state: BuildState): Promise<void> {
  const copilotHome = process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(state.ctx.homeDir, ".copilot");
  if (state.ctx.includeGlobal) {
    const global = path.join(copilotHome, "copilot-instructions.md");
    if (fs.existsSync(global)) addInstructionFile(state, global, "global", "User-level Copilot instructions", "copilot");
    for (const file of discoverSkillFiles(path.join(copilotHome, "instructions"), "**/*.instructions.md")) {
      const content = readText(state, file);
      if (content === null) continue;
      const fm = parseFrontmatter(content);
      if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, file) });
      const patterns = normalizePatterns(fm.data.applyTo);
      const matched = patterns.length === 0 || targetMatches(state, patterns);
      const entry = addFileEntry(state, fm.error ? "candidates" : matched ? "prompt" : "candidates", file, "global", "rule", fm.error ? "Invalid frontmatter prevents deterministic loading" : matched ? "User modular instruction matches" : "applyTo has no matching target", { content: fm.body, line: fm.bodyLine, condition: patterns.join(", ") });
      if (entry && fm.error) entry.status = "invalid";
    }
  }
  const seen = new Set<string>();
  for (const dir of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd)) {
    for (const rel of ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
      const file = path.join(dir, rel);
      if (!fs.existsSync(file) || seen.has(fs.realpathSync(file))) continue;
      seen.add(fs.realpathSync(file));
      addInstructionFile(state, file, dir === state.ctx.repositoryRoot ? "repository" : "local", "Copilot standard instruction discovery path", rel === "GEMINI.md" ? undefined : "copilot");
    }
  }
  for (const file of discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".github", "instructions"), "**/*.instructions.md")) {
    const content = readText(state, file);
    if (content === null) continue;
    const fm = parseFrontmatter(content);
    if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, file) });
    const patterns = normalizePatterns(fm.data.applyTo);
    const matched = patterns.length === 0 || targetMatches(state, patterns);
    const entry = addFileEntry(state, fm.error ? "candidates" : matched ? "prompt" : "candidates", file, "repository", "rule", fm.error ? "Invalid frontmatter prevents deterministic loading" : matched ? patterns.length ? `applyTo matches ${patterns.join(", ")}` : "No applyTo condition" : "applyTo has no matching target", { content: fm.body, line: fm.bodyLine, condition: patterns.join(", ") });
    if (entry && fm.error) entry.status = "invalid";
  }
  const extraDirs = (process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS || "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const dir of extraDirs) {
    for (const file of discoverSkillFiles(path.resolve(dir), "{AGENTS.md,**/*.instructions.md}")) {
      if (!file.endsWith(".instructions.md")) {
        addInstructionFile(state, file, "global", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "copilot");
        continue;
      }
      const content = readText(state, file);
      if (content === null) continue;
      const fm = parseFrontmatter(content);
      if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, file) });
      const patterns = normalizePatterns(fm.data.applyTo);
      const matched = patterns.length === 0 || targetMatches(state, patterns);
      const entry = addFileEntry(state, fm.error ? "candidates" : matched ? "prompt" : "candidates", file, "global", "rule", fm.error ? "Invalid frontmatter prevents deterministic loading" : matched ? "Additional instruction directory rule matches" : "Additional rule applyTo has no matching target", { content: fm.body, line: fm.bodyLine, condition: patterns.join(", ") });
      if (entry && fm.error) entry.status = "invalid";
    }
  }

  const skills = [
    ...(state.ctx.includeGlobal ? discoverSkillFiles(copilotHome, "skills/*/SKILL.md").map((file) => ({ file, scope: "global" as const, rank: 1 })) : []),
    ...(state.ctx.includeGlobal ? discoverSkillFiles(path.join(state.ctx.homeDir, ".agents", "skills"), "*/SKILL.md").map((file) => ({ file, scope: "global" as const, rank: 1 })) : []),
    ...discoverSkillFiles(state.ctx.repositoryRoot, "{.github,.claude,.agents}/skills/*/SKILL.md").map((file) => ({ file, scope: "repository" as const, rank: 2 })),
  ];
  addSkills(state, skills, { overrideSameName: true });
  const agents = [
    ...(state.ctx.includeGlobal ? discoverSkillFiles(path.join(copilotHome, "agents"), "*.md").map((file) => ({ file, scope: "global" as const, format: "markdown" as const, rank: 1 })) : []),
    ...discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".github", "agents"), "*.md").map((file) => ({ file, scope: "repository" as const, format: "markdown" as const, rank: 2 })),
  ];
  addSubagents(state, agents, true);

  const hookFiles = [
    ...(state.ctx.includeGlobal ? discoverSkillFiles(path.join(copilotHome, "hooks"), "*.json").map((file) => ({ file, scope: "global" as const })) : []),
    ...discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".github", "hooks"), "*.json").map((file) => ({ file, scope: "repository" as const })),
  ];
  for (const item of hookFiles) { const data = parseJson(state, item.file); if (data) addHooksFromObject(state, data, item.file, item.scope); }
  const mcpSources: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number }> = [];
  const mcpFiles = [
    ...(state.ctx.includeGlobal ? [{ file: path.join(copilotHome, "mcp-config.json"), scope: "global" as const, rank: 1 }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".mcp.json"), scope: "repository" as const, rank: 2 },
    { file: path.join(state.ctx.repositoryRoot, ".github", "mcp.json"), scope: "repository" as const, rank: 3 },
  ];
  for (const item of mcpFiles) if (fs.existsSync(item.file)) { const data = parseJson(state, item.file); if (data) mcpSources.push({ ...item, data }); }
  addMcpServers(state, mcpSources);
  state.diagnostics.push({ severity: "info", code: "copilot-instruction-precedence", message: "Copilot CLI combines applicable instruction files and does not define a general natural-language precedence order." });
}

function addJsonMcpFiles(
  state: BuildState,
  files: Array<{ file: string; scope: EffectiveContextScope; rank: number }>
): void {
  const sources: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number }> = [];
  for (const item of files) {
    if (!fs.existsSync(item.file)) continue;
    const data = parseJson(state, item.file);
    if (data) sources.push({ ...item, data });
  }
  addMcpServers(state, sources);
}

function loadNamedInstructions(
  state: BuildState,
  names: string[],
  reason: string,
  syntax?: "claude" | "cursor" | "copilot"
): void {
  const loaded = new Set<string>();
  for (const dir of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const real = fs.realpathSync(file);
      if (loaded.has(real)) continue;
      loaded.add(real);
      addInstructionFile(state, file, dir === state.ctx.repositoryRoot ? "repository" : "local", reason, syntax);
    }
  }
}

async function buildGemini(state: BuildState): Promise<void> {
  const geminiHome = process.env.GEMINI_HOME ? path.resolve(process.env.GEMINI_HOME) : path.join(state.ctx.homeDir, ".gemini");
  if (state.ctx.includeGlobal) {
    const global = path.join(geminiHome, "GEMINI.md");
    if (fs.existsSync(global)) addInstructionFile(state, global, "global", "User-level Gemini CLI instructions", "claude");
  }
  loadNamedInstructions(state, ["GEMINI.md", "GEMINI.local.md", ".gemini/GEMINI.md"], "Ancestor Gemini memory file in filesystem-root to cwd order", "claude");
  const settings: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number }> = [];
  const settingsFiles = [
    ...(state.ctx.includeGlobal ? [{ file: path.join(geminiHome, "settings.json"), scope: "global" as const, rank: 1 }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".gemini", "settings.json"), scope: "repository" as const, rank: 2 },
    { file: path.join(state.ctx.repositoryRoot, ".gemini", "settings.local.json"), scope: "local" as const, rank: 3 },
  ];
  for (const item of settingsFiles) {
    if (!fs.existsSync(item.file)) continue;
    const data = parseJson(state, item.file);
    if (!data) continue;
    settings.push({ ...item, data });
    addCapability(state, {
      kind: "configuration",
      name: "Gemini CLI settings",
      source: displayPath(state, item.file),
      scope: item.scope,
      status: "available",
      reason: "Project or user Gemini settings file",
    });
  }
  addMcpServers(state, settings);
}

async function buildWindsurf(state: BuildState): Promise<void> {
  const rootRules = path.join(state.ctx.repositoryRoot, ".windsurfrules");
  if (fs.existsSync(rootRules)) addInstructionFile(state, rootRules, "repository", "Legacy Windsurf concatenated rules file");
  const ruleFiles = discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".windsurf", "rules"), "**/*.{md,mdc}");
  for (const file of ruleFiles) {
    const content = readText(state, file);
    if (content === null) continue;
    const fm = parseFrontmatter(content);
    if (fm.error) state.diagnostics.push({ severity: "error", code: "invalid-frontmatter", message: fm.error, source: displayPath(state, file) });
    const name = path.basename(file, path.extname(file));
    const trigger = typeof fm.data.trigger === "string" ? fm.data.trigger.toLowerCase() : "";
    const patterns = normalizePatterns(fm.data.globs ?? fm.data.paths);
    const always = trigger === "always" || fm.data.alwaysApply === true;
    const explicit = isExplicit(name, state.ctx.rules, state.ctx.task, "@");
    const globMatch = patterns.length > 0 && targetMatches(state, patterns);
    const loaded = !fm.error && (always || explicit || globMatch || (trigger === "" && patterns.length === 0));
    const reason = fm.error
      ? "Invalid frontmatter prevents deterministic loading"
      : always
        ? "Windsurf trigger=always"
        : explicit
          ? "Rule explicitly selected"
          : globMatch
            ? `Target matches ${patterns.join(", ")}`
            : trigger === "manual" || trigger === "model_decision" || trigger === "auto"
              ? "Activation depends on Cascade/model decision and is not predicted"
              : "No glob match and rule was not selected";
    const entry = addFileEntry(state, loaded ? "prompt" : "candidates", file, "repository", "rule", reason, { name, content: fm.body, line: fm.bodyLine, condition: patterns.join(", ") });
    if (entry && fm.error) entry.status = "invalid";
  }
  addJsonMcpFiles(state, [
    ...(state.ctx.includeGlobal ? [{ file: path.join(state.ctx.homeDir, ".codeium", "windsurf", "mcp_config.json"), scope: "global" as const, rank: 1 }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".windsurf", "mcp.json"), scope: "repository" as const, rank: 2 },
    { file: path.join(state.ctx.repositoryRoot, ".windsurf", "mcp_config.json"), scope: "repository" as const, rank: 3 },
  ]);
}

async function buildCline(state: BuildState): Promise<void> {
  const loaded = new Set<string>();
  for (const dir of directoryChain(state.ctx.repositoryRoot, state.ctx.cwd)) {
    const file = path.join(dir, ".clinerules");
    const scope: EffectiveContextScope = dir === state.ctx.repositoryRoot ? "repository" : "local";
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const real = fs.realpathSync(file);
      if (!loaded.has(real)) {
        loaded.add(real);
        addInstructionFile(state, file, scope, "Cline rules file on the cwd directory chain");
      }
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      for (const child of discoverSkillFiles(file, "**/*.{md,mdc}")) {
        const real = fs.realpathSync(child);
        if (loaded.has(real)) continue;
        loaded.add(real);
        addInstructionFile(state, child, scope, "Cline rules directory on the cwd directory chain");
      }
    }
  }
  addJsonMcpFiles(state, [
    { file: path.join(state.ctx.repositoryRoot, ".cline", "mcp.json"), scope: "repository" as const, rank: 1 },
    { file: path.join(state.ctx.repositoryRoot, ".cline", "mcp_settings.json"), scope: "repository" as const, rank: 2 },
    { file: path.join(state.ctx.repositoryRoot, ".mcp.json"), scope: "repository" as const, rank: 3 },
  ]);
}

function aiderReadList(data: UnknownRecord): string[] {
  const raw = data.read ?? data["read:"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return [];
}

async function buildAider(state: BuildState): Promise<void> {
  loadNamedInstructions(state, ["CONVENTIONS.md"], "Aider default conventions file");
  const configFiles = [
    ...(state.ctx.includeGlobal ? [{ file: path.join(state.ctx.homeDir, ".aider.conf.yml"), scope: "global" as const }] : []),
    { file: path.join(state.ctx.repositoryRoot, ".aider.conf.yml"), scope: "repository" as const },
    { file: path.join(state.ctx.repositoryRoot, ".aider.conf.yaml"), scope: "repository" as const },
    { file: path.join(state.ctx.repositoryRoot, ".aider.conf.json"), scope: "repository" as const },
  ];
  for (const item of configFiles) {
    if (!fs.existsSync(item.file)) continue;
    const data = item.file.endsWith(".json") ? parseJson(state, item.file) : parseYamlFile(state, item.file);
    if (!data) continue;
    addCapability(state, {
      kind: "configuration",
      name: "Aider configuration",
      source: displayPath(state, item.file),
      scope: item.scope,
      status: "available",
      reason: "Aider config discovered",
    });
    for (const rel of aiderReadList(data)) {
      const absolute = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(state.ctx.repositoryRoot, rel);
      if (!isInside(state.ctx.repositoryRoot, absolute) && !(state.ctx.includeGlobal && isInside(state.ctx.homeDir, absolute))) {
        state.diagnostics.push({ severity: "warning", code: "external-import-blocked", message: `Aider read file is outside the repository: ${rel}`, source: displayPath(state, item.file) });
        continue;
      }
      if (fs.existsSync(absolute)) addInstructionFile(state, absolute, item.scope, `Listed in ${path.basename(item.file)} read:`);
    }
  }
}

async function buildOpenCode(state: BuildState): Promise<void> {
  loadNamedInstructions(state, ["AGENTS.md"], "OpenCode AGENTS.md discovery path");
  const configFiles = [
    { file: path.join(state.ctx.repositoryRoot, "opencode.json"), scope: "repository" as const, rank: 2 },
    { file: path.join(state.ctx.repositoryRoot, "opencode.jsonc"), scope: "repository" as const, rank: 3 },
    { file: path.join(state.ctx.repositoryRoot, ".opencode", "opencode.json"), scope: "repository" as const, rank: 4 },
    { file: path.join(state.ctx.repositoryRoot, ".opencode", "opencode.jsonc"), scope: "repository" as const, rank: 5 },
  ];
  const mcpSources: Array<{ file: string; scope: EffectiveContextScope; data: UnknownRecord; rank: number }> = [];
  for (const item of configFiles) {
    if (!fs.existsSync(item.file)) continue;
    const data = parseJson(state, item.file);
    if (!data) continue;
    mcpSources.push({ ...item, data });
    addCapability(state, {
      kind: "configuration",
      name: "OpenCode config",
      source: displayPath(state, item.file),
      scope: item.scope,
      status: "available",
      reason: "OpenCode project configuration",
    });
    const instructions = data.instructions;
    const listed = typeof instructions === "string" ? [instructions] : Array.isArray(instructions) ? instructions.filter((value): value is string => typeof value === "string") : [];
    for (const rel of listed) {
      const absolute = path.resolve(state.ctx.repositoryRoot, rel);
      if (!isInside(state.ctx.repositoryRoot, absolute)) continue;
      if (fs.existsSync(absolute)) addInstructionFile(state, absolute, "repository", "OpenCode config instructions path");
    }
  }
  addMcpServers(state, mcpSources);
  addJsonMcpFiles(state, [{ file: path.join(state.ctx.repositoryRoot, ".mcp.json"), scope: "repository", rank: 1 }]);
  const agents = discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".opencode", "agents"), "*.md").map((file) => ({ file, scope: "repository" as const, format: "markdown" as const, rank: 2 }));
  addSubagents(state, agents, true);
  addSkills(state, discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".opencode", "skills"), "*/SKILL.md").map((file) => ({ file, scope: "repository" as const, rank: 2 })), { overrideSameName: true });
}

async function buildRoo(state: BuildState): Promise<void> {
  const rootRules = path.join(state.ctx.repositoryRoot, ".roorules");
  if (fs.existsSync(rootRules) && fs.statSync(rootRules).isFile()) addInstructionFile(state, rootRules, "repository", "Legacy Roo rules file");
  for (const file of discoverSkillFiles(path.join(state.ctx.repositoryRoot, ".roo", "rules"), "**/*.{md,mdc}")) {
    addInstructionFile(state, file, "repository", "Roo mode-independent rules");
  }
  const modeDirs = fg.sync(".roo/rules-*", { cwd: state.ctx.repositoryRoot, dot: true, onlyDirectories: true, ignore: ["**/node_modules/**", "**/.git/**"] }).sort();
  for (const dir of modeDirs) {
    const mode = path.basename(dir).slice("rules-".length);
    const selected = state.ctx.subagent?.toLowerCase() === mode.toLowerCase();
    for (const file of discoverSkillFiles(path.join(state.ctx.repositoryRoot, dir), "**/*.{md,mdc}")) {
      addFileEntry(state, selected ? "prompt" : "candidates", file, "repository", "rule", selected ? `Roo mode "${mode}" is selected` : `Roo mode "${mode}" rules load only when that mode is active`, { name: mode });
    }
  }
  addJsonMcpFiles(state, [
    { file: path.join(state.ctx.repositoryRoot, ".roo", "mcp.json"), scope: "repository" as const, rank: 1 },
    { file: path.join(state.ctx.repositoryRoot, ".mcp.json"), scope: "repository" as const, rank: 2 },
  ]);
}

function normalizedBlock(text: string): string {
  return text.toLowerCase().replace(/[`*_#>]/g, "").replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s./:_-]/gu, "").trim();
}

function similarity(a: string, b: string): number {
  const left = new Set(a.split(/\s+/).filter(Boolean));
  const right = new Set(b.split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection++;
  return intersection / new Set([...left, ...right]).size;
}

function structuredFact(text: string): { key: string; value: string } | null {
  const node = text.match(/\bnode(?:\.js|js)?(?:\s+(?:version|is|>=|v))?\s*[:=]?\s*v?(\d+(?:\.\d+)*)/i);
  if (node) return { key: "runtime.node", value: node[1] };
  const manager = text.match(/\b(?:use|prefer|only|package manager(?:\s+is)?[:=]?)\s+(npm|pnpm|yarn|bun)\b/i);
  if (manager) return { key: "package-manager", value: manager[1].toLowerCase() };
  const command = text.match(/\b(test|lint|typecheck|type-check|build)(?:\s+command)?\s*(?:is|:|=)\s*[`'"]?([^`'"\n.]+)/i);
  if (command) return { key: `command.${command[1].replace("-", "")}`, value: command[2].trim().toLowerCase() };
  return null;
}

function buildInstructionRelationships(state: BuildState): void {
  const entries = state.prompt.filter((entry) => entry.status === "loaded" || entry.status === "truncated");
  const blocks = entries.flatMap((entry) => entry.blocks.map((block) => ({ entry, block, normalized: normalizedBlock(block.content), fact: structuredFact(block.content) })));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const left = blocks[i];
      const right = blocks[j];
      if (left.entry.id === right.entry.id || !left.normalized || !right.normalized) continue;
      const exact = left.normalized === right.normalized;
      const near = !exact && Math.min(left.normalized.length, right.normalized.length) > 20 && similarity(left.normalized, right.normalized) >= 0.85;
      if (exact || near) {
        state.relationships.push({ id: stableId("rel", `${right.block.id}:${left.block.id}:duplicate`), type: "duplicates", from: right.block.id, to: left.block.id, certainty: exact ? "certain" : "conservative", reason: exact ? "Normalized instruction text is identical" : "Instruction blocks have at least 85% token-set similarity" });
        continue;
      }
      if (left.fact && right.fact && left.fact.key === right.fact.key && left.fact.value !== right.fact.value) {
        const codexOverride = state.ctx.agent === "codex";
        state.relationships.push({
          id: stableId("rel", `${right.block.id}:${left.block.id}:conflict`),
          type: codexOverride ? "overrides" : "merged-unresolved",
          from: right.block.id,
          to: left.block.id,
          certainty: "conservative",
          reason: codexOverride
            ? `Later Codex instruction changes ${left.fact.key} from ${left.fact.value} to ${right.fact.value}`
            : `Conflicting ${left.fact.key} values (${left.fact.value} vs ${right.fact.value}); this profile does not define a winner`,
        });
      }
    }
  }
}

function calculateBudget(state: BuildState): EffectiveContextBudget {
  const loaded = state.prompt.filter((entry) => entry.status === "loaded" || entry.status === "truncated");
  const promptTokens = loaded.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
  const candidateTokens = state.candidates.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
  const promptBytes = loaded.reduce((sum, entry) => sum + entry.rawBytes, 0);
  const byScope: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  loaded.forEach((entry) => {
    byScope[entry.scope] = (byScope[entry.scope] || 0) + entry.estimatedTokens;
    byKind[entry.kind] = (byKind[entry.kind] || 0) + entry.estimatedTokens;
  });
  const window = state.ctx.contextWindowTokens;
  return {
    unit: "estimated_tokens",
    promptTokens,
    candidateTokens,
    promptBytes,
    byScope,
    byKind,
    contextWindowTokens: window,
    remainingTokens: window === null ? null : Math.max(0, window - promptTokens),
    usagePercent: window === null ? null : Number(((promptTokens / window) * 100).toFixed(2)),
    knownLimits: state.knownLimits,
  };
}

function normalizeQuery(query: EffectiveContextQuery): NormalizedContext {
  if (!isAgentProfileId(query.agent)) throw new Error(`Unsupported agent profile: ${String(query.agent)}. Expected one of: ${AGENT_PROFILE_IDS.join(", ")}`);
  const requestedCwd = path.resolve(query.cwd || process.cwd());
  if (!fs.existsSync(requestedCwd) || !fs.statSync(requestedCwd).isDirectory()) throw new Error(`Working directory does not exist: ${requestedCwd}`);
  const cwd = fs.realpathSync(requestedCwd);
  const gitRoot = getGitRoot(cwd);
  const repositoryRoot = gitRoot === cwd ? nearestProjectRoot(cwd) : gitRoot;
  const diagnosticsTargets: string[] = [];
  for (const target of query.targetPaths || []) {
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(repositoryRoot, target);
    if (!isInside(repositoryRoot, absolute)) throw new Error(`Target path must be inside the repository: ${target}`);
    diagnosticsTargets.push(normalizeSlashes(path.relative(repositoryRoot, absolute) || "."));
  }
  const contextWindow = query.contextWindowTokens;
  if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) throw new Error("contextWindowTokens must be a positive number");
  return {
    agent: query.agent,
    cwd,
    repositoryRoot,
    targetPaths: [...new Set(diagnosticsTargets)],
    task: query.task || "",
    rules: [...new Set(query.rules || [])],
    skills: [...new Set(query.skills || [])],
    subagent: query.subagent || null,
    hookEvent: query.hookEvent || null,
    toolName: query.toolName || null,
    profile: query.profile || null,
    includeGlobal: query.includeGlobal !== false,
    allowExternalImports: query.allowExternalImports === true,
    contextWindowTokens: contextWindow ? Math.floor(contextWindow) : null,
    homeDir: os.homedir(),
  };
}

export async function simulateEffectiveContext(query: EffectiveContextQuery): Promise<EffectiveContextReport> {
  const ctx = normalizeQuery(query);
  const state: BuildState = { ctx, prompt: [], candidates: [], capabilities: [], relationships: [], diagnostics: [], knownLimits: [], order: 0, imported: new Set() };
  ctx.targetPaths.forEach((target) => {
    if (!fs.existsSync(path.join(ctx.repositoryRoot, target))) state.diagnostics.push({ severity: "info", code: "target-missing", message: `Target does not exist yet; glob matching still uses its path: ${target}` });
  });

  if (ctx.agent === "codex") await buildCodex(state);
  else if (ctx.agent === "claude") await buildClaude(state);
  else if (ctx.agent === "cursor") await buildCursor(state);
  else if (ctx.agent === "copilot") await buildCopilot(state);
  else if (ctx.agent === "gemini") await buildGemini(state);
  else if (ctx.agent === "windsurf") await buildWindsurf(state);
  else if (ctx.agent === "cline") await buildCline(state);
  else if (ctx.agent === "aider") await buildAider(state);
  else if (ctx.agent === "opencode") await buildOpenCode(state);
  else await buildRoo(state);

  buildInstructionRelationships(state);
  state.prompt.sort((a, b) => a.order - b.order);
  state.candidates.sort((a, b) => a.order - b.order);
  state.capabilities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  const finalInstructions = state.prompt
    .filter((entry) => entry.status === "loaded" || entry.status === "truncated")
    .map((entry) => `<!-- ${entry.source} · ${entry.matchReason} -->\n${entry.content}`)
    .join("\n\n");

  return {
    schemaVersion: 1,
    profile: { id: ctx.agent, ...AGENT_PROFILE_META[ctx.agent], deterministic: true },
    query: {
      agent: ctx.agent,
      cwd: ctx.cwd,
      repositoryRoot: ctx.repositoryRoot,
      targetPaths: ctx.targetPaths,
      task: ctx.task,
      rules: ctx.rules,
      skills: ctx.skills,
      subagent: ctx.subagent,
      hookEvent: ctx.hookEvent,
      toolName: ctx.toolName,
      profile: ctx.profile,
      includeGlobal: ctx.includeGlobal,
      allowExternalImports: ctx.allowExternalImports,
      contextWindowTokens: ctx.contextWindowTokens,
    },
    prompt: state.prompt,
    candidates: state.candidates,
    capabilities: state.capabilities,
    relationships: state.relationships,
    finalInstructions,
    budget: calculateBudget(state),
    diagnostics: state.diagnostics,
  };
}
