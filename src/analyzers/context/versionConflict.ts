import * as fs from "node:fs";
import * as path from "node:path";
import { Finding, Fix, Evidence } from "../../core/types.js";
import { ContextFile } from "./duplicateDetector.js";
import { createFix } from "../../core/fix/fixEngine.js";

interface VersionSource {
  source: string;
  versionStr: string;
  major: number;
  line?: number;
  snippet?: string;
  file: ContextFile | { relativePath: string; absolutePath: string; content: string };
}

function extractNodeMajor(text: string): { raw: string; major: number } | null {
  const match = text.match(/(?:node(?:js)?(?:\s+(?:version|is|>=|v))?|\bnode\b\s*[:=]?)\s*v?([0-9]+)(?:\.[0-9]+)?/i);
  if (match && match[1]) {
    return {
      raw: match[0],
      major: parseInt(match[1], 10),
    };
  }
  return null;
}

export function detectVersionConflicts(
  files: ContextFile[],
  repoRoot: string
): {
  findings: Finding[];
  conflictSnippets: string[];
  fixes: Fix[];
} {
  const findings: Finding[] = [];
  const conflictSnippets: string[] = [];
  const fixes: Fix[] = [];

  const sources: VersionSource[] = [];

  // 1. Check package.json engines.node
  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const content = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.engines && pkg.engines.node) {
        const majorMatch = pkg.engines.node.match(/(\d+)/);
        if (majorMatch) {
          sources.push({
            source: "package.json (engines.node)",
            versionStr: pkg.engines.node,
            major: parseInt(majorMatch[1], 10),
            file: {
              relativePath: "package.json",
              absolutePath: pkgPath,
              content,
            },
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Check CI workflows
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  if (fs.existsSync(workflowsDir)) {
    try {
      const ciFiles = fs.readdirSync(workflowsDir);
      for (const cf of ciFiles) {
        if (cf.endsWith(".yml") || cf.endsWith(".yaml")) {
          const cfPath = path.join(workflowsDir, cf);
          const content = fs.readFileSync(cfPath, "utf-8");
          const ciMatch = content.match(/node-version:\s*['"]?([0-9]+)(?:\.[0-9]+)?['"]?/i);
          if (ciMatch) {
            sources.push({
              source: `.github/workflows/${cf}`,
              versionStr: ciMatch[1],
              major: parseInt(ciMatch[1], 10),
              file: {
                relativePath: `.github/workflows/${cf}`,
                absolutePath: cfPath,
                content,
              },
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Check instruction files
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const extracted = extractNodeMajor(line);
      if (extracted) {
        sources.push({
          source: f.relativePath,
          versionStr: extracted.raw,
          major: extracted.major,
          line: idx + 1,
          snippet: line.trim(),
          file: f,
        });
      }
    });
  }

  // Look for authoritative version (CI or package.json) vs instruction files
  const canonicalSource =
    sources.find((s) => s.source.startsWith(".github/workflows")) ||
    sources.find((s) => s.source.startsWith("package.json"));

  if (canonicalSource) {
    for (const s of sources) {
      if (s.source !== canonicalSource.source && s.line !== undefined && s.major !== canonicalSource.major) {
        conflictSnippets.push(s.snippet || "");

        const evidence: Evidence[] = [
          {
            file: s.file.relativePath,
            line: s.line,
            snippet: s.snippet,
            source: s.source,
          },
          {
            file: canonicalSource.file.relativePath,
            snippet: `Node ${canonicalSource.major} specified in ${canonicalSource.source}`,
            source: canonicalSource.source,
          },
        ];

        // Create fix replacing conflicting version in instruction file
        let fix: Fix | undefined = undefined;
        if (s.snippet && s.file.content) {
          const oldSnippet = s.snippet;
          const updatedSnippet = oldSnippet.replace(
            new RegExp(`\\b${s.major}\\b`),
            String(canonicalSource.major)
          );

          if (oldSnippet !== updatedSnippet) {
            fix = createFix({
              id: `fix-version-conflict-${s.file.relativePath}-${s.line}`,
              title: `Align Node.js version in ${s.file.relativePath}`,
              description: `Update Node.js requirement from v${s.major} to v${canonicalSource.major} to match ${canonicalSource.source}`,
              isSafe: true,
              file: s.file.absolutePath,
              oldText: oldSnippet,
              newText: updatedSnippet,
              fullOldContent: s.file.content,
            });
            fixes.push(fix);
          }
        }

        findings.push({
          id: `context-node-conflict-${s.file.relativePath}-${s.line}`,
          ruleId: "context/conflicting-instructions",
          category: "context",
          severity: "high",
          confidence: 0.98,
          title: `Conflicting Node.js version in ${s.file.relativePath}`,
          description: `${s.file.relativePath} specifies Node ${s.major}, but ${canonicalSource.source} requires Node ${canonicalSource.major}. Conflicting environment constraints lead to agent execution failures.`,
          evidence,
          impact: {
            reliability: 9,
          },
          recommendation: `Update ${s.file.relativePath} to require Node >= ${canonicalSource.major}.`,
          fix,
        });
      }
    }
  }

  return { findings, conflictSnippets, fixes };
}
