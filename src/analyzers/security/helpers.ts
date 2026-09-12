import { Finding, FindingSeverity } from "../../core/types.js";
import { redactText } from "../runtime/redact.js";
import { SecurityFile } from "./files.js";

export function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

export function lineAt(content: string, index: number): { line: number; text: string; start: number } {
  const line = lineNumberAt(content, index);
  const lines = content.split(/\r?\n/);
  const text = lines[line - 1] ?? "";
  const start = content.slice(0, index).split(/\r?\n/).slice(0, -1).join("\n").length;
  return { line, text, start: start === 0 ? 0 : start + 1 };
}

export function snippetFor(text: string, max = 160): string {
  const redacted = redactText(text).text.replace(/\s+/g, " ").trim();
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max - 1)}…`;
}

const NEGATION = /\b(?:never|do not|don't|dont|avoid|must not|shall not|禁止|不要|切勿|严禁|不得)\b/i;

export function isNegatedLine(line: string): boolean {
  return NEGATION.test(line);
}

export function isPlaceholderSecret(value: string): boolean {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed.length < 4) return true;
  if (/^(?:xxx+|placeholder|changeme|redacted|null|none|todo|fixme|example|sample|dummy)$/i.test(trimmed)) {
    return true;
  }
  if (/^\$\{?[\w.-]+\}?$/.test(trimmed)) return true;
  if (/^<[\w.-]+>$/.test(trimmed)) return true;
  if (/^\$\{\{\s*secrets\./i.test(trimmed)) return true;
  if (/^(?:your|my|insert|replace)[-_ ].+/i.test(trimmed)) return true;
  if (/^your[_-]/i.test(trimmed)) return true;
  if (/[_-]here$/i.test(trimmed)) return true;
  return false;
}

export function createFinding(options: {
  file: SecurityFile;
  ruleId: string;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  description: string;
  recommendation: string;
  line?: number;
  snippet: string;
  idSuffix?: string;
}): Finding {
  const suffix = options.idSuffix || `${options.file.relativePath}-${options.line ?? "file"}`;
  const id = `security-${options.ruleId.split("/")[1]}-${suffix}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return {
    id,
    ruleId: options.ruleId,
    category: "security",
    severity: options.severity,
    confidence: options.confidence,
    needsReview: options.confidence < 0.8,
    title: options.title,
    description: options.description,
    evidence: [
      {
        file: options.file.relativePath,
        line: options.line,
        snippet: snippetFor(options.snippet),
        source: options.file.relativePath,
      },
    ],
    recommendation: options.recommendation,
    groupKey: options.ruleId,
  };
}

export function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return parseJsoncRecord(content);
  }
}

export function parseJsoncRecord(content: string): Record<string, unknown> | null {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  try {
    const value = JSON.parse(stripped) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
