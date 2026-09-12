import { SessionMetrics, SessionTimelineEvent } from "../../core/types.js";
import { deriveSessionRepeats } from "./sessionBuilder.js";

export interface RedactResult {
  text: string;
  redactedCount: number;
}

interface RedactPattern {
  type: string;
  regex: RegExp;
}

// Order matters: private key blocks first, then key=value assignments (so one
// secret is counted once), then standalone prefixed tokens.
const PATTERNS: RedactPattern[] = [
  { type: "PRIVATE_KEY", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    type: "ASSIGNMENT",
    // api_key=..., password: "...", secret='...' — keep the key name, redact the value.
    regex: /((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|token|secret|passwd|password|private[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)([^"'\s,;}]{4,})(["']?)/gi,
  },
  {
    type: "CLI_SECRET",
    regex: /((?:--?|\/)(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|token|secret|passwd|password)\s+)([^"'\s,;}]{4,})/gi,
  },
  { type: "OPENAI_KEY", regex: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { type: "GITHUB_TOKEN", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g },
  { type: "SLACK_TOKEN", regex: /\bxox[bpas]-[A-Za-z0-9-]{6,}\b/g },
  { type: "AWS_KEY", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GOOGLE_KEY", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: "NPM_TOKEN", regex: /\bnpm_[A-Za-z0-9]{10,}\b/g },
  { type: "JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "BEARER", regex: /\b(Bearer\s+)[A-Za-z0-9\-._~+/=]{8,}/g },
];

export function redactText(input: string): RedactResult {
  if (!input) return { text: input, redactedCount: 0 };
  let text = input;
  let redactedCount = 0;
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    if (p.type === "BEARER") {
      text = text.replace(p.regex, (_m, prefix: string) => {
        redactedCount++;
        return `${prefix}[REDACTED:BEARER]`;
      });
    } else if (p.type === "ASSIGNMENT") {
      text = text.replace(p.regex, (_m, pre: string, _val: string, post: string) => {
        redactedCount++;
        return `${pre}[REDACTED:${p.type}]${post}`;
      });
    } else if (p.type === "CLI_SECRET") {
      text = text.replace(p.regex, (_m, pre: string) => {
        redactedCount++;
        return `${pre}[REDACTED:${p.type}]`;
      });
    } else {
      text = text.replace(p.regex, () => {
        redactedCount++;
        return `[REDACTED:${p.type}]`;
      });
    }
  }
  return { text, redactedCount };
}

const SENSITIVE_FIELD = /(?:api[_-]?key|auth(?:entication)?[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|tokens?|password|passwd|secret|private[_-]?key|client[_-]?secret|authorization|cookie|credential)/i;

/**
 * Redact arbitrary JSON-compatible data before it is persisted by the OTLP
 * receiver. Field-name checks cover short secrets that cannot be identified by
 * a token prefix; text checks cover secrets embedded in commands and errors.
 */
export function redactStructured(value: unknown, keyHint?: string): { value: unknown; redactedCount: number } {
  if (typeof value === "string") {
    if (keyHint && SENSITIVE_FIELD.test(keyHint) && value.length > 0) {
      return { value: "[REDACTED:FIELD]", redactedCount: 1 };
    }
    const r = redactText(value);
    return { value: r.text, redactedCount: r.redactedCount };
  }
  if (Array.isArray(value)) {
    let redactedCount = 0;
    const next = value.map((item) => {
      const r = redactStructured(item, keyHint);
      redactedCount += r.redactedCount;
      return r.value;
    });
    return { value: next, redactedCount };
  }
  if (value && typeof value === "object") {
    let redactedCount = 0;
    const next: Record<string, unknown> = {};
    const objectRecord = value as Record<string, unknown>;
    const semanticKey = typeof objectRecord.key === "string" ? objectRecord.key : undefined;
    for (const [key, child] of Object.entries(value)) {
      // OTLP attributes are represented as {key: "api_key", value: ...};
      // pass the semantic attribute key down to the value so short secrets
      // are redacted even when they have no recognizable prefix.
      const hint = key === "value" && semanticKey
        ? semanticKey
        : keyHint && SENSITIVE_FIELD.test(keyHint)
          ? keyHint
          : key;
      const r = redactStructured(child, hint);
      redactedCount += r.redactedCount;
      next[key] = r.value;
    }
    return { value: next, redactedCount };
  }
  return { value, redactedCount: 0 };
}

function redactString(value: string | undefined): { value: string | undefined; count: number } {
  if (value === undefined) return { value, count: 0 };
  const r = redactText(value);
  return { value: r.text, count: r.redactedCount };
}

function redactStringArray(values: string[]): { values: string[]; count: number } {
  let count = 0;
  const next = values.map((value) => {
    const r = redactText(value);
    count += r.redactedCount;
    return r.text;
  });
  return { values: next, count };
}

function redactEvent(ev: SessionTimelineEvent): { event: SessionTimelineEvent; count: number } {
  let count = 0;
  let action = ev.action;
  let tool = ev.tool;
  let detail = ev.detail;
  const ra = redactText(action);
  action = ra.text;
  count += ra.redactedCount;
  if (detail) {
    const rd = redactText(detail);
    detail = rd.text;
    count += rd.redactedCount;
  }
  if (tool) {
    const rt = redactText(tool);
    tool = rt.text;
    count += rt.redactedCount;
  }
  return { event: { ...ev, action, tool, detail }, count };
}

/**
 * Redact a normalized session in place (returns same object).
 * Covers timeline actions/details, search queries, failure reasons and file-ish strings.
 * Counts every replacement in `redactedFields`.
 */
export function redactSession(session: SessionMetrics): SessionMetrics {
  let total = session.redactedFields || 0;

  for (const key of ["id", "nativeId", "model", "sessionCwd", "gitBranch", "gitCommit", "prState"] as const) {
    const r = redactString(session[key]);
    session[key] = r.value as never;
    total += r.count;
  }

  session.timeline = session.timeline.map((t) => {
    const { event, count } = redactEvent(t);
    total += count;
    return event;
  });

  const searches = redactStringArray(session.searchOperations || []);
  session.searchOperations = searches.values;
  total += searches.count;

  const filesRead = redactStringArray(session.filesRead || []);
  session.filesRead = filesRead.values;
  total += filesRead.count;

  const filesEdited = redactStringArray(session.filesEdited || []);
  session.filesEdited = filesEdited.values;
  total += filesEdited.count;

  if (session.failureReasons) {
    session.failureReasons = session.failureReasons.map((f) => {
      const ra = redactText(f.action);
      const rr = redactText(f.reason);
      total += ra.redactedCount + rr.redactedCount;
      return { action: ra.text, reason: rr.text };
    });
  }

  if (session.taskTitle) {
    const r = redactText(session.taskTitle);
    session.taskTitle = r.text;
    total += r.redactedCount;
  }
  if (session.gitMessage) {
    const r = redactText(session.gitMessage);
    session.gitMessage = r.text;
    total += r.redactedCount;
  }
  if (session.prTitle) {
    const r = redactText(session.prTitle);
    session.prTitle = r.text;
    total += r.redactedCount;
  }

  // Repeats are derived fields. Recompute them from the sanitized source
  // arrays so findings cannot re-introduce the original secret.
  const repeats = deriveSessionRepeats(session.filesRead, session.searchOperations, session.timeline);
  session.repeatedReads = repeats.repeatedReads;
  session.repeatedSearches = repeats.repeatedSearches;
  session.repeatedFailures = repeats.repeatedFailures;

  session.redactedFields = total;
  return session;
}
