import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import {
  AGENT_CONFIG_GLOBS,
  AGENT_FILE_IGNORE,
  AGENT_INSTRUCTION_GLOBS,
} from "../context/agentFiles.js";

export type SecurityFileKind =
  | "instruction"
  | "agent-config"
  | "untrusted-doc";

export interface SecurityFile {
  relativePath: string;
  absolutePath: string;
  content: string;
  kind: SecurityFileKind;
}


const UNTRUSTED_DOC_GLOBS = [
  "README.md",
  "README.rst",
  "CONTRIBUTING.md",
  ".github/ISSUE_TEMPLATE/**/*.{md,yml,yaml}",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/**/ISSUE_TEMPLATE.md",
];

const MAX_BYTES = 512 * 1024;

function readFile(repoRoot: string, relativePath: string, kind: SecurityFileKind): SecurityFile | null {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(absolutePath);
    if (buf.includes(0)) return null;
    return {
      relativePath: relativePath.replace(/\\/g, "/"),
      absolutePath,
      content: buf.toString("utf-8"),
      kind,
    };
  } catch {
    return null;
  }
}

async function collect(repoRoot: string, globs: string[], kind: SecurityFileKind): Promise<SecurityFile[]> {
  const relativePaths = await fg(globs, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: AGENT_FILE_IGNORE,
  });
  const files: SecurityFile[] = [];
  for (const rel of relativePaths.sort((a, b) => a.localeCompare(b))) {
    const file = readFile(repoRoot, rel, kind);
    if (file) files.push(file);
  }
  return files;
}

export async function findSecurityScanFiles(repoRoot: string): Promise<SecurityFile[]> {
  const [instructions, configs, docs] = await Promise.all([
    collect(repoRoot, AGENT_INSTRUCTION_GLOBS, "instruction"),
    collect(repoRoot, AGENT_CONFIG_GLOBS, "agent-config"),
    collect(repoRoot, UNTRUSTED_DOC_GLOBS, "untrusted-doc"),
  ]);

  const seen = new Set<string>();
  const files: SecurityFile[] = [];
  for (const file of [...instructions, ...configs, ...docs]) {
    if (seen.has(file.relativePath)) continue;
    seen.add(file.relativePath);
    files.push(file);
  }
  return files;
}

export const GENERATED_DIR_NAMES = [
  "generated",
  "dist",
  "build",
  "openapi-generated",
  ".next",
  "out",
  "target",
];

export async function findGeneratedDirectories(repoRoot: string): Promise<string[]> {
  return (await fg(GENERATED_DIR_NAMES, {
    cwd: repoRoot,
    dot: true,
    onlyDirectories: true,
    unique: true,
    ignore: ["**/.git/**", "**/node_modules/**", "**/.venv/**", "**/venv/**"],
  })).sort((a, b) => a.localeCompare(b));
}
