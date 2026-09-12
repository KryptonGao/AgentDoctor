import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import fg from "fast-glob";
import { RawSessionRef } from "./sessionTypes.js";

export const REPO_SESSION_GLOBS = [
  ".agent/sessions/**/*.{json,jsonl}",
  ".claude/sessions/**/*.{json,jsonl}",
  ".sessions/**/*.{json,jsonl}",
  "sessions/**/*.{json,jsonl}",
  ".agent/otel-traces.jsonl",
  ".cursor/agent-transcripts/**/*.{json,jsonl}",
  ".cursor/sessions/**/*.{json,jsonl}",
  // Back-compat: top-level single globs are covered by ** above.
];

const MAX_GLOBAL_BYTES_SNIFF = 4096;
const MAX_GLOBAL_FILES_SCANNED = 120;

function statRef(agent: RawSessionRef["agent"], p: string): RawSessionRef | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return { agent, sourcePath: p, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

function readHead(p: string): string {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(MAX_GLOBAL_BYTES_SNIFF);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function encodeClaudeProjectDir(repoRoot: string): string {
  // Claude Code: "/" -> "-", e.g. /Users/x/proj -> -Users-x-proj
  return repoRoot.replace(/\//g, "-");
}

/** Gemini CLI uses sha256(projectRoot) as the ~/.gemini/tmp directory name. */
export function encodeGeminiProjectHash(repoRoot: string): string {
  return createHash("sha256").update(path.resolve(repoRoot)).digest("hex");
}

/** Cursor project directories omit the leading slash and replace separators. */
export function encodeCursorProjectDir(repoRoot: string): string {
  return path.resolve(repoRoot).replace(/^[/\\]+/, "").replace(/[\\/]/g, "-");
}

function matchCodexCwd(head: string, repoRoot: string): boolean {
  // session_meta line carries "cwd":"<abs path>"
  return head.includes(`"cwd":"${repoRoot}"`) || head.includes(`"cwd": "${repoRoot}"`);
}

// Global same-repo discovery (opt-out via includeGlobal=false or AGENTDOCTOR_INCLUDE_GLOBAL=0).
// - Codex: ~/.codex/sessions JSONL files, sniff session_meta cwd == repoRoot
// - Claude: ~/.claude/projects/<encoded repoRoot> JSONL files (same-repo by construction)
// - Gemini: ~/.gemini/tmp/<sha256(repoRoot)>/chats JSON/JSONL files
// - Cursor: ~/.cursor/projects/<encoded-cwd>/agent-transcripts JSONL files
// Results sorted mtime desc, capped by maxGlobalSessions.
export async function detectGlobalSessions(
  repoRoot: string,
  maxGlobalSessions = 20
): Promise<RawSessionRef[]> {
  const home = os.homedir();
  const found: RawSessionRef[] = [];
  const push = (r: RawSessionRef | null) => {
    if (r) found.push(r);
  };

  // Claude: direct dir match, no sniffing needed
  try {
    const dir = path.join(home, ".claude", "projects", encodeClaudeProjectDir(repoRoot));
    if (fs.existsSync(dir)) {
      const files = await fg(["*.jsonl"], { cwd: dir, onlyFiles: true, absolute: true });
      for (const f of files) push(statRef("claude", f));
    }
  } catch {
    // ignore
  }

  // Codex: scan recent rollout files, keep cwd matches
  try {
    const codexDir = path.join(home, ".codex", "sessions");
    if (fs.existsSync(codexDir)) {
      const files = await fg(["**/*.jsonl"], {
        cwd: codexDir,
        onlyFiles: true,
        absolute: true,
        stats: true,
      } as any);
      const sorted = (files as unknown as { path: string; stats: { mtimeMs: number } }[])
        .map((e) => (typeof e === "string" ? { path: e, stats: undefined } : e))
        .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
        .slice(0, MAX_GLOBAL_FILES_SCANNED);
      for (const e of sorted) {
        const p = (e as any).path ?? (e as unknown as string);
        if (matchCodexCwd(readHead(p), repoRoot)) push(statRef("codex", p));
        if (found.filter((f) => f.agent === "codex").length >= maxGlobalSessions) break;
      }
    }
  } catch {
    // ignore
  }

  // Cursor: transcript files are grouped by an encoded project cwd. Current
  // Cursor releases write JSONL under agent-transcripts/<session>/<file>.jsonl.
  try {
    const cursorProjects = path.join(home, ".cursor", "projects");
    const encoded = encodeCursorProjectDir(repoRoot);
    const candidates = [...new Set([encoded, `-${encoded}`])];
    for (const projectDir of candidates) {
      const dir = path.join(cursorProjects, projectDir);
      if (!fs.existsSync(dir)) continue;
      const files = await fg(["agent-transcripts/**/*.{json,jsonl}"], {
        cwd: dir,
        onlyFiles: true,
        absolute: true,
        stats: true,
      } as any);
      for (const e of files as unknown as ({ path: string; stats?: { mtimeMs: number } } | string)[]) {
        const p = typeof e === "string" ? e : e.path;
        push(statRef("cursor", p));
      }
    }
  } catch {
    // ignore
  }

  // Gemini: direct project-hash lookup first, then a bounded metadata sniff for
  // older layouts. Current JSONL metadata carries projectHash, not the path.
  try {
    const configuredGeminiHome = process.env.GEMINI_CLI_HOME;
    const geminiTmpDirs = configuredGeminiHome
      ? [path.join(configuredGeminiHome, "tmp"), path.join(configuredGeminiHome, ".gemini", "tmp")]
      : [path.join(home, ".gemini", "tmp")];
    for (const geminiTmp of [...new Set(geminiTmpDirs)]) {
      if (!fs.existsSync(geminiTmp)) continue;
      const projectHash = encodeGeminiProjectHash(repoRoot);
      const directDir = path.join(geminiTmp, projectHash, "chats");
      let files: unknown[] = [];
      if (fs.existsSync(directDir)) {
        files = await fg(["*.{json,jsonl}"], {
          cwd: directDir,
          onlyFiles: true,
          absolute: true,
          stats: true,
        } as any);
      }
      if (files.length === 0) {
        files = await fg(["*/chats/*.{json,jsonl}"], {
          cwd: geminiTmp,
          onlyFiles: true,
          absolute: true,
          stats: true,
        } as any);
      }
      const sorted = (files as unknown as { path: string; stats: { mtimeMs: number } }[])
        .map((e) => (typeof e === "string" ? { path: e, stats: undefined } : e))
        .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
        .slice(0, MAX_GLOBAL_FILES_SCANNED);
      for (const e of sorted) {
        const p = (e as any).path ?? (e as unknown as string);
        const head = readHead(p);
        if (p.startsWith(`${directDir}${path.sep}`) || head.includes(`"projectHash":"${projectHash}"`) || head.includes(`"projectHash": "${projectHash}"`)) {
          push(statRef("gemini", p));
        }
        if (found.filter((f) => f.agent === "gemini").length >= maxGlobalSessions) break;
      }
    }
  } catch {
    // ignore
  }

  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, maxGlobalSessions);
}

export async function detectRepoSessions(repoRoot: string): Promise<RawSessionRef[]> {
  const out: RawSessionRef[] = [];
  try {
    const files = await fg(REPO_SESSION_GLOBS, { cwd: repoRoot, dot: true, onlyFiles: true, absolute: true });
    for (const f of files.sort()) {
      const normalized = f.replaceAll(path.sep, "/");
      const agent: RawSessionRef["agent"] = normalized.includes("/.cursor/") || normalized.includes("/agent-transcripts/")
        ? "cursor"
        : normalized.includes("/otel-traces")
          ? "otel"
          : f.endsWith(".jsonl")
            ? "claude"
            : "agentdoctor";
      const ref = statRef(agent, f);
      if (ref) out.push(ref);
    }
  } catch {
    // ignore
  }
  return out;
}

export function shouldIncludeGlobal(includeGlobal?: boolean): boolean {
  if (includeGlobal !== undefined) return includeGlobal;
  return process.env.AGENTDOCTOR_INCLUDE_GLOBAL !== "0";
}
