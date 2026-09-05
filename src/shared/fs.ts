import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";

export function readTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function readJsonFile<T = any>(filePath: string): T | null {
  try {
    const text = readTextFile(filePath);
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function findFiles(pattern: string | string[], cwd: string, ignore?: string[]): Promise<string[]> {
  try {
    const defaultIgnore = [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.coverage/**",
    ];
    return await fg(pattern, {
      cwd,
      ignore: ignore ? [...defaultIgnore, ...ignore] : defaultIgnore,
      dot: true,
      onlyFiles: true,
    });
  } catch {
    return [];
  }
}

export function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

export function findLineNumber(content: string, substring: string): number | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(substring)) {
      return i + 1;
    }
  }
  return undefined;
}
