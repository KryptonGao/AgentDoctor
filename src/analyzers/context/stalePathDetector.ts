import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Finding, Fix, Evidence } from "../../core/types.js";
import { ContextFile } from "./duplicateDetector.js";
import { estimateTokens } from "./tokenCounter.js";
import { createFix } from "../../core/fix/fixEngine.js";

export type PathClassification =
  | "glob"
  | "template"
  | "runtime_route"
  | "url"
  | "doc_or_concept"
  | "literal_repo_path"
  | "unknown";

const KNOWN_FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyi",
  "rs",
  "go",
  "json", "yaml", "yml", "toml", "ini", "cfg",
  "md", "mdx", "txt", "rst",
  "sh", "bash", "zsh",
  "html", "css", "scss", "log", "lock",
  "sql", "graphql", "proto",
]);

const CONCEPT_WORDS = new Set([
  "server", "client", "web", "frontend", "backend", "api", "ui", "app",
  "core", "shared", "common", "utils", "config", "docs", "test", "tests",
  "git", "npm", "pnpm", "yarn", "bun", "python", "node", "rust", "go",
  "pytest", "ruff", "mypy", "eslint", "prettier", "vitest", "jest",
  "docker", "ci", "cd", "pr", "repo", "main", "master", "dev",
  "async", "await", "describe", "it", "contexts", "configs", "problem",
  "feature", "formatting", "style", "and", "or", "renaming", "relocating",
  "file", "lockfile", "owner", "property", "path", "route", "routes",
  "package", "packages", "policy", "registry", "storage", "search", "error",
  "auth", "src", "lib", "crates", "tasks", "upstream", "main", "object",
  "property-path",
]);

const PATH_ROOTS = new Set([
  "apps", "bin", "cmd", "config", "configs", "crates", "docs", "examples",
  "fixtures", "lib", "packages", "pnpm", "pnpm11", "pnpr", "scripts", "src",
  "test", "tests", "tools", "web",
]);

const GENERATED_PATH_SEGMENTS = new Set([
  "build", "coverage", "dist", "generated", "out", "target", ".next",
]);

function stripFragment(value: string): string {
  return value.split("#", 1)[0].trim();
}

export function classifyPathCandidate(candidate: string): PathClassification {
  const trimmed = candidate.trim();
  const pathValue = stripFragment(trimmed);

  // 1. URL / Protocol
  if (
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed) ||
    /\bhttps?:\/\//i.test(trimmed) ||
    /^(?:git|ssh)@/i.test(trimmed) ||
    /\blocalhost:\d+/i.test(trimmed)
  ) {
    return "url";
  }

  // npm package names, container images, and issue references are not paths.
  if (
    /^@[a-z0-9._-]+\/[a-z0-9._-]+(?:\/.*)?$/i.test(pathValue) ||
    /^[a-z0-9._-]+\.[a-z]{2,}\//i.test(pathValue) ||
    /^[a-z0-9._-]+\/[a-z0-9._-]+#\d+$/i.test(trimmed)
  ) {
    return "doc_or_concept";
  }

  // 2. Glob pattern
  if (pathValue.includes("*") || pathValue.includes("?") || pathValue.includes("**")) {
    return "glob";
  }

  // 3. Template / placeholder path
  if (
    pathValue.includes("<") ||
    pathValue.includes(">") ||
    pathValue.includes("{") ||
    pathValue.includes("}") ||
    pathValue.includes("${") ||
    pathValue.includes("...") ||
    pathValue.includes("[") ||
    pathValue.includes("]")
  ) {
    return "template";
  }

  // Backtick commands such as `python scripts/build.py` are not repository
  // paths. A path with spaces is ambiguous and is intentionally left for
  // manual review instead of becoming a noisy stale-path finding.
  if (/\s/.test(pathValue) || /^(?:npm|pnpm|yarn|bun|python(?:3)?|pytest|cargo|go|make|just)\b/i.test(pathValue)) {
    return "unknown";
  }

  // Flag-style command parameters such as `--config=examples/app.json` are
  // arguments, not repository paths.
  if (/^--?[a-z0-9][a-z0-9_-]*(?:=|$)/i.test(pathValue)) {
    return "unknown";
  }

  // 4. Runtime route / HTTP / WebSocket endpoint
  if (pathValue.startsWith("/")) {
    const routePrefixes = [
      "/api", "/ws", "/settings", "/v1", "/v2", "/v3", "/v4",
      "/auth", "/login", "/logout", "/graphql", "/health", "/status",
      "/regenerate", "/retry", "/webhook", "/callback", "/users", "/user",
      "/chat", "/session", "/sessions", "/admin", "/static", "/public",
    ];
    const lower = pathValue.toLowerCase();
    if (routePrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
      return "runtime_route";
    }
    // An absolute slash path in instructions is much more likely to be an
    // HTTP/WebSocket route (or an external filesystem path) than a path in
    // this repository. Keep it out of stale-repository diagnostics.
    return "runtime_route";
  }

  // 5. Conceptual / Documentation label (e.g. "Web/API", "server", single concept word)
  const norm = pathValue.toLowerCase().replace(/^(\.\/|\/)/, "");
  if (CONCEPT_WORDS.has(norm)) {
    return "doc_or_concept";
  }

  // Multi-word or title case like "Web/API" or "Backend/Frontend"
  if (/^[A-Z][a-zA-Z0-9]*\/[A-Z][a-zA-Z0-9]*$/.test(pathValue)) {
    return "doc_or_concept";
  }

  const explicitRelative = pathValue.startsWith("./") || pathValue.startsWith("../");
  const segments = pathValue.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  if (!explicitRelative && pathValue.endsWith("/")) {
    return "unknown";
  }
  if (
    !explicitRelative &&
    segments.length === 2 &&
    segments.every((segment) => CONCEPT_WORDS.has(segment)) &&
    !PATH_ROOTS.has(segments[0])
  ) {
    return "doc_or_concept";
  }

  // 6. Check if it's a literal repo path candidate
  const ext = path.extname(pathValue).replace(/^\./, "").toLowerCase();
  if (KNOWN_FILE_EXTENSIONS.has(ext)) {
    return "literal_repo_path";
  }

  // Relative directory path starting with ./ or ../ or has multi-level directory with slash
  if (explicitRelative || (pathValue.includes("/") && !pathValue.startsWith("/"))) {
    return "literal_repo_path";
  }

  return "unknown";
}

export function checkGitHistory(
  repoRoot: string,
  relPath: string,
  gitRef = "HEAD",
  cache?: Map<string, boolean>
): boolean {
  const clean = relPath.replace(/^(\.\/|\/)/, "");
  const cacheKey = `${gitRef}:${clean}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached;

  let existed = false;
  try {
    const out = execFileSync("git", ["log", "-n", "1", gitRef, "--", clean], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    existed = out.length > 0;
  } catch {
    existed = false;
  }

  cache?.set(cacheKey, existed);
  return existed;
}

function findFuzzyMatch(relPath: string, repoRoot: string): string | null {
  const clean = relPath.replace(/^(\.\/|\/)/, "").replace(/\/$/, "");
  const base = path.basename(clean);

  const candidates = [
    path.join("apps", clean),
    path.join("packages", clean),
    path.join("src", clean),
    path.join("apps", base),
    path.join("packages", base),
  ];

  const matches = [...new Set(candidates)].filter((candidate) =>
    fs.existsSync(path.join(repoRoot, candidate))
  );

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function resolveCandidatePath(repoRoot: string, contextPath: string, rawCandidate: string): {
  absolutePath: string;
  repositoryPath: string;
} | null {
  const pathValue = stripFragment(rawCandidate).replace(/^\/+/, "");
  if (!pathValue) return null;

  const contextDirectory = path.dirname(path.join(repoRoot, contextPath));
  const contextRelativeDirectory = path.dirname(contextPath);
  const isRootMetadataFile =
    contextRelativeDirectory === ".github" ||
    contextRelativeDirectory === ".cursor" ||
    contextRelativeDirectory.startsWith(".cursor/");
  const isExplicitRelative = pathValue.startsWith("./") || pathValue.startsWith("../");
  const baseDirectory = isExplicitRelative || !isRootMetadataFile ? contextDirectory : repoRoot;
  const absolutePath = path.resolve(baseDirectory, pathValue);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;

  return {
    absolutePath,
    repositoryPath: relativePath.split(path.sep).join("/"),
  };
}

function isGeneratedRepositoryPath(repositoryPath: string): boolean {
  return repositoryPath
    .split("/")
    .some((segment) => GENERATED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

export function detectStalePaths(
  files: ContextFile[],
  repoRoot: string,
  options: { gitHistoryRoot?: string; gitRef?: string } = {}
): {
  findings: Finding[];
  staleSnippets: string[];
  fixes: Fix[];
} {
  const findings: Finding[] = [];
  const staleSnippets: string[] = [];
  const fixes: Fix[] = [];
  const historyCache = new Map<string, boolean>();

  for (const f of files) {
    const lines = f.content.split(/\r?\n/);

    lines.forEach((line, idx) => {
      // 1. Extract candidates enclosed in backticks or markdown links
      const backtickMatches = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
      const linkMatches = [...line.matchAll(/\[(?:[^\]]+)\]\(([^)]+)\)/g)].map((m) => m[1].trim());

      const candidates = Array.from(new Set([...backtickMatches, ...linkMatches]));
      const seenRepositoryPaths = new Set<string>();

      // 2. If no backticks or links, check for explicit path tokens starting with ./ or containing /
      if (candidates.length === 0) {
        const tokens = line.split(/\s+/);
        for (const tok of tokens) {
          const cleanTok = tok.replace(/^[(`'"]+/, "").replace(/[)`'",:;.]+$/, "");
          if (cleanTok.startsWith("./") || (cleanTok.includes("/") && !cleanTok.includes("://"))) {
            candidates.push(cleanTok);
          }
        }
      }

      for (const rawCandidate of candidates) {
        const classification = classifyPathCandidate(rawCandidate);

        // Discard non-literal paths (globs, templates, runtime routes, URLs, concepts)
        if (classification !== "literal_repo_path") {
          continue;
        }

        const resolvedCandidate = resolveCandidatePath(repoRoot, f.relativePath, rawCandidate);
        if (!resolvedCandidate) continue;

        const normalized = resolvedCandidate.repositoryPath.replace(/\/$/, "");
        if (!normalized || normalized === "node_modules" || normalized === ".git") {
          continue;
        }
        if (isGeneratedRepositoryPath(normalized)) {
          // Build outputs are intentionally absent from many clean checkouts;
          // their paths are not evidence that an instruction is stale.
          continue;
        }
        if (seenRepositoryPaths.has(normalized)) continue;
        seenRepositoryPaths.add(normalized);

        if (fs.existsSync(resolvedCandidate.absolutePath)) {
          // Path exists, all good!
          continue;
        }

        const pathValue = stripFragment(rawCandidate);
        const hasPathShape = pathValue.startsWith("./") || pathValue.startsWith("../") || pathValue.includes("/");

        // Path does NOT exist in the repository filesystem.
        // Check Git commit history to determine if it once existed
        const existedInGit = checkGitHistory(
          options.gitHistoryRoot || repoRoot,
          normalized,
          options.gitRef,
          historyCache
        );
        const suggestedReplacement = findFuzzyMatch(normalized, repoRoot);
        // A bare filename in prose is usually a concept, an example, or a
        // generated artifact name. Keep it quiet unless Git proves that a
        // real repository path was deleted. Explicit relative or nested paths
        // remain eligible for a low-confidence Needs Review finding.
        const hasFileExtension = path.extname(stripFragment(rawCandidate)).length > 1;
        if (!hasPathShape && !existedInGit) continue;
        if (!existedInGit && !hasFileExtension && !suggestedReplacement) continue;

        staleSnippets.push(line);
        const tokens = estimateTokens(line);

        let fix: Fix | undefined = undefined;
        if (suggestedReplacement) {
          fix = createFix({
            id: `fix-stale-path-${f.relativePath}-${idx + 1}`,
            title: `Update unresolved path in ${f.relativePath}`,
            description: `Replace missing path "${rawCandidate}" with existing location "${suggestedReplacement}"`,
            isSafe: false,
            file: f.absolutePath,
            oldText: rawCandidate,
            newText: suggestedReplacement,
            fullOldContent: f.content,
          });
          fixes.push(fix);
        }

        if (existedInGit) {
          // Case B: High confidence - path existed in Git history and was deleted
          findings.push({
            id: `context-stale-path-${f.relativePath}-${idx + 1}`,
            ruleId: "context/stale-path",
            category: "context",
            severity: "high",
            confidence: 0.95,
            title: `Stale path reference: "${rawCandidate}"`,
            description: `Instruction references "${rawCandidate}", which previously existed in git history but was removed. Agents will fail when attempting to read or edit this path.${
              suggestedReplacement ? ` Possible moved location: "${suggestedReplacement}".` : ""
            }`,
            evidence: [
              {
                file: f.relativePath,
                line: idx + 1,
                snippet: line.trim(),
                source: f.relativePath,
              },
              {
                file: normalized,
                snippet: `Found previous git commit history for "${normalized}"`,
                source: "git log",
              },
            ],
            impact: {
              tokens,
              reliability: 9,
            },
            recommendation: suggestedReplacement
              ? `Update reference to "${suggestedReplacement}".`
              : `Remove obsolete reference to deleted path "${rawCandidate}".`,
            fix,
          });
        } else {
          // Case A: Unresolved path reference (not in git history, could be typo or uncreated file)
          const hasFileExt = path.extname(normalized).length > 1;
          const confidence = hasFileExt ? 0.65 : 0.40;
          const needsReview = confidence < 0.80;

          findings.push({
            id: `context-unresolved-path-${f.relativePath}-${idx + 1}`,
            ruleId: "context/unresolved-path",
            category: "context",
            severity: "low",
            confidence,
            needsReview,
            title: `Unresolved path reference: "${rawCandidate}"`,
            description: `Instruction references "${rawCandidate}" which does not match any current files in the repository.${
              suggestedReplacement ? ` Similar existing directory found at "${suggestedReplacement}".` : ""
            }`,
            evidence: [
              {
                file: f.relativePath,
                line: idx + 1,
                snippet: line.trim(),
                source: f.relativePath,
              },
            ],
            impact: {
              tokens,
              reliability: 5,
            },
            recommendation: suggestedReplacement
              ? `Update reference to "${suggestedReplacement}".`
              : `Verify if "${rawCandidate}" is a valid file path or update instructions.`,
            fix,
          });
        }
      }
    });
  }

  return { findings, staleSnippets, fixes };
}
