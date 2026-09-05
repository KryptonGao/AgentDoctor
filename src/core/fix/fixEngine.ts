import * as fs from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import { Fix } from "../types.js";

export function generateDiff(filePath: string, oldContent: string, newContent: string): string {
  const fileName = path.basename(filePath);
  return createTwoFilesPatch(
    `a/${fileName}`,
    `b/${fileName}`,
    oldContent,
    newContent,
    "current",
    "proposed",
    { context: 3 }
  );
}

export function createFix(options: {
  id: string;
  title: string;
  description: string;
  isSafe: boolean;
  file: string;
  oldText: string;
  newText: string;
  fullOldContent?: string;
}): Fix {
  const { id, title, description, isSafe, file, oldText, newText, fullOldContent } = options;
  let diff = "";
  if (fullOldContent !== undefined) {
    const fullNewContent = fullOldContent.replace(oldText, newText);
    diff = generateDiff(file, fullOldContent, fullNewContent);
  } else if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf-8");
    const updated = current.replace(oldText, newText);
    diff = generateDiff(file, current, updated);
  }

  return {
    id,
    title,
    description,
    isSafe,
    file,
    oldText,
    newText,
    diff,
  };
}

export function applyFix(fix: Fix): { success: boolean; error?: string } {
  try {
    if (!fs.existsSync(fix.file)) {
      return { success: false, error: `File not found: ${fix.file}` };
    }
    const currentContent = fs.readFileSync(fix.file, "utf-8");
    if (!currentContent.includes(fix.oldText)) {
      return {
        success: false,
        error: `Could not locate original text in ${fix.file}. Content may have changed.`,
      };
    }
    const newContent = currentContent.replace(fix.oldText, fix.newText);
    fs.writeFileSync(fix.file, newContent, "utf-8");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

export function applySafeFixes(fixes: Fix[]): {
  applied: Fix[];
  failed: { fix: Fix; error: string }[];
} {
  const applied: Fix[] = [];
  const failed: { fix: Fix; error: string }[] = [];

  for (const fix of fixes) {
    if (!fix.isSafe) continue;
    const res = applyFix(fix);
    if (res.success) {
      applied.push(fix);
    } else {
      failed.push({ fix, error: res.error || "Unknown error" });
    }
  }

  return { applied, failed };
}
