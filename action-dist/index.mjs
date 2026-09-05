// src/action/index.ts
import * as fs11 from "fs";

// src/core/types.ts
var SCAN_SCHEMA_VERSION = 1;
var CHECK_SCHEMA_VERSION = 1;

// src/core/findings/identity.ts
import { createHash } from "crypto";
function normalize(value) {
  return value.replace(/\\/g, "/").replace(/\s+/g, " ").trim().toLowerCase();
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
function compareEvidence(a, b) {
  return a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0) || (a.endLine || 0) - (b.endLine || 0) || normalize(a.snippet || "").localeCompare(normalize(b.snippet || "")) || normalize(a.source || "").localeCompare(normalize(b.source || ""));
}
function createFindingFingerprint(finding) {
  const evidence = [...finding.evidence].sort(compareEvidence).slice(0, 3).map((item) => `${normalize(item.file)}|${normalize(item.snippet || "")}`).join("||");
  const fallback = `${normalize(finding.title)}|${normalize(finding.groupKey || "")}`;
  return `v1:${digest(`${finding.category}|${finding.ruleId}|${evidence || fallback}`)}`;
}
function createGroupFingerprint(ruleId, groupKey) {
  return `group:v1:${digest(`${ruleId}|${normalize(groupKey)}`)}`;
}
function ensureFindingFingerprints(findings) {
  return findings.map((finding) => {
    if (finding.children && finding.children.length > 0) {
      finding.children = ensureFindingFingerprints(finding.children).sort(
        (a, b) => (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id) || a.id.localeCompare(b.id)
      );
    }
    finding.evidence = [...finding.evidence].sort(compareEvidence);
    if (finding.confidence < 0.8) finding.needsReview = true;
    if (!finding.fingerprint) {
      finding.fingerprint = createFindingFingerprint(finding);
    }
    return finding;
  });
}
function flattenFindings(findings) {
  const flat = [];
  for (const finding of findings) {
    if (finding.children && finding.children.length > 0) {
      flat.push(...flattenFindings(finding.children));
    } else {
      flat.push(finding);
    }
  }
  return flat;
}

// src/shared/git.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
function getGitBranch(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    return branch || "main";
  } catch {
    return "unknown";
  }
}
function getGitRoot(cwd) {
  if (fs.existsSync(path.join(cwd, ".git"))) {
    return path.resolve(cwd);
  }
  const hasIsolatedManifest = fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "Cargo.toml")) || fs.existsSync(path.join(cwd, "go.mod")) || fs.existsSync(path.join(cwd, "package.json")) && !fs.existsSync(path.join(cwd, "..", "node_modules"));
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    if (hasIsolatedManifest && root && path.resolve(root) !== path.resolve(cwd)) {
      return path.resolve(cwd);
    }
    return path.resolve(root || cwd);
  } catch {
    return path.resolve(cwd);
  }
}
function resolveGitRef(cwd, ref) {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  const candidates = [trimmed];
  if (!trimmed.startsWith("origin/") && !trimmed.startsWith("refs/")) {
    candidates.push(`origin/${trimmed}`);
  }
  for (const candidate of candidates) {
    try {
      const resolved = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
        {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"]
        }
      ).trim();
      if (resolved) return resolved;
    } catch {
    }
  }
  return null;
}
function archiveGitRef(cwd, ref) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoctor-baseline-"));
  const archivePath = path.join(tempRoot, "tree.tar");
  try {
    execFileSync("git", ["archive", "--format=tar", `--output=${archivePath}`, ref], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"]
    });
    execFileSync("tar", ["-xf", archivePath, "-C", tempRoot], {
      stdio: ["pipe", "ignore", "ignore"]
    });
    fs.rmSync(archivePath, { force: true });
    return tempRoot;
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
function removeTemporaryDirectory(directory) {
  if (directory.includes("agentdoctor-baseline-")) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// src/core/scan/scanner.ts
import * as path11 from "path";

// src/core/project/profile.ts
import * as fs2 from "fs";
import * as path2 from "path";
var IGNORED_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "coverage",
  "generated",
  "vendor"
]);
var NODE_WORKSPACE_DIRS = /* @__PURE__ */ new Set(["apps", "packages", "modules", "workspaces", "components"]);
var NON_WORKSPACE_FIXTURE_DIRS = /* @__PURE__ */ new Set(["test", "tests", "fixtures", "docs", "examples", "benchmarks"]);
function walkRepository(repoRoot, maxDepth = 6) {
  const entries = [];
  const queue = [
    { absolutePath: repoRoot, relativePath: "", depth: 0 }
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let children;
    try {
      children = fs2.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === ".DS_Store") continue;
      const relativePath = current.relativePath ? path2.join(current.relativePath, child.name) : child.name;
      const absolutePath = path2.join(repoRoot, relativePath);
      const isDirectory = child.isDirectory();
      entries.push({ relativePath, absolutePath, isDirectory });
      if (isDirectory && current.depth < maxDepth && !IGNORED_DIRS.has(child.name)) {
        queue.push({ absolutePath, relativePath, depth: current.depth + 1 });
      }
    }
  }
  return entries;
}
function relativeDirectory(relativeFile) {
  const directory = path2.dirname(relativeFile);
  return directory === "." ? "." : directory;
}
function readJson(filePath) {
  try {
    return JSON.parse(fs2.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
function hasWorkspaceDeclaration(packageJson) {
  return Boolean(packageJson?.workspaces);
}
function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}
function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
function hasPathSegment(relativePath, names) {
  return relativePath.split(path2.sep).some((segment) => names.has(segment));
}
function isLikelyNodeWorkspacePackage(relativePath) {
  const directory = path2.dirname(relativePath);
  return hasPathSegment(directory, NODE_WORKSPACE_DIRS) && !hasPathSegment(directory, NON_WORKSPACE_FIXTURE_DIRS);
}
function detectProjectProfile(repoRoot) {
  if (!fs2.existsSync(repoRoot)) {
    return {
      primaryEcosystem: "unknown",
      ecosystems: ["unknown"],
      languages: [],
      packageRoots: [],
      workspaceRoots: [],
      isMonorepo: false,
      testRoots: [],
      entryPoints: [],
      configFiles: {},
      confidence: 0.5,
      summary: "Unidentified ecosystem"
    };
  }
  const entries = walkRepository(repoRoot);
  const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
  const directories = entries.filter((entry) => entry.isDirectory).map((entry) => entry.relativePath);
  const fileSet = new Set(files);
  const dirSet = new Set(directories);
  const rootFiles = new Set(
    files.filter((file) => !file.includes(path2.sep)).map((file) => path2.basename(file))
  );
  const configFiles = {};
  const ecosystems = [];
  const languages = [];
  const packageRoots = [];
  const workspaceRoots = [];
  const testRoots = [];
  const entryPoints = [];
  const packageJsonPaths = files.filter((file) => path2.basename(file) === "package.json");
  const pythonConfigNames = /* @__PURE__ */ new Set([
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "poetry.lock",
    "uv.lock",
    "tox.ini",
    "pytest.ini"
  ]);
  const pythonConfigPaths = files.filter((file) => pythonConfigNames.has(path2.basename(file)));
  const rustConfigPaths = files.filter((file) => ["Cargo.toml", "Cargo.lock"].includes(path2.basename(file)));
  const goConfigPaths = files.filter((file) => ["go.mod", "go.sum", "go.work"].includes(path2.basename(file)));
  const rootPackageJson = rootFiles.has("package.json") ? readJson(path2.join(repoRoot, "package.json")) : null;
  const hasNodeWorkspaceDeclaration = hasWorkspaceDeclaration(rootPackageJson) || fileSet.has("pnpm-workspace.yaml");
  const nestedNodeWorkspacePackages = packageJsonPaths.filter(
    (file) => path2.basename(file) === "package.json" && relativeDirectory(file) !== "." && isLikelyNodeWorkspacePackage(file)
  );
  if (packageJsonPaths.length > 0 || files.some((file) => ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].includes(path2.basename(file)))) {
    configFiles.node = sortedUnique([
      ...packageJsonPaths,
      ...files.filter((file) => ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "tsconfig.json"].includes(path2.basename(file)))
    ]);
    ecosystems.push("node");
    languages.push(fileSet.has("tsconfig.json") || files.some((file) => path2.basename(file) === "tsconfig.json") ? "typescript" : "javascript");
    if (hasNodeWorkspaceDeclaration || nestedNodeWorkspacePackages.length > 0) {
      addUnique(workspaceRoots, ".");
    }
    if (rootPackageJson) addUnique(packageRoots, ".");
    for (const packagePath of packageJsonPaths) {
      const packageData = readJson(path2.join(repoRoot, packagePath));
      if (hasWorkspaceDeclaration(packageData)) {
        addUnique(workspaceRoots, relativeDirectory(packagePath));
      }
      const packageRoot = relativeDirectory(packagePath);
      if (packageRoot !== ".") addUnique(packageRoots, packageRoot);
    }
    for (const candidate of ["src", "apps", "packages", "lib", "web", "frontend", "client"]) {
      if (dirSet.has(candidate)) addUnique(packageRoots, candidate);
    }
  }
  if (pythonConfigPaths.length > 0) {
    configFiles.python = sortedUnique(pythonConfigPaths);
    ecosystems.push("python");
    languages.push("python");
    if (pythonConfigPaths.some((file) => !file.includes(path2.sep))) addUnique(packageRoots, ".");
    for (const initFile of files.filter((file) => path2.basename(file) === "__init__.py")) {
      addUnique(packageRoots, relativeDirectory(initFile));
    }
    if (dirSet.has("src")) addUnique(packageRoots, "src");
    const pythonProjectManifests = pythonConfigPaths.filter(
      (file) => ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"].includes(path2.basename(file))
    );
    const nestedPythonProjects = pythonProjectManifests.filter(
      (file) => relativeDirectory(file) !== "." && !hasPathSegment(file, NON_WORKSPACE_FIXTURE_DIRS)
    );
    if (nestedPythonProjects.length > 0) {
      addUnique(workspaceRoots, ".");
    }
  }
  if (rustConfigPaths.length > 0) {
    configFiles.rust = sortedUnique(rustConfigPaths);
    ecosystems.push("rust");
    languages.push("rust");
    if (rustConfigPaths.some((file) => !file.includes(path2.sep))) addUnique(packageRoots, ".");
    for (const cargoPath of rustConfigPaths.filter((file) => path2.basename(file) === "Cargo.toml")) {
      const cargoText = fs2.readFileSync(path2.join(repoRoot, cargoPath), "utf-8");
      const cargoRoot = relativeDirectory(cargoPath);
      if (cargoText.includes("[workspace]")) addUnique(workspaceRoots, cargoRoot);
      if (cargoRoot !== ".") addUnique(packageRoots, cargoRoot);
    }
    for (const candidate of ["src", "crates", "examples"]) {
      if (dirSet.has(candidate)) addUnique(packageRoots, candidate);
    }
  }
  if (goConfigPaths.length > 0) {
    configFiles.go = sortedUnique(goConfigPaths);
    ecosystems.push("go");
    languages.push("go");
    if (goConfigPaths.some((file) => !file.includes(path2.sep))) addUnique(packageRoots, ".");
    const goModulePaths = goConfigPaths.filter((file) => path2.basename(file) === "go.mod");
    if (goConfigPaths.some((file) => path2.basename(file) === "go.work") || goModulePaths.length > 1) {
      addUnique(workspaceRoots, ".");
    }
    for (const goMod of goConfigPaths.filter((file) => path2.basename(file) === "go.mod")) {
      const moduleRoot = relativeDirectory(goMod);
      if (moduleRoot !== ".") addUnique(packageRoots, moduleRoot);
    }
    for (const candidate of ["cmd", "internal", "pkg", "api"]) {
      if (dirSet.has(candidate)) addUnique(packageRoots, candidate);
    }
  }
  if (nestedNodeWorkspacePackages.length > 0 || rustConfigPaths.filter((file) => path2.basename(file) === "Cargo.toml").length > 1 || goConfigPaths.filter((file) => path2.basename(file) === "go.mod").length > 1) {
    addUnique(workspaceRoots, ".");
  }
  for (const directory of directories) {
    const base = path2.basename(directory);
    if (["tests", "test", "__tests__", "spec"].includes(base)) addUnique(testRoots, directory);
  }
  const entryNames = /* @__PURE__ */ new Set([
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
    "main.rs",
    "lib.rs",
    "main.go",
    "main.py",
    "app.py",
    "cli.py",
    "__main__.py"
  ]);
  for (const file of files) {
    if (entryNames.has(path2.basename(file))) addUnique(entryPoints, file);
  }
  const rootHasPython = rootFiles.has("pyproject.toml") || rootFiles.has("setup.py") || rootFiles.has("requirements.txt");
  const rootHasNode = rootFiles.has("package.json") || rootFiles.has("package-lock.json") || rootFiles.has("pnpm-lock.yaml") || rootFiles.has("yarn.lock") || rootFiles.has("bun.lock") || rootFiles.has("bun.lockb");
  const rootHasRust = rootFiles.has("Cargo.toml") || rootFiles.has("Cargo.lock");
  const rootHasGo = rootFiles.has("go.mod") || rootFiles.has("go.work");
  let primaryEcosystem = "unknown";
  if (ecosystems.length === 1) {
    primaryEcosystem = ecosystems[0];
  } else if (ecosystems.length > 1) {
    if (rootHasPython) primaryEcosystem = "python";
    else if (rootHasNode) primaryEcosystem = "node";
    else if (rootHasRust) primaryEcosystem = "rust";
    else if (rootHasGo) primaryEcosystem = "go";
    else primaryEcosystem = "mixed";
  }
  const isMonorepo = workspaceRoots.length > 0 || nestedNodeWorkspacePackages.length > 0 || rustConfigPaths.filter((file) => path2.basename(file) === "Cargo.toml").length > 1 || goConfigPaths.filter((file) => path2.basename(file) === "go.mod").length > 1;
  let confidence = primaryEcosystem === "unknown" ? 0.5 : 0.85;
  if (packageRoots.length > 0) confidence += 0.05;
  if (testRoots.length > 0) confidence += 0.05;
  if (entryPoints.length > 0) confidence += 0.05;
  const uniqueEcosystems = sortedUnique(ecosystems);
  const summary = uniqueEcosystems.length > 1 ? `Multi-ecosystem (${uniqueEcosystems.join(" + ")}, primary: ${primaryEcosystem})` : primaryEcosystem !== "unknown" ? `${primaryEcosystem.charAt(0).toUpperCase() + primaryEcosystem.slice(1)} project` : "Unidentified ecosystem";
  return {
    primaryEcosystem,
    ecosystems: uniqueEcosystems.length > 0 ? uniqueEcosystems : ["unknown"],
    languages: sortedUnique(languages),
    packageRoots: sortedUnique(packageRoots),
    workspaceRoots: sortedUnique(workspaceRoots),
    isMonorepo,
    testRoots: sortedUnique(testRoots),
    entryPoints: sortedUnique(entryPoints),
    configFiles: {
      node: configFiles.node,
      python: configFiles.python,
      rust: configFiles.rust,
      go: configFiles.go
    },
    confidence: Math.min(1, confidence),
    summary
  };
}

// src/analyzers/context/contextAnalyzer.ts
import * as fs7 from "fs";
import * as path7 from "path";
import fg2 from "fast-glob";

// src/analyzers/context/tokenCounter.ts
function estimateTokens(text) {
  if (!text || text.trim().length === 0) return 0;
  const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
  return matches ? matches.length : 0;
}
function sumTokens(snippets) {
  return snippets.reduce((sum, snippet) => sum + estimateTokens(snippet), 0);
}
function calculateSignalDensity(input) {
  const totalTokens = estimateTokens(input.totalContent);
  const duplicateTokens = sumTokens(input.duplicateSnippets);
  const inferableTokens = sumTokens(input.inferableSnippets);
  const staleTokens = sumTokens(input.staleSnippets);
  const lowValueTokens = sumTokens(input.lowValueSnippets);
  const uniqueWastefulSnippets = /* @__PURE__ */ new Map();
  if (input.wastefulSnippets) {
    for (const snippet of input.wastefulSnippets) {
      if (!uniqueWastefulSnippets.has(snippet.key)) {
        uniqueWastefulSnippets.set(snippet.key, snippet.text);
      }
    }
  } else {
    const categories = [
      ["duplicate", input.duplicateSnippets],
      ["inferable", input.inferableSnippets],
      ["stale", input.staleSnippets],
      ["low-value", input.lowValueSnippets]
    ];
    for (const [category, snippets] of categories) {
      snippets.forEach((snippet, index) => {
        uniqueWastefulSnippets.set(`${category}:${index}:${snippet}`, snippet);
      });
    }
  }
  const wastefulTokens2 = [...uniqueWastefulSnippets.values()].reduce(
    (sum, snippet) => sum + estimateTokens(snippet),
    0
  );
  const usefulTokens = Math.max(0, totalTokens - wastefulTokens2);
  const densityPercent = totalTokens > 0 ? Number((usefulTokens / totalTokens * 100).toFixed(1)) : 100;
  return {
    totalTokens,
    usefulTokens,
    wastefulTokens: wastefulTokens2,
    duplicateTokens,
    inferableTokens,
    staleTokens,
    lowValueTokens,
    densityPercent
  };
}

// src/core/fix/fixEngine.ts
import * as fs3 from "fs";
import * as path3 from "path";
import { createTwoFilesPatch } from "diff";
function generateDiff(filePath, oldContent, newContent) {
  const fileName = path3.basename(filePath);
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
function createFix(options) {
  const { id, title, description, isSafe, file, oldText, newText, fullOldContent } = options;
  let diff = "";
  if (fullOldContent !== void 0) {
    const fullNewContent = fullOldContent.replace(oldText, newText);
    diff = generateDiff(file, fullOldContent, fullNewContent);
  } else if (fs3.existsSync(file)) {
    const current = fs3.readFileSync(file, "utf-8");
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
    diff
  };
}

// src/analyzers/context/duplicateDetector.ts
function normalizeSentence(str) {
  return str.toLowerCase().replace(/^[\s*\-#\d.)>]+/, "").replace(/[^\w\s]/g, "").trim();
}
function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = (/* @__PURE__ */ new Set([...wordsA, ...wordsB])).size;
  return intersection / union;
}
function isActionableInstruction(text) {
  return /\b(?:always|never|must|should|do not|don't|run|use|avoid|edit|write|test|install|commit|verify|check|keep|prefer)\b/i.test(text);
}
function detectDuplicates(files) {
  const findings = [];
  const duplicateSnippets = [];
  const duplicateEntries = [];
  const duplicateOccurrenceKeys = /* @__PURE__ */ new Set();
  const fixes = [];
  const allLines = [];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.length > 12 && !trimmed.startsWith("```") && !/^#{1,6}\s/.test(trimmed)) {
        const norm = normalizeSentence(trimmed);
        if (norm.length > 10) {
          allLines.push({
            file: f,
            lineNumber: idx + 1,
            rawLine: line,
            normalized: norm
          });
        }
      }
    });
  }
  const pairMatches = /* @__PURE__ */ new Map();
  const fileGroups = /* @__PURE__ */ new Map();
  for (const item of allLines) {
    const group = fileGroups.get(item.file.relativePath) || [];
    group.push(item);
    fileGroups.set(item.file.relativePath, group);
  }
  const contextFiles = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (let leftIndex = 0; leftIndex < contextFiles.length; leftIndex++) {
    const leftFile = contextFiles[leftIndex];
    const leftLines = fileGroups.get(leftFile.relativePath) || [];
    for (let rightIndex = leftIndex + 1; rightIndex < contextFiles.length; rightIndex++) {
      const rightFile = contextFiles[rightIndex];
      const rightLines = fileGroups.get(rightFile.relativePath) || [];
      const matches = [];
      const seenPairs = /* @__PURE__ */ new Set();
      for (const left of leftLines) {
        for (const right of rightLines) {
          const exact = left.normalized === right.normalized;
          const similar = !exact && jaccardSimilarity(left.normalized, right.normalized) >= 0.8;
          if (!exact && !similar) continue;
          const pairId = `${left.lineNumber}:${right.lineNumber}`;
          if (seenPairs.has(pairId)) continue;
          seenPairs.add(pairId);
          matches.push({ left, right });
        }
      }
      if (matches.length > 0) {
        pairMatches.set(`${leftFile.relativePath}\0${rightFile.relativePath}`, {
          left: leftFile,
          right: rightFile,
          matches: matches.sort((a, b) => a.left.lineNumber - b.left.lineNumber || a.right.lineNumber - b.right.lineNumber)
        });
      }
    }
  }
  for (const [, pair] of [...pairMatches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const representativeMatches = pair.matches.slice(0, 6);
    const evidence = representativeMatches.flatMap(({ left, right }) => [left, right]).map((occ) => ({
      file: occ.file.relativePath,
      line: occ.lineNumber,
      snippet: occ.rawLine.trim(),
      source: occ.file.relativePath
    }));
    const redundantOccurrences = pair.matches.map(({ right }) => right);
    const redundantTokens = redundantOccurrences.reduce(
      (sum, occurrence) => sum + estimateTokens(occurrence.rawLine),
      0
    );
    if (pair.matches.length === 1 && redundantTokens < 8 && !isActionableInstruction(pair.matches[0].right.normalized)) continue;
    redundantOccurrences.forEach((occurrence) => {
      const key = `${occurrence.file.relativePath}:${occurrence.lineNumber}`;
      if (duplicateOccurrenceKeys.has(key)) return;
      duplicateOccurrenceKeys.add(key);
      duplicateSnippets.push(occurrence.rawLine);
      duplicateEntries.push({ key, text: occurrence.rawLine });
    });
    let fix;
    if (pair.matches.length === 1) {
      const secondary = pair.matches[0].right;
      const primary = pair.matches[0].left;
      const oldLineWithNewline = secondary.rawLine + "\n";
      const oldText = secondary.file.content.includes(oldLineWithNewline) ? oldLineWithNewline : secondary.rawLine;
      fix = createFix({
        id: `fix-dup-${secondary.file.relativePath}-${secondary.lineNumber}`,
        title: `Remove duplicate instruction in ${secondary.file.relativePath}`,
        description: `Removes duplicate rule already documented in ${primary.file.relativePath}:${primary.lineNumber}`,
        isSafe: true,
        file: secondary.file.absolutePath,
        oldText,
        newText: "",
        fullOldContent: secondary.file.content
      });
      fixes.push(fix);
    }
    findings.push({
      id: `context-dup-${pair.left.relativePath}-${pair.right.relativePath}`,
      ruleId: "context/duplicate-instruction",
      category: "context",
      severity: "medium",
      confidence: 0.9,
      title: `Duplicate instruction block across ${pair.left.relativePath} and ${pair.right.relativePath}`,
      description: `Found ${pair.matches.length} duplicate or highly similar instruction lines across two context files. This inflates agent context and risks divergent rules.`,
      evidence,
      impact: {
        tokens: redundantTokens
      },
      recommendation: `Consolidate the repeated rules into a single primary instruction file (${pair.left.relativePath}) and remove redundant copies from ${pair.right.relativePath}.`,
      fix
    });
  }
  return { findings, duplicateSnippets, duplicateEntries, fixes };
}

// src/analyzers/context/inferableDetector.ts
import * as fs4 from "fs";
import * as path4 from "path";
import fg from "fast-glob";
function extractRepoMetadata(repoRoot) {
  const manifestFiles = fg.sync(
    [
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/package-lock.json",
      "**/bun.lockb",
      "**/bun.lock",
      "**/tsconfig.json",
      "**/package.json"
    ],
    {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/target/**"]
    }
  );
  const hasPnpmLock = manifestFiles.some((file) => path4.basename(file) === "pnpm-lock.yaml");
  const hasYarnLock = manifestFiles.some((file) => path4.basename(file) === "yarn.lock");
  const hasNpmLock = manifestFiles.some((file) => path4.basename(file) === "package-lock.json");
  const hasBunLock = manifestFiles.some((file) => ["bun.lockb", "bun.lock"].includes(path4.basename(file)));
  const hasTsConfig = manifestFiles.some((file) => path4.basename(file) === "tsconfig.json");
  let packageManagerField;
  const dependencies = [];
  for (const relativePath of manifestFiles.filter((file) => path4.basename(file) === "package.json").sort()) {
    try {
      const pkg = JSON.parse(fs4.readFileSync(path4.join(repoRoot, relativePath), "utf-8"));
      packageManagerField ||= pkg.packageManager;
      if (pkg.dependencies) dependencies.push(...Object.keys(pkg.dependencies));
      if (pkg.devDependencies) dependencies.push(...Object.keys(pkg.devDependencies));
    } catch {
    }
  }
  return {
    hasPnpmLock,
    hasYarnLock,
    hasNpmLock,
    hasBunLock,
    packageManagerField,
    hasTsConfig,
    dependencies: [...new Set(dependencies)].sort()
  };
}
function detectInferableContext(files, metadata) {
  const findings = [];
  const inferableSnippets = [];
  const fixes = [];
  const inferableChecks = [
    {
      id: "inferable-pnpm",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses pnpm|package manager is pnpm|use pnpm|always use pnpm)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.hasPnpmLock || !!(meta.packageManagerField && meta.packageManagerField.includes("pnpm")),
        evidenceSource: meta.hasPnpmLock ? "pnpm-lock.yaml" : "package.json packageManager"
      }),
      title: "Inferable package manager instruction (pnpm)",
      description: "Instruction explicitly states to use pnpm, which is already deterministically declared in repository lockfiles/packageManager."
    },
    {
      id: "inferable-yarn",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses yarn|package manager is yarn|use yarn)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.hasYarnLock || !!(meta.packageManagerField && meta.packageManagerField.includes("yarn")),
        evidenceSource: meta.hasYarnLock ? "yarn.lock" : "package.json packageManager"
      }),
      title: "Inferable package manager instruction (yarn)",
      description: "Instruction explicitly states to use yarn, which is already deterministically declared in repository lockfiles."
    },
    {
      id: "inferable-typescript",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses typescript|written in typescript)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.hasTsConfig || meta.dependencies.includes("typescript"),
        evidenceSource: meta.hasTsConfig ? "tsconfig.json" : "package.json dependencies"
      }),
      title: "Inferable language instruction (TypeScript)",
      description: "Instruction states the project uses TypeScript, which is already evident from tsconfig.json and ts files."
    },
    {
      id: "inferable-react",
      regex: /^(?:[\s*\-#\d.)>]*)(?:this project uses react|frontend framework is react)[\s.!]*$/i,
      isInferable: (meta) => ({
        inferable: meta.dependencies.includes("react"),
        evidenceSource: "package.json dependencies (react)"
      }),
      title: "Inferable framework instruction (React)",
      description: "Instruction states the project uses React, which is clearly listed in package.json dependencies."
    }
  ];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      for (const check of inferableChecks) {
        if (check.regex.test(trimmed)) {
          const { inferable, evidenceSource } = check.isInferable(metadata);
          if (inferable) {
            inferableSnippets.push(line);
            const tokens = estimateTokens(line);
            const oldLineWithNewline = line + "\n";
            const oldText = f.content.includes(oldLineWithNewline) ? oldLineWithNewline : line;
            const fix = createFix({
              id: `fix-inferable-${f.relativePath}-${idx + 1}`,
              title: `Remove inferable instruction in ${f.relativePath}`,
              description: `Removes redundant instruction "${trimmed}" which is already declared by ${evidenceSource}.`,
              isSafe: true,
              file: f.absolutePath,
              oldText,
              newText: "",
              fullOldContent: f.content
            });
            fixes.push(fix);
            findings.push({
              id: `context-${check.id}-${f.relativePath}-${idx + 1}`,
              ruleId: "context/inferable-context",
              category: "context",
              severity: "low",
              confidence: 0.95,
              title: check.title,
              description: check.description,
              evidence: [
                {
                  file: f.relativePath,
                  line: idx + 1,
                  snippet: trimmed,
                  source: f.relativePath
                },
                {
                  file: evidenceSource,
                  snippet: `Declared in ${evidenceSource}`,
                  source: evidenceSource
                }
              ],
              impact: {
                tokens
              },
              recommendation: "Remove from global context to conserve context window tokens for high-value instructions.",
              fix
            });
          }
        }
      }
    });
  }
  return { findings, inferableSnippets, fixes };
}

// src/analyzers/context/stalePathDetector.ts
import * as fs5 from "fs";
import * as path5 from "path";
import { execFileSync as execFileSync2 } from "child_process";
var KNOWN_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "pyi",
  "rs",
  "go",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "md",
  "mdx",
  "txt",
  "rst",
  "sh",
  "bash",
  "zsh",
  "html",
  "css",
  "scss",
  "log",
  "lock",
  "sql",
  "graphql",
  "proto"
]);
var CONCEPT_WORDS = /* @__PURE__ */ new Set([
  "server",
  "client",
  "web",
  "frontend",
  "backend",
  "api",
  "ui",
  "app",
  "core",
  "shared",
  "common",
  "utils",
  "config",
  "docs",
  "test",
  "tests",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "node",
  "rust",
  "go",
  "pytest",
  "ruff",
  "mypy",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "docker",
  "ci",
  "cd",
  "pr",
  "repo",
  "main",
  "master",
  "dev",
  "async",
  "await",
  "describe",
  "it",
  "contexts",
  "configs",
  "problem",
  "feature",
  "formatting",
  "style",
  "and",
  "or",
  "renaming",
  "relocating",
  "file",
  "lockfile",
  "owner",
  "property",
  "path",
  "route",
  "routes",
  "package",
  "packages",
  "policy",
  "registry",
  "storage",
  "search",
  "error",
  "auth",
  "src",
  "lib",
  "crates",
  "tasks",
  "upstream",
  "main",
  "object",
  "property-path"
]);
var PATH_ROOTS = /* @__PURE__ */ new Set([
  "apps",
  "bin",
  "cmd",
  "config",
  "configs",
  "crates",
  "docs",
  "examples",
  "fixtures",
  "lib",
  "packages",
  "pnpm",
  "pnpm11",
  "pnpr",
  "scripts",
  "src",
  "test",
  "tests",
  "tools",
  "web"
]);
var GENERATED_PATH_SEGMENTS = /* @__PURE__ */ new Set([
  "build",
  "coverage",
  "dist",
  "generated",
  "out",
  "target",
  ".next"
]);
function stripFragment(value) {
  return value.split("#", 1)[0].trim();
}
function classifyPathCandidate(candidate) {
  const trimmed = candidate.trim();
  const pathValue = stripFragment(trimmed);
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed) || /\bhttps?:\/\//i.test(trimmed) || /^(?:git|ssh)@/i.test(trimmed) || /\blocalhost:\d+/i.test(trimmed)) {
    return "url";
  }
  if (/^@[a-z0-9._-]+\/[a-z0-9._-]+(?:\/.*)?$/i.test(pathValue) || /^[a-z0-9._-]+\.[a-z]{2,}\//i.test(pathValue) || /^[a-z0-9._-]+\/[a-z0-9._-]+#\d+$/i.test(trimmed)) {
    return "doc_or_concept";
  }
  if (pathValue.includes("*") || pathValue.includes("?") || pathValue.includes("**")) {
    return "glob";
  }
  if (pathValue.includes("<") || pathValue.includes(">") || pathValue.includes("{") || pathValue.includes("}") || pathValue.includes("${") || pathValue.includes("...") || pathValue.includes("[") || pathValue.includes("]")) {
    return "template";
  }
  if (/\s/.test(pathValue) || /^(?:npm|pnpm|yarn|bun|python(?:3)?|pytest|cargo|go|make|just)\b/i.test(pathValue)) {
    return "unknown";
  }
  if (/^--?[a-z0-9][a-z0-9_-]*(?:=|$)/i.test(pathValue)) {
    return "unknown";
  }
  if (pathValue.startsWith("/")) {
    const routePrefixes = [
      "/api",
      "/ws",
      "/settings",
      "/v1",
      "/v2",
      "/v3",
      "/v4",
      "/auth",
      "/login",
      "/logout",
      "/graphql",
      "/health",
      "/status",
      "/regenerate",
      "/retry",
      "/webhook",
      "/callback",
      "/users",
      "/user",
      "/chat",
      "/session",
      "/sessions",
      "/admin",
      "/static",
      "/public"
    ];
    const lower = pathValue.toLowerCase();
    if (routePrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
      return "runtime_route";
    }
    return "runtime_route";
  }
  const norm = pathValue.toLowerCase().replace(/^(\.\/|\/)/, "");
  if (CONCEPT_WORDS.has(norm)) {
    return "doc_or_concept";
  }
  if (/^[A-Z][a-zA-Z0-9]*\/[A-Z][a-zA-Z0-9]*$/.test(pathValue)) {
    return "doc_or_concept";
  }
  const explicitRelative = pathValue.startsWith("./") || pathValue.startsWith("../");
  const segments = pathValue.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  if (!explicitRelative && pathValue.endsWith("/")) {
    return "unknown";
  }
  if (!explicitRelative && segments.length === 2 && segments.every((segment) => CONCEPT_WORDS.has(segment)) && !PATH_ROOTS.has(segments[0])) {
    return "doc_or_concept";
  }
  const ext = path5.extname(pathValue).replace(/^\./, "").toLowerCase();
  if (KNOWN_FILE_EXTENSIONS.has(ext)) {
    return "literal_repo_path";
  }
  if (explicitRelative || pathValue.includes("/") && !pathValue.startsWith("/")) {
    return "literal_repo_path";
  }
  return "unknown";
}
function checkGitHistory(repoRoot, relPath, gitRef = "HEAD", cache) {
  const clean = relPath.replace(/^(\.\/|\/)/, "");
  const cacheKey = `${gitRef}:${clean}`;
  const cached = cache?.get(cacheKey);
  if (cached !== void 0) return cached;
  let existed = false;
  try {
    const out = execFileSync2("git", ["log", "-n", "1", gitRef, "--", clean], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    }).trim();
    existed = out.length > 0;
  } catch {
    existed = false;
  }
  cache?.set(cacheKey, existed);
  return existed;
}
function findFuzzyMatch(relPath, repoRoot) {
  const clean = relPath.replace(/^(\.\/|\/)/, "").replace(/\/$/, "");
  const base = path5.basename(clean);
  const candidates = [
    path5.join("apps", clean),
    path5.join("packages", clean),
    path5.join("src", clean),
    path5.join("apps", base),
    path5.join("packages", base)
  ];
  const matches = [...new Set(candidates)].filter(
    (candidate) => fs5.existsSync(path5.join(repoRoot, candidate))
  );
  if (matches.length === 1) {
    return matches[0];
  }
  return null;
}
function resolveCandidatePath(repoRoot, contextPath, rawCandidate) {
  const pathValue = stripFragment(rawCandidate).replace(/^\/+/, "");
  if (!pathValue) return null;
  const contextDirectory = path5.dirname(path5.join(repoRoot, contextPath));
  const contextRelativeDirectory = path5.dirname(contextPath);
  const isRootMetadataFile = contextRelativeDirectory === ".github" || contextRelativeDirectory === ".cursor" || contextRelativeDirectory.startsWith(".cursor/");
  const isExplicitRelative = pathValue.startsWith("./") || pathValue.startsWith("../");
  const baseDirectory = isExplicitRelative || !isRootMetadataFile ? contextDirectory : repoRoot;
  const absolutePath = path5.resolve(baseDirectory, pathValue);
  const relativePath = path5.relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..") || path5.isAbsolute(relativePath)) return null;
  return {
    absolutePath,
    repositoryPath: relativePath.split(path5.sep).join("/")
  };
}
function isGeneratedRepositoryPath(repositoryPath) {
  return repositoryPath.split("/").some((segment) => GENERATED_PATH_SEGMENTS.has(segment.toLowerCase()));
}
function detectStalePaths(files, repoRoot, options = {}) {
  const findings = [];
  const staleSnippets = [];
  const fixes = [];
  const historyCache = /* @__PURE__ */ new Map();
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const backtickMatches = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
      const linkMatches = [...line.matchAll(/\[(?:[^\]]+)\]\(([^)]+)\)/g)].map((m) => m[1].trim());
      const candidates = Array.from(/* @__PURE__ */ new Set([...backtickMatches, ...linkMatches]));
      const seenRepositoryPaths = /* @__PURE__ */ new Set();
      if (candidates.length === 0) {
        const tokens = line.split(/\s+/);
        for (const tok of tokens) {
          const cleanTok = tok.replace(/^[(`'"]+/, "").replace(/[)`'",:;.]+$/, "");
          if (cleanTok.startsWith("./") || cleanTok.includes("/") && !cleanTok.includes("://")) {
            candidates.push(cleanTok);
          }
        }
      }
      for (const rawCandidate of candidates) {
        const classification = classifyPathCandidate(rawCandidate);
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
          continue;
        }
        if (seenRepositoryPaths.has(normalized)) continue;
        seenRepositoryPaths.add(normalized);
        if (fs5.existsSync(resolvedCandidate.absolutePath)) {
          continue;
        }
        const pathValue = stripFragment(rawCandidate);
        const hasPathShape = pathValue.startsWith("./") || pathValue.startsWith("../") || pathValue.includes("/");
        const existedInGit = checkGitHistory(
          options.gitHistoryRoot || repoRoot,
          normalized,
          options.gitRef,
          historyCache
        );
        const suggestedReplacement = findFuzzyMatch(normalized, repoRoot);
        const hasFileExtension = path5.extname(stripFragment(rawCandidate)).length > 1;
        if (!hasPathShape && !existedInGit) continue;
        if (!existedInGit && !hasFileExtension && !suggestedReplacement) continue;
        staleSnippets.push(line);
        const tokens = estimateTokens(line);
        let fix = void 0;
        if (suggestedReplacement) {
          fix = createFix({
            id: `fix-stale-path-${f.relativePath}-${idx + 1}`,
            title: `Update unresolved path in ${f.relativePath}`,
            description: `Replace missing path "${rawCandidate}" with existing location "${suggestedReplacement}"`,
            isSafe: false,
            file: f.absolutePath,
            oldText: rawCandidate,
            newText: suggestedReplacement,
            fullOldContent: f.content
          });
          fixes.push(fix);
        }
        if (existedInGit) {
          findings.push({
            id: `context-stale-path-${f.relativePath}-${idx + 1}`,
            ruleId: "context/stale-path",
            category: "context",
            severity: "high",
            confidence: 0.95,
            title: `Stale path reference: "${rawCandidate}"`,
            description: `Instruction references "${rawCandidate}", which previously existed in git history but was removed. Agents will fail when attempting to read or edit this path.${suggestedReplacement ? ` Possible moved location: "${suggestedReplacement}".` : ""}`,
            evidence: [
              {
                file: f.relativePath,
                line: idx + 1,
                snippet: line.trim(),
                source: f.relativePath
              },
              {
                file: normalized,
                snippet: `Found previous git commit history for "${normalized}"`,
                source: "git log"
              }
            ],
            impact: {
              tokens,
              reliability: 9
            },
            recommendation: suggestedReplacement ? `Update reference to "${suggestedReplacement}".` : `Remove obsolete reference to deleted path "${rawCandidate}".`,
            fix
          });
        } else {
          const hasFileExt = path5.extname(normalized).length > 1;
          const confidence = hasFileExt ? 0.65 : 0.4;
          const needsReview = confidence < 0.8;
          findings.push({
            id: `context-unresolved-path-${f.relativePath}-${idx + 1}`,
            ruleId: "context/unresolved-path",
            category: "context",
            severity: "low",
            confidence,
            needsReview,
            title: `Unresolved path reference: "${rawCandidate}"`,
            description: `Instruction references "${rawCandidate}" which does not match any current files in the repository.${suggestedReplacement ? ` Similar existing directory found at "${suggestedReplacement}".` : ""}`,
            evidence: [
              {
                file: f.relativePath,
                line: idx + 1,
                snippet: line.trim(),
                source: f.relativePath
              }
            ],
            impact: {
              tokens,
              reliability: 5
            },
            recommendation: suggestedReplacement ? `Update reference to "${suggestedReplacement}".` : `Verify if "${rawCandidate}" is a valid file path or update instructions.`,
            fix
          });
        }
      }
    });
  }
  return { findings, staleSnippets, fixes };
}

// src/analyzers/context/versionConflict.ts
import * as fs6 from "fs";
import * as path6 from "path";
function extractNodeMajor(text) {
  const match = text.match(/(?:node(?:js)?(?:\s+(?:version|is|>=|v))?|\bnode\b\s*[:=]?)\s*v?([0-9]+)(?:\.[0-9]+)?/i);
  if (match && match[1]) {
    return {
      raw: match[0],
      major: parseInt(match[1], 10)
    };
  }
  return null;
}
function detectVersionConflicts(files, repoRoot) {
  const findings = [];
  const conflictSnippets = [];
  const fixes = [];
  const sources = [];
  const pkgPath = path6.join(repoRoot, "package.json");
  if (fs6.existsSync(pkgPath)) {
    try {
      const content = fs6.readFileSync(pkgPath, "utf-8");
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
              content
            }
          });
        }
      }
    } catch {
    }
  }
  const workflowsDir = path6.join(repoRoot, ".github", "workflows");
  if (fs6.existsSync(workflowsDir)) {
    try {
      const ciFiles = fs6.readdirSync(workflowsDir);
      for (const cf of ciFiles) {
        if (cf.endsWith(".yml") || cf.endsWith(".yaml")) {
          const cfPath = path6.join(workflowsDir, cf);
          const content = fs6.readFileSync(cfPath, "utf-8");
          const ciMatch = content.match(/node-version:\s*['"]?([0-9]+)(?:\.[0-9]+)?['"]?/i);
          if (ciMatch) {
            sources.push({
              source: `.github/workflows/${cf}`,
              versionStr: ciMatch[1],
              major: parseInt(ciMatch[1], 10),
              file: {
                relativePath: `.github/workflows/${cf}`,
                absolutePath: cfPath,
                content
              }
            });
          }
        }
      }
    } catch {
    }
  }
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
          file: f
        });
      }
    });
  }
  const canonicalSource = sources.find((s) => s.source.startsWith(".github/workflows")) || sources.find((s) => s.source.startsWith("package.json"));
  if (canonicalSource) {
    for (const s of sources) {
      if (s.source !== canonicalSource.source && s.line !== void 0 && s.major !== canonicalSource.major) {
        conflictSnippets.push(s.snippet || "");
        const evidence = [
          {
            file: s.file.relativePath,
            line: s.line,
            snippet: s.snippet,
            source: s.source
          },
          {
            file: canonicalSource.file.relativePath,
            snippet: `Node ${canonicalSource.major} specified in ${canonicalSource.source}`,
            source: canonicalSource.source
          }
        ];
        let fix = void 0;
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
              fullOldContent: s.file.content
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
            reliability: 9
          },
          recommendation: `Update ${s.file.relativePath} to require Node >= ${canonicalSource.major}.`,
          fix
        });
      }
    }
  }
  return { findings, conflictSnippets, fixes };
}

// src/analyzers/context/contextAnalyzer.ts
var LOW_VALUE_PATTERNS = [
  /^(?:[\s*\-#\d.)>]*)(?:write clean (?:and maintainable )?code|always write clean code)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:follow best practices|adhere to standard conventions)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:be careful(?:\s+and avoid bugs)?|ensure no bugs are introduced)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:think (?:step by step|carefully before editing))[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:do your best|be helpful and thorough)[\s.!]*$/i
];
var CONTEXT_PATTERNS = [
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.cursorrules",
  "**/.cursor/rules/**/*.mdc",
  "**/.cursor/rules/**/*.md",
  ".cursor/rules/**/*.mdc",
  ".cursor/rules/**/*.md",
  "**/.github/copilot-instructions.md",
  ".claude/skills/**/*.md"
];
async function findContextFiles(repoRoot) {
  const relativePaths = await fg2(CONTEXT_PATTERNS, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/out/**",
      "**/coverage/**",
      "**/generated/**",
      "**/vendor/**",
      "**/.next/**",
      "**/.venv/**",
      "**/venv/**"
    ]
  });
  const files = [];
  for (const rel of relativePaths) {
    const abs = path7.join(repoRoot, rel);
    try {
      if (fs7.existsSync(abs)) {
        const content = fs7.readFileSync(abs, "utf-8");
        files.push({
          relativePath: rel,
          absolutePath: abs,
          content
        });
      }
    } catch {
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
function collectWastefulSnippetEntries(findings, seedEntries = []) {
  const entries = /* @__PURE__ */ new Map();
  for (const entry of seedEntries) {
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }
  for (const finding of findings) {
    if (finding.category !== "context") continue;
    if (finding.ruleId === "context/duplicate-instruction") continue;
    const evidence = finding.evidence.slice(0, 1);
    for (const item of evidence) {
      if (!item.snippet) continue;
      const key = `${item.file}:${item.line ?? "file"}`;
      if (!entries.has(key)) {
        entries.set(key, { key, text: item.snippet });
      }
    }
  }
  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}
async function analyzeContext(repoRoot, options = {}) {
  const contextFiles = await findContextFiles(repoRoot);
  const metadata = extractRepoMetadata(repoRoot);
  const findings = [];
  const fixes = [];
  const duplicateSnippets = [];
  const duplicateWastefulEntries = [];
  const inferableSnippets = [];
  const staleSnippets = [];
  const lowValueSnippets = [];
  const dupResult = detectDuplicates(contextFiles);
  findings.push(...dupResult.findings);
  fixes.push(...dupResult.fixes);
  duplicateSnippets.push(...dupResult.duplicateSnippets);
  duplicateWastefulEntries.push(...dupResult.duplicateEntries);
  const inferResult = detectInferableContext(contextFiles, metadata);
  findings.push(...inferResult.findings);
  fixes.push(...inferResult.fixes);
  inferableSnippets.push(...inferResult.inferableSnippets);
  const staleResult = detectStalePaths(
    contextFiles,
    repoRoot,
    {
      gitHistoryRoot: options.gitHistoryRoot,
      gitRef: options.gitRef
    }
  );
  findings.push(...staleResult.findings);
  fixes.push(...staleResult.fixes);
  staleSnippets.push(...staleResult.staleSnippets);
  const conflictResult = detectVersionConflicts(contextFiles, repoRoot);
  findings.push(...conflictResult.findings);
  fixes.push(...conflictResult.fixes);
  staleSnippets.push(...conflictResult.conflictSnippets);
  for (const f of contextFiles) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      for (const pat of LOW_VALUE_PATTERNS) {
        if (pat.test(trimmed)) {
          lowValueSnippets.push(line);
          findings.push({
            id: `context-low-value-${f.relativePath}-${idx + 1}`,
            ruleId: "context/low-value-instructions",
            category: "context",
            severity: "low",
            confidence: 0.85,
            title: "Low-value instruction detected",
            description: `"${trimmed}" is a non-actionable generic platitude that adds no repository-specific guidance and wastes prompt tokens.`,
            evidence: [
              {
                file: f.relativePath,
                line: idx + 1,
                snippet: trimmed,
                source: f.relativePath
              }
            ],
            impact: {
              tokens: estimateTokens(line)
            },
            recommendation: "Remove generic instructions. Focus instructions on non-obvious architecture, testing, and tool constraints."
          });
          break;
        }
      }
    });
  }
  for (const f of contextFiles) {
    const tokens = estimateTokens(f.content);
    if (tokens > 2500) {
      findings.push({
        id: `context-oversized-${f.relativePath}`,
        ruleId: "context/oversized-context",
        category: "context",
        severity: "medium",
        confidence: 0.9,
        title: `Oversized instruction file: ${f.relativePath} (${tokens.toLocaleString()} tokens)`,
        description: `This file contains ${tokens.toLocaleString()} tokens. Excessive context slows down agent inference, crowds system prompts, and increases token costs per turn.`,
        evidence: [
          {
            file: f.relativePath,
            snippet: `${tokens.toLocaleString()} tokens across ${f.content.split(/\r?\n/).length} lines`,
            source: f.relativePath
          }
        ],
        impact: {
          tokens: Math.round(tokens * 0.4)
        },
        recommendation: "Split detailed documentation into on-demand docs and keep root agent instructions concise (< 1,500 tokens)."
      });
    }
  }
  const combinedContent = contextFiles.map((f) => f.content).join("\n\n");
  const signalDensity = calculateSignalDensity({
    totalContent: combinedContent,
    duplicateSnippets,
    inferableSnippets,
    staleSnippets,
    lowValueSnippets,
    wastefulSnippets: collectWastefulSnippetEntries(findings, duplicateWastefulEntries)
  });
  return {
    findings,
    fixes,
    signalDensity,
    scannedFiles: contextFiles.map((f) => f.relativePath)
  };
}

// src/analyzers/repository/repoAnalyzer.ts
import * as fs8 from "fs";
import * as path8 from "path";
import fg3 from "fast-glob";
var GENERATED_DIRS = ["generated", "dist", "build", "openapi-generated", ".next", "out", "target"];
function isGeneratedFile(content) {
  const header = content.slice(0, 4e3).toLowerCase();
  return /(?:do not edit[\s,]*(?:this is an )?(?:auto[- ]generated|generated)|code generated|auto[- ]generated|autogenerated|generated file|machine[- ]generated)/i.test(header);
}
async function analyzeRepository(repoRoot, profile) {
  const findings = [];
  const hasRecognizedPackages = profile.packageRoots.length > 0;
  const hasRecognizedTests = profile.testRoots.length > 0;
  if (!hasRecognizedPackages && profile.entryPoints.length === 0) {
    findings.push({
      id: "repo-unorganized-structure",
      ruleId: "repo/project-structure",
      category: "repository",
      severity: "low",
      confidence: 0.5,
      needsReview: true,
      title: "Unidentified source code layout",
      description: "Could not identify standard package roots or entry points for this project. Agents may require explicit path guidance in AGENTS.md to navigate the repository.",
      evidence: [
        {
          file: ".",
          snippet: `Ecosystem: ${profile.primaryEcosystem}`,
          source: "filesystem"
        }
      ],
      recommendation: "Document key package directories and entry points in AGENTS.md."
    });
  }
  const sourceFiles = await fg3(["**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp}"], {
    cwd: repoRoot,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/.venv/**",
      "**/venv/**",
      "**/target/**",
      "**/out/**",
      "**/coverage/**",
      "**/vendor/**",
      "**/.next/**",
      "**/*.min.js",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/generated/**"
    ]
  });
  const largeFiles = [];
  for (const relFile of sourceFiles) {
    const absPath = path8.join(repoRoot, relFile);
    try {
      const content = fs8.readFileSync(absPath, "utf-8");
      const lineCount = content.split(/\r?\n/).length;
      if (isGeneratedFile(content)) continue;
      const isTestFile = relFile.includes("tests/") || relFile.includes("test/") || path8.basename(relFile).startsWith("test_") || relFile.includes(".test.") || relFile.includes(".spec.");
      const threshold = isTestFile ? 3e3 : 1500;
      if (lineCount > threshold) {
        largeFiles.push({ file: relFile, lines: lineCount });
        findings.push({
          id: `repo-large-file-${relFile.replace(/[^a-zA-Z0-9]/g, "-")}`,
          ruleId: "repo/oversized-source-files",
          category: "repository",
          severity: isTestFile ? "low" : "medium",
          confidence: 0.9,
          title: `Oversized ${isTestFile ? "test suite" : "source"} file: ${relFile} (${lineCount.toLocaleString()} lines)`,
          description: `Files exceeding ${threshold.toLocaleString()} lines may increase agent retrieval latency, expand context window token consumption, and increase patch ambiguity. This indicates potential navigation cost rather than code quality.`,
          evidence: [
            {
              file: relFile,
              snippet: `${lineCount.toLocaleString()} lines`,
              source: relFile
            }
          ],
          impact: {
            tokens: Math.round(lineCount * 3.5),
            latency: isTestFile ? 2 : 5
          },
          recommendation: isTestFile ? `Consider breaking large test suites into specialized test modules.` : `Consider splitting ${relFile} into smaller cohesive sub-modules to ease agent retrieval.`
        });
      }
    } catch {
    }
  }
  const existingGeneratedDirs = (await fg3(
    GENERATED_DIRS,
    {
      cwd: repoRoot,
      dot: true,
      onlyDirectories: true,
      unique: true,
      ignore: ["**/.git/**", "**/node_modules/**", "**/.venv/**", "**/venv/**"]
    }
  )).sort((a, b) => a.localeCompare(b));
  if (existingGeneratedDirs.length > 0) {
    const instructionFiles = fg3.sync(
      ["**/AGENTS.md", "**/CLAUDE.md", "**/.cursorrules", "**/.cursor/rules/**/*.md", "**/.cursor/rules/**/*.mdc", ".cursor/rules/**/*.md", ".cursor/rules/**/*.mdc"],
      {
        cwd: repoRoot,
        dot: true,
        onlyFiles: true,
        ignore: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          "**/target/**",
          "**/out/**",
          "**/generated/**",
          "**/vendor/**",
          "**/.next/**"
        ]
      }
    );
    let mentionsGeneratedWarning = false;
    for (const inst of instructionFiles) {
      const instPath = path8.join(repoRoot, inst);
      if (fs8.existsSync(instPath)) {
        const text = fs8.readFileSync(instPath, "utf-8").toLowerCase();
        if ((text.includes("generated") || existingGeneratedDirs.some((d) => text.includes(d))) && (text.includes("do not edit") || text.includes("never edit") || text.includes("never manually edit") || text.includes("auto-generated"))) {
          mentionsGeneratedWarning = true;
          break;
        }
      }
    }
    if (!mentionsGeneratedWarning) {
      findings.push({
        id: "repo-unprotected-generated-code",
        ruleId: "repo/generated-code-protection",
        category: "repository",
        severity: "medium",
        confidence: 0.85,
        title: `Unprotected generated directories: ${existingGeneratedDirs.join(", ")}`,
        description: `Repository contains build artifacts (${existingGeneratedDirs.join(", ")}), but instructions do not explicitly warn AI agents not to edit them directly. Coding agents frequently hallucinate edits into build outputs instead of source files.`,
        evidence: existingGeneratedDirs.map((dir) => ({
          file: dir,
          snippet: `Directory ${dir}/ exists`,
          source: "filesystem"
        })),
        recommendation: "Add an explicit rule in AGENTS.md: 'Never manually edit files in generated/ or build output directories.'"
      });
    }
  }
  const workflows = {
    install: false,
    build: false,
    test: false,
    lint: false,
    typecheck: false
  };
  if (profile.ecosystems.includes("python")) {
    workflows.install = fs8.existsSync(path8.join(repoRoot, "requirements.txt")) || fs8.existsSync(path8.join(repoRoot, "pyproject.toml")) || fs8.existsSync(path8.join(repoRoot, "poetry.lock")) || fs8.existsSync(path8.join(repoRoot, "uv.lock"));
    workflows.test = profile.testRoots.length > 0 || fs8.existsSync(path8.join(repoRoot, "pytest.ini")) || (profile.configFiles.python?.includes("pyproject.toml") ?? false);
    workflows.lint = fs8.existsSync(path8.join(repoRoot, ".pre-commit-config.yaml")) || fs8.existsSync(path8.join(repoRoot, "ruff.toml"));
    workflows.build = fs8.existsSync(path8.join(repoRoot, "setup.py")) || (profile.configFiles.python?.includes("pyproject.toml") ?? false);
  }
  if (profile.ecosystems.includes("node")) {
    const packageRelativePath = profile.configFiles.node?.find((file) => path8.basename(file) === "package.json");
    const pkgPath = packageRelativePath ? path8.join(repoRoot, packageRelativePath) : "";
    if (pkgPath && fs8.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs8.readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts || {};
        if (pkg.dependencies || pkg.devDependencies) workflows.install = true;
        if (scripts.build || scripts.compile) workflows.build = true;
        if (scripts.test) workflows.test = true;
        if (scripts.lint) workflows.lint = true;
        if (scripts.typecheck || scripts["type-check"] || scripts.tsc) workflows.typecheck = true;
      } catch {
      }
    }
  }
  if (profile.ecosystems.includes("rust")) {
    workflows.install = true;
    workflows.build = true;
    workflows.test = true;
    workflows.lint = true;
    workflows.typecheck = true;
  }
  if (profile.ecosystems.includes("go")) {
    workflows.install = true;
    workflows.build = true;
    workflows.test = true;
    workflows.lint = true;
    workflows.typecheck = true;
  }
  return {
    findings,
    metrics: {
      totalFiles: sourceFiles.length,
      largeFiles,
      packageRoots: profile.packageRoots,
      hasGeneratedDirs: existingGeneratedDirs,
      workflows
    }
  };
}

// src/analyzers/verification/verificationAnalyzer.ts
import * as fs9 from "fs";
import * as path9 from "path";
import fg4 from "fast-glob";
function findNodePackagePaths(repoRoot, profile) {
  const configured = profile.configFiles.node?.filter((file) => path9.basename(file) === "package.json") || [];
  const candidates = ["package.json", ...configured].filter((file, index, all) => all.indexOf(file) === index);
  return candidates.filter((file) => fs9.existsSync(path9.join(repoRoot, file)));
}
function readNodePackageScripts(repoRoot, profile) {
  const paths = findNodePackagePaths(repoRoot, profile);
  const scripts = {};
  const sources = {};
  const rootScripts = {};
  for (const packagePath of paths) {
    try {
      const pkg = JSON.parse(fs9.readFileSync(path9.join(repoRoot, packagePath), "utf-8"));
      for (const [name, command] of Object.entries(pkg.scripts || {})) {
        if (typeof command === "string" && !scripts[name]) {
          scripts[name] = command;
          sources[name] = packagePath;
        }
        if (packagePath === "package.json" && typeof command === "string") {
          rootScripts[name] = command;
        }
      }
    } catch {
    }
  }
  return { scripts, sources, rootScripts };
}
function isTestScriptName(name) {
  return name === "test" || /^test(?:$|[:.-])/.test(name) || /(?:^|:)test(?:$|[:.-])/.test(name);
}
function isPlaceholderTestCommand(command) {
  return command.includes("no test specified") && command.includes("exit 1");
}
function discoverInstructionFiles(repoRoot) {
  return fg4.sync(
    [
      "**/AGENTS.md",
      "**/CLAUDE.md",
      "**/.cursorrules",
      "**/.cursor/rules/**/*.mdc",
      "**/.cursor/rules/**/*.md",
      ".cursor/rules/**/*.mdc",
      ".cursor/rules/**/*.md",
      "**/.github/copilot-instructions.md"
    ],
    {
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/target/**",
        "**/out/**",
        "**/coverage/**",
        "**/generated/**",
        "**/vendor/**",
        "**/.next/**"
      ]
    }
  ).sort((a, b) => a.localeCompare(b));
}
async function analyzeVerification(repoRoot, profile) {
  const findings = [];
  const fixes = [];
  const statusMap = {
    test: { name: "test", status: "unknown" },
    lint: { name: "lint", status: "unknown" },
    typecheck: { name: "typecheck", status: "not_applicable" },
    build: { name: "build", status: "not_applicable" },
    ci: { name: "ci", status: "unknown" }
  };
  const ciWorkflowsDir = path9.join(repoRoot, ".github", "workflows");
  let ciTestCommand;
  if (fs9.existsSync(ciWorkflowsDir)) {
    try {
      const files = fs9.readdirSync(ciWorkflowsDir).sort((a, b) => a.localeCompare(b));
      for (const cf of files) {
        if (cf.endsWith(".yml") || cf.endsWith(".yaml")) {
          const content = fs9.readFileSync(path9.join(ciWorkflowsDir, cf), "utf-8");
          const runMatch = content.match(
            /run:\s*([^\n#]*(?:test|pytest|cargo\s+test|go\s+test|make\s+test)[^\n#]*)/i
          );
          if (runMatch) {
            ciTestCommand = runMatch[1].trim();
            statusMap.ci = {
              name: "ci",
              status: "healthy",
              command: ciTestCommand,
              source: `.github/workflows/${cf}`,
              detail: `CI runs: "${ciTestCommand}"`
            };
            break;
          }
        }
      }
    } catch {
    }
  }
  if (!ciTestCommand) {
    statusMap.ci = {
      name: "ci",
      status: "warning",
      detail: "No GitHub Actions CI test workflow detected"
    };
  }
  if (profile.primaryEcosystem === "python") {
    const hasPytest = profile.testRoots.length > 0 || fs9.existsSync(path9.join(repoRoot, "pytest.ini")) || fs9.existsSync(path9.join(repoRoot, "tox.ini"));
    let pyprojectHasPytest = false;
    let pyprojectHasMypy = false;
    let pyprojectHasRuff = false;
    let pyprojectHasBuild = false;
    const pyprojectPath = path9.join(repoRoot, "pyproject.toml");
    if (fs9.existsSync(pyprojectPath)) {
      const pyprojectContent = fs9.readFileSync(pyprojectPath, "utf-8");
      if (pyprojectContent.includes("pytest") || pyprojectContent.includes("[tool.pytest")) {
        pyprojectHasPytest = true;
      }
      if (pyprojectContent.includes("mypy") || pyprojectContent.includes("pyright") || pyprojectContent.includes("[tool.mypy")) {
        pyprojectHasMypy = true;
      }
      if (pyprojectContent.includes("ruff") || pyprojectContent.includes("flake8") || pyprojectContent.includes("[tool.ruff")) {
        pyprojectHasRuff = true;
      }
      if (pyprojectContent.includes("[build-system]") || pyprojectContent.includes("build-backend")) {
        pyprojectHasBuild = true;
      }
    }
    if (hasPytest || pyprojectHasPytest) {
      statusMap.test = {
        name: "test",
        status: "healthy",
        command: "pytest",
        detail: "Configured with pytest / test suite"
      };
    } else {
      statusMap.test = {
        name: "test",
        status: "warning",
        detail: "No test configuration (pytest / unittest) found"
      };
      findings.push({
        id: "verif-missing-python-test",
        ruleId: "verification/missing-test",
        category: "verification",
        severity: "high",
        confidence: 0.8,
        title: "Missing test command for Python project",
        description: "No pytest or unittest configuration found. Agents cannot verify code modifications.",
        evidence: [{ file: "pyproject.toml", source: "filesystem" }],
        recommendation: "Add pytest configuration and tests/ directory."
      });
    }
    const hasPrecommit = fs9.existsSync(path9.join(repoRoot, ".pre-commit-config.yaml"));
    if (pyprojectHasRuff || hasPrecommit || fs9.existsSync(path9.join(repoRoot, "ruff.toml"))) {
      statusMap.lint = {
        name: "lint",
        status: "healthy",
        command: pyprojectHasRuff ? "ruff check ." : "pre-commit run",
        detail: "Linter configured (ruff / pre-commit)"
      };
    } else {
      statusMap.lint = {
        name: "lint",
        status: "unknown",
        detail: "No Python linter (ruff, flake8) detected"
      };
    }
    if (pyprojectHasMypy || fs9.existsSync(path9.join(repoRoot, "mypy.ini"))) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "healthy",
        command: "mypy .",
        detail: "Static type checker (mypy/pyright) configured"
      };
    } else {
      statusMap.typecheck = {
        name: "typecheck",
        status: "not_applicable",
        detail: "Type checker (mypy/pyright) not configured for Python project"
      };
    }
    if (pyprojectHasBuild || fs9.existsSync(path9.join(repoRoot, "setup.py"))) {
      statusMap.build = {
        name: "build",
        status: "healthy",
        command: "python -m build",
        detail: "Package build system configured"
      };
    } else {
      statusMap.build = {
        name: "build",
        status: "not_applicable",
        detail: "Application project does not define package build target"
      };
    }
  } else if (profile.primaryEcosystem === "rust") {
    statusMap.test = { name: "test", status: "healthy", command: "cargo test", detail: "Standard Cargo test" };
    statusMap.lint = { name: "lint", status: "healthy", command: "cargo clippy", detail: "Standard Cargo clippy" };
    statusMap.typecheck = { name: "typecheck", status: "healthy", command: "cargo check", detail: "Cargo compiler typecheck" };
    statusMap.build = { name: "build", status: "healthy", command: "cargo build", detail: "Standard Cargo build" };
  } else if (profile.primaryEcosystem === "go") {
    statusMap.test = { name: "test", status: "healthy", command: "go test ./...", detail: "Standard Go test" };
    statusMap.lint = { name: "lint", status: "healthy", command: "go vet ./...", detail: "Standard Go vet" };
    statusMap.typecheck = { name: "typecheck", status: "healthy", command: "go build", detail: "Go compiler typecheck" };
    statusMap.build = { name: "build", status: "healthy", command: "go build ./...", detail: "Standard Go build" };
  } else if (profile.primaryEcosystem === "node" || profile.ecosystems.includes("node")) {
    const packageScriptData = readNodePackageScripts(repoRoot, profile);
    const packageScripts = packageScriptData.scripts;
    const packageScriptSources = packageScriptData.sources;
    const rootTest = Object.entries(packageScriptData.rootScripts).filter(([name]) => isTestScriptName(name)).sort(([a], [b]) => a === "test" ? -1 : b === "test" ? 1 : a.localeCompare(b)).map(([name, command]) => ({ name, command }))[0];
    const nestedTests = Object.entries(packageScripts).filter(([name]) => isTestScriptName(name) && packageScriptSources[name] !== "package.json").sort(([a], [b]) => a === "test" ? -1 : b === "test" ? 1 : a.localeCompare(b)).map(([name, command]) => ({ name, command }));
    const configuredTest = rootTest || nestedTests.find(({ command }) => !isPlaceholderTestCommand(command)) || nestedTests[0];
    if (configuredTest) {
      if (isPlaceholderTestCommand(configuredTest.command)) {
        statusMap.test = {
          name: "test",
          status: "broken",
          command: configuredTest.command,
          detail: "Default unconfigured npm placeholder test script"
        };
        findings.push({
          id: "verif-placeholder-test",
          ruleId: "verification/placeholder-test",
          category: "verification",
          severity: "high",
          confidence: 0.95,
          title: "Placeholder test script fails verification",
          description: 'package.json contains placeholder "exit 1". Any agent running the test suite will fail automatically.',
          evidence: [
            {
              file: packageScriptSources[configuredTest.name] || "package.json",
              snippet: `"${configuredTest.name}": "${configuredTest.command}"`,
              source: packageScriptSources[configuredTest.name] || "package.json"
            }
          ],
          recommendation: "Configure a working test runner (e.g. vitest, jest, or mocha)."
        });
      } else {
        statusMap.test = {
          name: "test",
          status: "healthy",
          command: configuredTest.command,
          detail: `Defined in ${packageScriptSources[configuredTest.name] || "package.json"}: "${configuredTest.command}"`
        };
      }
    } else {
      statusMap.test = {
        name: "test",
        status: "broken",
        detail: "No test script found in package.json"
      };
      findings.push({
        id: "verif-missing-test",
        ruleId: "verification/missing-test",
        category: "verification",
        severity: "high",
        confidence: 0.9,
        title: "Missing test command",
        description: "No test command found in package.json. AI agents cannot verify functional correctness of code modifications without test feedback.",
        evidence: [{ file: "package.json", source: "package.json" }],
        recommendation: "Add a test script (e.g. 'test': 'vitest run') to package.json."
      });
    }
    if (packageScripts.lint) {
      statusMap.lint = {
        name: "lint",
        status: "healthy",
        command: packageScripts.lint,
        detail: `Defined in package.json: "${packageScripts.lint}"`
      };
    } else {
      statusMap.lint = {
        name: "lint",
        status: "unknown",
        detail: "No lint script found"
      };
    }
    const hasTs = fs9.existsSync(path9.join(repoRoot, "tsconfig.json"));
    const typecheckCmd = packageScripts.typecheck || packageScripts["type-check"] || packageScripts.tsc;
    const inferredTypecheck = Object.entries(packageScripts).find(
      ([name, command]) => /type[-:]?check/i.test(name) || /\b(?:tsc|tsgo)\b/.test(command) || hasTs && name === "compile"
    )?.[1];
    if (typecheckCmd || inferredTypecheck) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "healthy",
        command: typecheckCmd || inferredTypecheck,
        detail: typecheckCmd ? `Defined in package.json: "${typecheckCmd}"` : `Inferred from a compiler-backed package script: "${inferredTypecheck}"`
      };
    } else if (hasTs) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "warning",
        detail: "TypeScript project missing explicit typecheck script"
      };
      findings.push({
        id: "verif-missing-typecheck",
        ruleId: "verification/missing-typecheck",
        category: "verification",
        severity: "medium",
        confidence: 0.85,
        title: "TypeScript repository lacks typecheck script",
        description: 'Repository uses TypeScript (tsconfig.json exists) but package.json has no "typecheck" script. Agents need a fast type checking loop (tsc --noEmit) to catch compile errors early.',
        evidence: [{ file: "tsconfig.json", source: "filesystem" }],
        recommendation: 'Add `"typecheck": "tsc --noEmit"` to package.json scripts.'
      });
    } else {
      statusMap.typecheck = {
        name: "typecheck",
        status: "not_applicable",
        detail: "Non-TypeScript JavaScript project"
      };
    }
    if (packageScripts.build) {
      statusMap.build = {
        name: "build",
        status: "healthy",
        command: packageScripts.build,
        detail: `Defined in package.json: "${packageScripts.build}"`
      };
    } else {
      statusMap.build = {
        name: "build",
        status: "not_applicable",
        detail: "No build command defined"
      };
    }
  } else {
    statusMap.test = { name: "test", status: "not_applicable", detail: "No supported ecosystem detected" };
    statusMap.lint = { name: "lint", status: "not_applicable", detail: "No supported ecosystem detected" };
    statusMap.typecheck = { name: "typecheck", status: "not_applicable", detail: "No supported ecosystem detected" };
    statusMap.build = { name: "build", status: "not_applicable", detail: "No supported ecosystem detected" };
  }
  const instructionFiles = discoverInstructionFiles(repoRoot);
  for (const instName of instructionFiles) {
    const instPath = path9.join(repoRoot, instName);
    if (!fs9.existsSync(instPath)) continue;
    const content = fs9.readFileSync(instPath, "utf-8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (profile.primaryEcosystem === "python" && !profile.ecosystems.includes("node")) {
        const npmMatch = line.match(/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test/i);
        if (npmMatch) {
          findings.push({
            id: `verif-ecosystem-mismatch-${instName}-${idx + 1}`,
            ruleId: "verification/ecosystem-command-mismatch",
            category: "verification",
            severity: "high",
            confidence: 0.95,
            title: `Instruction references Node test command in Python repository`,
            description: `${instName} instructs the agent to run "${npmMatch[0]}", but this is a Python repository configured for pytest. Coding agents will fail when running this command.`,
            evidence: [
              {
                file: instName,
                line: idx + 1,
                snippet: line.trim(),
                source: instName
              },
              {
                file: profile.configFiles.python?.[0] || "pyproject.toml",
                snippet: `Primary ecosystem: Python`,
                source: "ProjectProfile"
              }
            ],
            recommendation: `Update instruction to use "pytest" instead of "${npmMatch[0]}".`
          });
        }
      }
      if (ciTestCommand) {
        const cmdMatch = line.match(/(?:(?:`)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([a-zA-Z0-9:\-_]+)(?:`)|(?:run|use)\s+(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([a-zA-Z0-9:\-_]+))/i);
        if (cmdMatch) {
          const fullCmd = cmdMatch[0].replace(/[`]/g, "").trim();
          const scriptName = cmdMatch[1] || cmdMatch[2];
          if (scriptName === "test" && !ciTestCommand.includes(fullCmd)) {
            const fix = createFix({
              id: `fix-ci-mismatch-${instName}-${idx + 1}`,
              title: `Align test command in ${instName} with CI`,
              description: `Update command from "${fullCmd}" to CI standard "${ciTestCommand}"`,
              isSafe: true,
              file: instPath,
              oldText: fullCmd,
              newText: ciTestCommand,
              fullOldContent: content
            });
            fixes.push(fix);
            findings.push({
              id: `verif-ci-mismatch-${instName}-${idx + 1}`,
              ruleId: "verification/command-consistency",
              category: "verification",
              severity: "high",
              confidence: 0.9,
              title: "Verification command mismatch with CI",
              description: `${instName} instructs the agent to run "${fullCmd}", whereas CI runs "${ciTestCommand}". Discrepancies lead to local passes that fail in CI.`,
              evidence: [
                {
                  file: instName,
                  line: idx + 1,
                  snippet: line.trim(),
                  source: instName
                },
                {
                  file: statusMap.ci.source || ".github/workflows",
                  snippet: `CI runs: ${ciTestCommand}`,
                  source: statusMap.ci.source || "CI"
                }
              ],
              recommendation: `Update ${instName} to run "${ciTestCommand}" to match CI.`,
              fix
            });
          }
        }
      }
    });
  }
  return {
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    fixes,
    verificationStatus: ["test", "lint", "typecheck", "build", "ci"].map((name) => statusMap[name])
  };
}

// src/analyzers/runtime/runtimeAnalyzer.ts
import * as fs10 from "fs";
import * as path10 from "path";
import fg5 from "fast-glob";
function parseSessionTrace(content, filePath) {
  try {
    const data = JSON.parse(content);
    const id = data.id || path10.basename(filePath, path10.extname(filePath));
    const agentName = data.agentName || (data.model?.includes("claude") ? "Claude Code" : "Codex");
    const date = data.date || "Today";
    const durationSeconds = data.durationSeconds || 900;
    const filesRead = data.filesRead || [];
    const filesEdited = data.filesEdited || [];
    const searchOperations = data.searchOperations || [];
    const timeline = data.timeline || [];
    let toolCalls = data.toolCalls || timeline.length;
    let failedToolCalls = data.failedToolCalls || timeline.filter((t) => t.status === "failed").length;
    let commandsExecuted = data.commandsExecuted || 0;
    let toolOutputTokens = data.toolOutputTokens || 0;
    const fileReadCounts = {};
    for (const f of filesRead) {
      fileReadCounts[f] = (fileReadCounts[f] || 0) + 1;
    }
    for (const t of timeline) {
      if (t.action.toLowerCase().includes("read ") || t.action.toLowerCase().includes("view ")) {
        const match = t.action.match(/(?:read|view)\s+([a-zA-Z0-9_\-./]+)/i);
        if (match && match[1]) {
          const file = match[1];
          fileReadCounts[file] = (fileReadCounts[file] || 0) + 1;
          if (!filesRead.includes(file)) filesRead.push(file);
        }
      }
      if (t.action.toLowerCase().includes("search ") || t.action.toLowerCase().includes("grep ")) {
        const match = t.action.match(/(?:search|grep)\s+([^\n]+)/i);
        if (match && match[1]) {
          const query = match[1].replace(/['"]/g, "").trim();
          searchOperations.push(query);
        }
      }
      if (t.action.toLowerCase().includes("edit ") || t.action.toLowerCase().includes("write ")) {
        const match = t.action.match(/(?:edit|write)\s+([a-zA-Z0-9_\-./]+)/i);
        if (match && match[1]) {
          const file = match[1];
          if (!filesEdited.includes(file)) filesEdited.push(file);
        }
      }
      if (t.tool === "bash" || t.tool === "command" || t.action.toLowerCase().startsWith("run ") || t.action.toLowerCase().includes("test")) {
        commandsExecuted++;
      }
    }
    const repeatedReads = Object.entries(fileReadCounts).filter(([_, count]) => count >= 3).map(([file, count]) => ({ file, count }));
    const searchCounts = {};
    for (const s of searchOperations) {
      const norm = s.toLowerCase().trim();
      searchCounts[norm] = (searchCounts[norm] || 0) + 1;
    }
    const repeatedSearches = Object.entries(searchCounts).filter(([_, count]) => count >= 2).map(([query, count]) => ({ query, count }));
    const failedCmdCounts = {};
    for (const t of timeline) {
      if (t.status === "failed") {
        failedCmdCounts[t.action] = (failedCmdCounts[t.action] || 0) + 1;
      }
    }
    const repeatedFailures = Object.entries(failedCmdCounts).filter(([_, count]) => count >= 2).map(([command, count]) => ({ command, count }));
    const tokenUsage = data.tokenUsage || {
      input: 65e3,
      output: 12e3,
      total: 77e3
    };
    const sessionScore = Math.max(
      30,
      Math.min(
        98,
        100 - repeatedReads.length * 8 - repeatedSearches.length * 6 - repeatedFailures.length * 12 - Math.min(20, Math.floor(failedToolCalls * 2))
      )
    );
    return {
      id,
      agentName,
      date,
      efficiencyScore: sessionScore,
      durationSeconds,
      tokenUsage,
      toolCalls,
      failedToolCalls,
      commandsExecuted,
      filesRead,
      filesEdited,
      searchOperations,
      toolOutputTokens: toolOutputTokens || 12e3,
      timeline,
      repeatedReads,
      repeatedSearches,
      repeatedFailures
    };
  } catch {
    return null;
  }
}
async function analyzeRuntimeSessions(repoRoot, explicitSessionPath) {
  const findings = [];
  const sessions = [];
  const candidatePaths = [];
  if (explicitSessionPath && fs10.existsSync(explicitSessionPath)) {
    candidatePaths.push(explicitSessionPath);
  } else {
    const sessionFiles = await fg5(
      [
        ".agent/sessions/*.json",
        ".claude/sessions/*.json",
        ".sessions/*.json",
        "sessions/*.json"
      ],
      { cwd: repoRoot, dot: true, onlyFiles: true }
    );
    for (const f of sessionFiles.sort((a, b) => a.localeCompare(b))) {
      candidatePaths.push(path10.join(repoRoot, f));
    }
  }
  for (const p of candidatePaths) {
    try {
      const content = fs10.readFileSync(p, "utf-8");
      const session = parseSessionTrace(content, p);
      if (session) {
        sessions.push(session);
        for (const rr of session.repeatedReads) {
          findings.push({
            id: `runtime-repeated-read-${rr.file.replace(/[^a-zA-Z0-9]/g, "-")}`,
            ruleId: "runtime/repeated-file-retrieval",
            category: "runtime",
            severity: "medium",
            confidence: 0.9,
            title: `Repeated file retrieval: ${rr.file} (${rr.count} times)`,
            description: `${rr.file} was read ${rr.count} times in session ${session.id}. AI agents repeatedly retrieve files when instruction context lacks clear summaries or architectural relationships.`,
            evidence: [
              {
                file: rr.file,
                snippet: `Retrieved ${rr.count} times in session ${session.id}`,
                source: path10.relative(repoRoot, p)
              }
            ],
            impact: {
              tokens: rr.count * 1200,
              latency: rr.count * 3
            },
            recommendation: `Add module summary or export structure of ${rr.file} to repository context docs so agent remembers interface without re-reading.`
          });
        }
        for (const rs of session.repeatedSearches) {
          findings.push({
            id: `runtime-repeated-search-${rs.query.replace(/[^a-zA-Z0-9]/g, "-")}`,
            ruleId: "runtime/repeated-searches",
            category: "runtime",
            severity: "medium",
            confidence: 0.85,
            title: `Repeated search operations for "${rs.query}" (${rs.count} times)`,
            description: `Agent executed ${rs.count} repetitive search queries for "${rs.query}". Indicates poor directory discoverability or lack of documentation of key service locations.`,
            evidence: [
              {
                file: path10.relative(repoRoot, p),
                snippet: `Query "${rs.query}" repeated ${rs.count} times`,
                source: "session trace"
              }
            ],
            recommendation: `Document the entry point or implementation directory for "${rs.query}" in AGENTS.md.`
          });
        }
        for (const rf of session.repeatedFailures) {
          findings.push({
            id: `runtime-repeated-failure-${rf.command.replace(/[^a-zA-Z0-9]/g, "-")}`,
            ruleId: "runtime/repeated-command-failures",
            category: "runtime",
            severity: "high",
            confidence: 0.95,
            title: `Repeated failed command: "${rf.command}" (${rf.count} times)`,
            description: `Same command failed ${rf.count} times in session without successful configuration adjustments. Agent wasted turns in trial-and-error loop.`,
            evidence: [
              {
                file: path10.relative(repoRoot, p),
                snippet: `Command "${rf.command}" failed ${rf.count} times`,
                source: "session trace"
              }
            ],
            impact: {
              reliability: 8
            },
            recommendation: `Verify prerequisites for running "${rf.command}" or provide pre-run setup script in AGENTS.md.`
          });
        }
        if (session.toolOutputTokens > 2e4) {
          findings.push({
            id: `runtime-oversized-output-${session.id}`,
            ruleId: "runtime/oversized-tool-output",
            category: "runtime",
            severity: "medium",
            confidence: 0.85,
            title: `Tool output bloat detected (${session.toolOutputTokens.toLocaleString()} tokens)`,
            description: `Tool outputs consumed ${session.toolOutputTokens.toLocaleString()} tokens in session ${session.id}. Unfiltered logs or full build outputs flood agent context and dilute attention.`,
            evidence: [
              {
                file: path10.relative(repoRoot, p),
                snippet: `${session.toolOutputTokens.toLocaleString()} tool output tokens`,
                source: "session trace"
              }
            ],
            impact: {
              tokens: session.toolOutputTokens - 4e3
            },
            recommendation: "Configure commands with quiet flags (e.g. `vitest run --reporter=basic` or `pnpm test --silent`)."
          });
        }
      }
    } catch {
    }
  }
  sessions.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id));
  return { findings, sessions };
}

// src/core/score/calculator.ts
var SEVERITY_DEDUCTIONS = {
  critical: 25,
  high: 12,
  medium: 6,
  low: 2
};
var DEFAULT_CONFIDENCE = 1;
var DEFAULT_GROUP_CAP = 35;
var OVERSIZED_GROUP_CAP = 25;
function effectiveConfidence(finding) {
  if (typeof finding.confidence !== "number" || Number.isNaN(finding.confidence)) {
    return DEFAULT_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, finding.confidence));
}
function findingImpact(finding) {
  return (SEVERITY_DEDUCTIONS[finding.severity] || 0) * effectiveConfidence(finding);
}
function groupCap(groupKey) {
  return groupKey.includes("large-file") || groupKey.includes("oversized-source-file") ? OVERSIZED_GROUP_CAP : DEFAULT_GROUP_CAP;
}
function countFindingsBySeverity(findings, category) {
  const flatFindings = flattenFindings(findings).filter((finding) => finding.category === category);
  return {
    critical: flatFindings.filter((f) => f.severity === "critical").length,
    high: flatFindings.filter((f) => f.severity === "high").length,
    medium: flatFindings.filter((f) => f.severity === "medium").length,
    low: flatFindings.filter((f) => f.severity === "low").length
  };
}
function calculateCategoryScore(category, findings, signalDensity) {
  const grouped = /* @__PURE__ */ new Map();
  for (const finding of flattenFindings(findings)) {
    if (finding.category !== category) continue;
    const key = finding.groupKey || finding.ruleId;
    const group = grouped.get(key) || [];
    group.push(finding);
    grouped.set(key, group);
  }
  let deductions = 0;
  for (const [key, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const weightedDeduction = [...group].sort((a, b) => findingImpact(b) - findingImpact(a) || (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id)).reduce((sum, finding, index) => {
      const rank = index + 1;
      return sum + findingImpact(finding) / Math.sqrt(rank);
    }, 0);
    deductions += Math.min(groupCap(key), weightedDeduction);
  }
  const rawScore = Math.max(0, 100 - deductions);
  if (category === "context" && signalDensity && signalDensity.totalTokens > 0) {
    const blended = 0.5 * rawScore + 0.5 * signalDensity.densityPercent;
    return Math.min(100, Math.max(0, Math.round(blended)));
  }
  return Math.min(100, Math.max(0, Math.round(rawScore)));
}
function hasApplicableVerificationItems(items) {
  return Boolean(items?.some((item) => item.status !== "not_applicable"));
}
function calculateEfficiencyScore(findings, signalDensity, hasRuntimeData, verificationStatus) {
  const contextScoreVal = calculateCategoryScore("context", findings, signalDensity);
  const repoScoreVal = calculateCategoryScore("repository", findings);
  const verifScoreVal = calculateCategoryScore("verification", findings);
  const runtimeScoreVal = hasRuntimeData ? calculateCategoryScore("runtime", findings) : void 0;
  let contextWeight = 0.35;
  let repoWeight = 0.2;
  let verifWeight = 0.2;
  const runtimeWeight = 0.25;
  let overallScore;
  let scoreExplanation;
  if (hasRuntimeData && runtimeScoreVal !== void 0) {
    overallScore = contextScoreVal * contextWeight + repoScoreVal * repoWeight + verifScoreVal * verifWeight + runtimeScoreVal * runtimeWeight;
    scoreExplanation = "Full assessment (4 of 4 dimensions evaluated)";
  } else {
    const totalStaticWeight = contextWeight + repoWeight + verifWeight;
    contextWeight /= totalStaticWeight;
    repoWeight /= totalStaticWeight;
    verifWeight /= totalStaticWeight;
    overallScore = contextScoreVal * contextWeight + repoScoreVal * repoWeight + verifScoreVal * verifWeight;
    scoreExplanation = "Based on 3 of 4 dimensions (Runtime session data unavailable)";
  }
  const scores = {
    context: {
      score: contextScoreVal,
      weight: Number(contextWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "context")
    },
    repository: {
      score: repoScoreVal,
      weight: Number(repoWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "repository")
    },
    verification: {
      score: verifScoreVal,
      weight: Number(verifWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "verification"),
      metrics: {
        applicableChecks: verificationStatus?.filter((item) => item.status !== "not_applicable").length ?? 0,
        notApplicableChecks: verificationStatus?.filter((item) => item.status === "not_applicable").length ?? 0
      }
    },
    runtime: hasRuntimeData && runtimeScoreVal !== void 0 ? {
      score: runtimeScoreVal,
      weight: Number(runtimeWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "runtime")
    } : null
  };
  if (!hasApplicableVerificationItems(verificationStatus)) {
    scores.verification.metrics = {
      ...scores.verification.metrics || {},
      applicableChecks: 0,
      notApplicableChecks: verificationStatus?.length ?? 0
    };
  }
  return {
    overallScore: Math.round(overallScore),
    scoreExplanation,
    scores
  };
}

// src/core/findings/aggregator.ts
function aggregateFindings(findings) {
  const groups = /* @__PURE__ */ new Map();
  for (const f of ensureFindingFingerprints(findings)) {
    const key = f.groupKey || f.ruleId;
    const list = groups.get(key) || [];
    list.push(f);
    groups.set(key, list);
  }
  const aggregated = [];
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, unsortedItems] of sortedGroups) {
    const items = [...unsortedItems].sort(
      (a, b) => (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id) || a.id.localeCompare(b.id)
    );
    if (items.length === 1) {
      aggregated.push(items[0]);
      continue;
    }
    const severities = items.map((i) => i.severity);
    const severity = severities.includes("critical") ? "critical" : severities.includes("high") ? "high" : severities.includes("medium") ? "medium" : "low";
    const avgConfidence = Number(
      (items.reduce((sum, i) => sum + i.confidence, 0) / items.length).toFixed(2)
    );
    const totalTokenImpact = items.reduce(
      (sum, i) => sum + (i.impact?.tokens || 0),
      0
    );
    let title = `${items.length} ${items[0].title}`;
    let description = items[0].description;
    if (key.includes("large-file") || key.includes("oversized-source-file")) {
      title = `${items.length} oversized source files may increase agent retrieval cost`;
      const topItems = [...items].sort((a, b) => (b.impact?.tokens || 0) - (a.impact?.tokens || 0)).slice(0, 3);
      const topSummary = topItems.map((t) => `${t.evidence[0]?.file || t.title} (${t.evidence[0]?.snippet || ""})`).join("; ");
      description = `Found ${items.length} large source files. Large files increase token expenditure and edit ambiguity for AI agents. Largest: ${topSummary}`;
    } else if (key.includes("stale-path")) {
      title = `${items.length} unresolved or stale path references in instructions`;
      const topItems = items.slice(0, 3).map((t) => t.evidence[0]?.snippet || t.title).join(", ");
      description = `Instructions reference ${items.length} paths that could not be resolved in the repository: ${topItems}`;
    } else if (key.includes("duplicate-instruction")) {
      title = `${items.length} duplicate instruction rules detected across context files`;
      description = `Detected ${items.length} redundant or repetitive instruction blocks that dilute agent context signal density.`;
    }
    const aggregatedEvidence = items.slice(0, 5).flatMap((i) => i.evidence).filter((evidence, index, all) => {
      const key2 = `${evidence.file}|${evidence.line || ""}|${evidence.snippet || ""}`;
      return all.findIndex(
        (candidate) => `${candidate.file}|${candidate.line || ""}|${candidate.snippet || ""}` === key2
      ) === index;
    }).sort((a, b) => {
      const fileCompare = a.file.localeCompare(b.file);
      if (fileCompare !== 0) return fileCompare;
      return (a.line || 0) - (b.line || 0) || (a.endLine || 0) - (b.endLine || 0) || (a.snippet || "").localeCompare(b.snippet || "") || (a.source || "").localeCompare(b.source || "");
    });
    aggregated.push({
      id: `group-${key}`,
      fingerprint: createGroupFingerprint(items[0].ruleId, key),
      ruleId: items[0].ruleId,
      category: items[0].category,
      severity,
      confidence: avgConfidence,
      needsReview: avgConfidence < 0.8,
      title,
      description,
      evidence: aggregatedEvidence,
      impact: {
        tokens: totalTokenImpact || void 0
      },
      recommendation: items[0].recommendation,
      groupKey: key,
      children: items
    });
  }
  return aggregated.sort((a, b) => {
    const categoryCompare = a.category.localeCompare(b.category);
    if (categoryCompare !== 0) return categoryCompare;
    const ruleCompare = a.ruleId.localeCompare(b.ruleId);
    if (ruleCompare !== 0) return ruleCompare;
    return (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id);
  });
}

// src/core/prompt/promptGenerator.ts
function getRuleSpecificGuidance(ruleId) {
  const lowerRule = ruleId.toLowerCase();
  if (lowerRule.includes("stale-path") || lowerRule.includes("unresolved-path")) {
    return {
      constraints: [
        "\u68C0\u67E5\u5F15\u7528\u7684\u8DEF\u5F84\u662F\u5426\u5B58\u5728\uFF0C\u68C0\u67E5\u5F53\u524D\u76EE\u5F55\u7ED3\u6784\u548C Git \u5386\u53F2\u8BB0\u5F55",
        "\u5224\u65AD\u8BE5\u8DEF\u5F84\u662F\u5DF2\u88AB\u5220\u9664\u3001\u91CD\u547D\u540D/\u79FB\u52A8\uFF0C\u8FD8\u662F\u6307\u4EE4\u4E66\u5199\u62FC\u5199\u9519\u8BEF (typo)",
        "\u5C06 instruction \u4E2D\u7684\u8DEF\u5F84\u66F4\u65B0\u4E3A\u5F53\u524D\u6700\u65B0\u6709\u6548\u8DEF\u5F84\uFF0C\u6216\u79FB\u9664\u5BF9\u5DF2\u5220\u9664\u6A21\u5757\u7684\u8FC7\u65F6\u8BF4\u660E",
        "\u4E25\u7981\u51ED\u731C\u6D4B\u968F\u610F\u66FF\u6362\u8DEF\u5F84\uFF1B\u5982\u65E0\u6CD5\u4ECE\u4ED3\u5E93\u786E\u8BA4\u771F\u5B9E\u610F\u56FE\uFF0C\u8BF7\u8BF4\u660E\u51B2\u7A81\u5E76\u4FDD\u7559\u6CE8\u91CA"
      ],
      verification: [
        "\u786E\u4FDD\u4FEE\u6539\u540E\u6587\u6863\u4E2D\u5F15\u7528\u7684\u6240\u6709\u6587\u4EF6\u6216\u76EE\u5F55\u5728\u5F53\u524D\u4ED3\u5E93\u4E2D\u771F\u5B9E\u5B58\u5728",
        "\u4FDD\u6301\u539F\u6709\u6587\u6863\u683C\u5F0F\u4E0E\u98CE\u683C\uFF0C\u4E0D\u5F15\u5165\u65E0\u5173\u4FEE\u6539"
      ]
    };
  }
  if (lowerRule.includes("duplicate-instruction")) {
    return {
      constraints: [
        "\u627E\u51FA\u591A\u4E2A\u91CD\u590D\u6216\u8BED\u4E49\u9AD8\u5EA6\u91CD\u53E0\u7684 instruction \u89C4\u5219",
        "\u660E\u786E\u54EA\u4E00\u4E2A\u6587\u4EF6\u5E94\u4F5C\u4E3A\u5355\u4E00\u4E8B\u5B9E\u6765\u6E90\uFF08Source of Truth\uFF0C\u901A\u5E38\u4E3A AGENTS.md\uFF09",
        "\u5220\u9664\u8DE8\u6587\u4EF6\u6216\u540C\u6587\u4EF6\u5185\u7684\u5197\u4F59\u91CD\u590D\u5185\u5BB9",
        "\u4FDD\u7559\u7279\u5B9A Agent \u6216\u5DE5\u5177\u4E13\u7528\u7684\u5DEE\u5F02\u5316\u914D\u7F6E\uFF0C\u4E0D\u8981\u5C06\u4E0D\u540C\u4E0A\u4E0B\u6587\u673A\u68B0\u7C97\u66B4\u5408\u5E76"
      ],
      verification: [
        "\u786E\u8BA4\u91CD\u590D\u89C4\u5219\u5DF2\u6709\u6548\u6574\u5408\uFF0C\u4E0D\u518D\u5B58\u5728\u5197\u4F59 Token \u6D88\u8017",
        "\u786E\u4FDD\u5173\u952E\u89C4\u5219\u8BED\u4E49\u5B8C\u6574\uFF0C\u672A\u9057\u6F0F\u539F\u6709\u7EA6\u675F"
      ]
    };
  }
  if (lowerRule.includes("verification") || lowerRule.includes("command-mismatch") || lowerRule.includes("command-consistency") || lowerRule.includes("missing-test") || lowerRule.includes("missing-typecheck")) {
    return {
      constraints: [
        "\u5BF9\u6BD4 instruction \u8BF4\u660E\u3001\u9879\u76EE\u914D\u7F6E\u6587\u4EF6\uFF08\u5982 package.json\u3001Makefile\u3001pyproject.toml \u7B49\uFF09\u4E0E CI \u5DE5\u4F5C\u6D41\u914D\u7F6E",
        "\u786E\u8BA4\u5F53\u524D\u4ED3\u5E93\u771F\u5B9E\u3001\u53D7\u652F\u6301\u7684\u9A8C\u8BC1\u4E0E\u6D4B\u8BD5\u547D\u4EE4",
        "\u4F18\u5148\u5C06 instruction \u4E2D\u7684\u63CF\u8FF0\u4E0E\u5B9E\u9645\u5DE5\u7A0B\u5DE5\u4F5C\u6D41\u540C\u6B65",
        "\u4E0D\u8981\u4E3A\u4E86\u8BA9\u6587\u6863\u770B\u8D77\u6765\u6B63\u786E\u800C\u968F\u610F\u4FEE\u6539\u5DF2\u6709\u4E14\u6B63\u5E38\u8FD0\u884C\u7684\u6D4B\u8BD5\u3001\u6784\u5EFA\u6216 CI \u914D\u7F6E"
      ],
      verification: [
        "\u5728\u672C\u5730\u7EC8\u7AEF\u6267\u884C\u4FEE\u6B63\u540E\u7684\u9A8C\u8BC1\u547D\u4EE4\uFF0C\u786E\u4FDD\u547D\u4EE4\u80FD\u6B63\u5E38\u8FD0\u884C\u5E76\u901A\u8FC7",
        "instruction\u3001\u914D\u7F6E\u6587\u4EF6\u4E0E CI \u4E2D\u7684\u547D\u4EE4\u5B9A\u4E49\u4FDD\u6301\u5B8C\u5168\u4E00\u81F4"
      ]
    };
  }
  if (lowerRule.includes("oversized-source-file") || lowerRule.includes("large-file")) {
    return {
      constraints: [
        "\u8BF7\u5206\u6790\u8BE5\u5927\u578B\u6587\u4EF6\u662F\u5426\u771F\u7684\u5BF9 Agent \u68C0\u7D22\u3001\u5BFC\u822A\u548C\u5C40\u90E8\u4FEE\u6539\u9020\u6210\u4E25\u91CD\u56F0\u96BE",
        "\u5148\u8BC4\u4F30\uFF1A\u6587\u4EF6\u662F\u5426\u5305\u542B\u591A\u4E2A\u72EC\u7ACB\u804C\u8D23\uFF1F\u662F\u5426\u5B58\u5728\u8D85\u5927\u51FD\u6570\u6216\u7C7B\uFF1F\u662F\u5426\u6709\u660E\u786E\u6A21\u5757\u8FB9\u754C\uFF1F\u662F\u5426\u9002\u5408\u62C6\u5206\uFF1F",
        "\u5982\u679C\u62C6\u5206\u6536\u76CA\u6709\u9650\u6216\u98CE\u9669\u8FC7\u9AD8\uFF0C\u4E0D\u8981\u5355\u7EAF\u4E3A\u4E86\u964D\u4F4E\u884C\u6570\u800C\u5F3A\u884C\u91CD\u6784",
        "\u5982\u51B3\u5B9A\u62C6\u5206\uFF0C\u91C7\u7528\u589E\u91CF\u6700\u5C0F\u5207\u5206\u539F\u5219\uFF0C\u4FDD\u6301\u6240\u6709\u516C\u5F00\u5BFC\u51FA\u7B26\u53F7\u4E0E\u51FD\u6570\u7B7E\u540D\u7684\u5411\u540E\u517C\u5BB9"
      ],
      verification: [
        "\u8FD0\u884C\u9879\u76EE\u73B0\u6709\u6D4B\u8BD5\u5957\u4EF6\u4E0E\u7C7B\u578B\u68C0\u67E5\uFF0C\u786E\u4FDD\u529F\u80FD\u4E0E\u63A5\u53E3\u884C\u4E3A\u65E0\u7834\u574F",
        "\u786E\u4FDD\u6240\u6709\u8C03\u7528\u70B9\u4E0E\u5BFC\u51FA\u7B26\u53F7\u5B8C\u5168\u4E00\u81F4"
      ]
    };
  }
  if (lowerRule.includes("conflicting-instructions") || lowerRule.includes("version-conflict")) {
    return {
      constraints: [
        "\u68C0\u67E5\u76F8\u5173\u6587\u4EF6\uFF0C\u786E\u8BA4\u5F53\u524D\u9879\u76EE\u5B9E\u9645\u8981\u6C42\u7684\u8FD0\u884C\u65F6\u73AF\u5883\u6216\u4F9D\u8D56\u7248\u672C",
        "\u5982\u679C\u9879\u76EE\u914D\u7F6E\u6587\u4EF6\u4E0E CI \u5747\u4EE3\u8868\u5F53\u524D\u771F\u5B9E\u914D\u7F6E\uFF0C\u5C06\u6587\u6863\u4E2D\u7684\u65E7\u8981\u6C42\u540C\u6B65\u66F4\u65B0\u4E3A\u771F\u5B9E\u7248\u672C",
        "\u4E0D\u8981\u4FEE\u6539\u4ED3\u5E93\u914D\u7F6E\u6587\u4EF6\u6216 CI\uFF0C\u9664\u975E\u6709\u786E\u51FF\u8BC1\u636E\u8868\u660E\u914D\u7F6E\u6587\u4EF6\u672C\u8EAB\u6709\u8BEF",
        "\u4FDD\u6301\u539F\u6709\u6587\u6863\u7ED3\u6784\u4E0E\u98CE\u683C\uFF0C\u4FEE\u6539\u5B8C\u6210\u540E\u5C55\u793A\u5177\u4F53 diff",
        "\u5982\u679C\u65E0\u6CD5\u4ECE\u8BC1\u636E\u786E\u5B9A\u6B63\u786E\u7248\u672C\uFF0C\u4E0D\u8981\u731C\u6D4B\uFF0C\u8BF7\u660E\u786E\u8BF4\u660E\u8BC1\u636E\u51B2\u7A81"
      ],
      verification: [
        "\u6587\u6863\u3001\u914D\u7F6E\u6587\u4EF6\u4E0E CI \u4E2D\u7684\u7248\u672C\u8981\u6C42\u4FDD\u6301\u4E00\u81F4",
        "\u4E0D\u5F15\u5165\u989D\u5916\u65E0\u5173\u4FEE\u6539"
      ]
    };
  }
  return {
    constraints: [
      "\u53EA\u4FEE\u6539\u89E3\u51B3\u8BE5\u95EE\u9898\u6240\u9700\u7684\u6587\u4EF6",
      "\u4E0D\u8981\u8FDB\u884C\u65E0\u5173\u91CD\u6784",
      "\u4E0D\u8981\u5220\u9664\u65E0\u6CD5\u786E\u8BA4\u7528\u9014\u7684\u4EE3\u7801\u6216\u914D\u7F6E",
      "\u4F18\u5148\u4F7F\u7528\u4ED3\u5E93\u4E2D\u7684\u771F\u5B9E\u914D\u7F6E\u4F5C\u4E3A\u8BC1\u636E",
      "\u5982\u679C\u8BC1\u636E\u4E0D\u8DB3\uFF0C\u4E0D\u8981\u731C\u6D4B",
      "\u4FEE\u6539\u5B8C\u6210\u540E\u5C55\u793A diff"
    ],
    verification: [
      "\u8FD0\u884C\u4ED3\u5E93\u4E2D\u73B0\u6709\u7684\u9A8C\u8BC1\u547D\u4EE4\uFF08\u6D4B\u8BD5\u3001\u7C7B\u578B\u68C0\u67E5\u3001\u6784\u5EFA\u7B49\uFF09\u786E\u4FDD\u672A\u5F15\u5165\u7834\u574F",
      "\u786E\u8BA4\u4FEE\u6539\u7CBE\u51C6\u89E3\u51B3\u4E0A\u8FF0 Finding\uFF0C\u4E14\u672A\u5F15\u5165\u989D\u5916\u6539\u52A8"
    ]
  };
}
function formatEvidenceSnippet(ev) {
  const loc = ev.file + (ev.line ? `:${ev.line}` : "");
  if (!ev.snippet && !ev.source) {
    return `- \u4F4D\u7F6E: \`${loc}\``;
  }
  const cleanSnippet = (ev.snippet || ev.source || "").trim().slice(0, 300);
  return `- \u4F4D\u7F6E: \`${loc}\`
  \u8BC1\u636E\u5185\u5BB9: "${cleanSnippet}"`;
}
function buildFixPromptContext(finding) {
  const guidance = getRuleSpecificGuidance(finding.ruleId);
  const locations = finding.evidence.map((ev) => ({
    file: ev.file,
    line: ev.line
  }));
  return {
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    description: finding.description,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    locations,
    constraints: guidance.constraints,
    verification: guidance.verification
  };
}
function generateFixPrompt(finding) {
  const ctx = buildFixPromptContext(finding);
  const evidenceText = ctx.evidence.length > 0 ? ctx.evidence.map(formatEvidenceSnippet).join("\n") : "- \u65E0\u5177\u4F53\u884C\u53F7\u8BC1\u636E\uFF0C\u57FA\u4E8E\u4ED3\u5E93\u5168\u5C40\u914D\u7F6E\u6216\u7ED3\u6784\u63A8\u5BFC\u3002";
  const constraintsText = ctx.constraints && ctx.constraints.length > 0 ? ctx.constraints.map((c) => `- ${c}`).join("\n") : "- \u53EA\u4FEE\u6539\u89E3\u51B3\u8BE5\u95EE\u9898\u6240\u9700\u7684\u6587\u4EF6\n- \u4E0D\u8981\u8FDB\u884C\u65E0\u5173\u91CD\u6784\n- \u4FEE\u6539\u5B8C\u6210\u540E\u5C55\u793A diff";
  const verificationText = ctx.verification && ctx.verification.length > 0 ? ctx.verification.map((v) => `- ${v}`).join("\n") : "- \u8FD0\u884C\u6D4B\u8BD5\u548C\u68C0\u67E5\u6D41\u7A0B\u9A8C\u8BC1\u4FEE\u590D\u7ED3\u679C";
  const recommendationText = ctx.recommendation || "\u6839\u636E\u4E0A\u8FF0\u8BC1\u636E\u5206\u6790\u5E76\u6D88\u9664\u8BE5\u95EE\u9898\u3002";
  return `\u8BF7\u4FEE\u590D\u5F53\u524D\u4ED3\u5E93\u4E2D\u7684\u4EE5\u4E0B AgentDoctor Finding\u3002

## \u95EE\u9898

${ctx.title}

Severity: ${ctx.severity.toUpperCase()}
Confidence: ${Math.round(ctx.confidence * 100)}%

## \u8BC1\u636E

${evidenceText}

## \u4E3A\u4EC0\u4E48\u8FD9\u662F\u95EE\u9898

${ctx.description}

## \u4FEE\u590D\u76EE\u6807

${recommendationText}

## \u8981\u6C42

${constraintsText}

## \u9A8C\u8BC1

${verificationText}
`.trim();
}

// src/core/scan/scanner.ts
async function scanRepository(options = {}) {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const repositoryName = path11.basename(repoRoot);
  const branch = getGitBranch(repoRoot);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const projectProfile = detectProjectProfile(repoRoot);
  const contextResult = await analyzeContext(repoRoot, {
    gitHistoryRoot: options.gitHistoryRoot,
    gitRef: options.gitRef
  });
  const repoResult = await analyzeRepository(repoRoot, projectProfile);
  const verifResult = await analyzeVerification(repoRoot, projectProfile);
  const runtimeResult = options.includeRuntime === false ? { findings: [], sessions: [] } : await analyzeRuntimeSessions(repoRoot, options.sessionPath);
  const allFindings = [
    ...contextResult.findings,
    ...repoResult.findings,
    ...verifResult.findings,
    ...runtimeResult.findings
  ];
  const aggregatedFindings = aggregateFindings(allFindings);
  for (const f of aggregatedFindings) {
    f.fixPrompt = generateFixPrompt(f);
    if (f.children) {
      for (const child of f.children) {
        child.fixPrompt = generateFixPrompt(child);
      }
    }
  }
  const allFixes = [
    ...contextResult.fixes,
    ...verifResult.fixes
  ];
  const uniqueFixes = [...new Map(allFixes.map((fix) => [fix.id, fix])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const hasRuntimeData = runtimeResult.sessions.length > 0;
  const { overallScore, scoreExplanation, scores } = calculateEfficiencyScore(
    aggregatedFindings,
    contextResult.signalDensity,
    hasRuntimeData,
    verifResult.verificationStatus
  );
  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    repositoryName,
    repositoryRoot: repoRoot,
    branch,
    timestamp,
    projectProfile,
    overallScore,
    scoreExplanation,
    scores,
    contextSignalDensity: contextResult.signalDensity,
    verificationStatus: verifResult.verificationStatus,
    sessions: runtimeResult.sessions,
    findings: aggregatedFindings,
    availableFixes: uniqueFixes,
    metadata: {
      schemaVersion: SCAN_SCHEMA_VERSION,
      scannedFilesCount: contextResult.scannedFiles.length + repoResult.metrics.totalFiles,
      scanDurationMs: Math.max(0, Date.now() - startedAt),
      hasRuntimeData,
      aiEnabled: options.enableAi || false
    }
  };
}

// src/core/regression/comparator.ts
var SEVERITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};
var VERIFICATION_STATUS_RANK = {
  not_applicable: -1,
  healthy: 0,
  warning: 1,
  // Unknown is an absence of evidence, not proof that a previously healthy
  // loop became broken. It therefore does not create a CI regression by
  // itself; a concrete warning or broken status does.
  unknown: 0,
  broken: 2
};
function severityAtLeast(severity, threshold) {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}
function isSeverityAtLeast(severity, threshold) {
  return threshold ? severityAtLeast(severity, threshold) : false;
}
function wastefulTokens(result) {
  if (typeof result.contextSignalDensity.wastefulTokens === "number") {
    return result.contextSignalDensity.wastefulTokens;
  }
  const density = result.contextSignalDensity;
  return density.duplicateTokens + density.inferableTokens + density.staleTokens + density.lowValueTokens;
}
function findingTitle(finding) {
  if (finding.ruleId === "context/stale-path" || finding.ruleId === "context/unresolved-path") {
    return "stale instruction";
  }
  if (finding.ruleId === "verification/command-consistency" || finding.ruleId === "verification/ecosystem-command-mismatch") {
    return "verification mismatch";
  }
  return finding.title;
}
function findingRegression(finding, reason) {
  const fingerprint = finding.fingerprint || createFindingFingerprint(finding);
  return {
    kind: "new-finding",
    severity: finding.severity,
    title: findingTitle(finding),
    detail: reason,
    fingerprint,
    evidence: finding.evidence
  };
}
function compareFindings(baseline, head) {
  const baselineFindings = /* @__PURE__ */ new Map();
  for (const finding of flattenFindings(baseline.findings)) {
    if (finding.category === "runtime") continue;
    baselineFindings.set(finding.fingerprint || createFindingFingerprint(finding), finding);
  }
  const regressions = [];
  for (const finding of flattenFindings(head.findings)) {
    if (finding.category === "runtime") continue;
    const fingerprint = finding.fingerprint || createFindingFingerprint(finding);
    const previous = baselineFindings.get(fingerprint);
    if (!previous) {
      regressions.push(findingRegression(finding, finding.description));
      continue;
    }
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[previous.severity]) {
      regressions.push(findingRegression(
        finding,
        `Severity increased from ${previous.severity.toUpperCase()} to ${finding.severity.toUpperCase()}.`
      ));
    }
  }
  return regressions;
}
function compareVerification(baseline, head) {
  const baselineItems = new Map(baseline.verificationStatus.map((item) => [item.name, item]));
  const regressions = [];
  for (const current of head.verificationStatus) {
    const previous = baselineItems.get(current.name);
    if (!previous) continue;
    if (previous.status === "not_applicable" || current.status === "not_applicable") continue;
    if (VERIFICATION_STATUS_RANK[current.status] > VERIFICATION_STATUS_RANK[previous.status]) {
      const severity = current.status === "broken" ? "high" : "medium";
      regressions.push({
        kind: "verification",
        severity,
        title: "verification mismatch",
        detail: `${current.name} changed from ${previous.status} to ${current.status}${current.command ? ` (${current.command})` : ""}.`,
        evidence: current.source ? [{ file: current.source, snippet: current.detail }] : void 0
      });
    }
  }
  return regressions;
}
function compareContext(baseline, head) {
  const totalTokens = head.contextSignalDensity.totalTokens - baseline.contextSignalDensity.totalTokens;
  const wastefulTokenDelta = wastefulTokens(head) - wastefulTokens(baseline);
  const densityPercent = Number(
    (head.contextSignalDensity.densityPercent - baseline.contextSignalDensity.densityPercent).toFixed(1)
  );
  const shouldReport = totalTokens >= 100 || wastefulTokenDelta > 0 || densityPercent <= -1;
  if (!shouldReport) {
    return {
      delta: { totalTokens, wastefulTokens: wastefulTokenDelta, densityPercent }
    };
  }
  const tokenDetail = wastefulTokenDelta > 0 ? `+${wastefulTokenDelta.toLocaleString()} redundant context tokens` : `${totalTokens >= 0 ? "+" : ""}${totalTokens.toLocaleString()} context tokens`;
  return {
    delta: { totalTokens, wastefulTokens: wastefulTokenDelta, densityPercent },
    regression: {
      kind: "context-bloat",
      severity: "medium",
      title: tokenDetail,
      detail: `Context changed by ${totalTokens >= 0 ? "+" : ""}${totalTokens.toLocaleString()} total tokens; signal density changed by ${densityPercent >= 0 ? "+" : ""}${densityPercent} points.`
    }
  };
}
function compareScanResults(baseline, head, baselineRef) {
  const context = compareContext(baseline, head);
  const regressions = [
    ...compareFindings(baseline, head),
    ...compareVerification(baseline, head),
    ...context.regression ? [context.regression] : []
  ].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title) || (a.fingerprint || "").localeCompare(b.fingerprint || "")
  );
  return {
    baselineRef,
    baselineScore: baseline.overallScore,
    headScore: head.overallScore,
    scoreDelta: head.overallScore - baseline.overallScore,
    regressions,
    contextDelta: context.delta
  };
}
function hasRegressionAtLeast(regressions, threshold) {
  return Boolean(threshold && regressions.some((regression) => severityAtLeast(regression.severity, threshold)));
}

// src/core/regression/check.ts
var CheckConfigurationError = class extends Error {
  exitCode = 2;
};
function parseNumber(value, name, fallback) {
  if (value === void 0 || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new CheckConfigurationError(`${name} must be a number between 0 and 100.`);
  }
  return parsed;
}
function parseSeverity(value) {
  if (value === void 0 || value.trim() === "") return void 0;
  const severity = value.trim().toLowerCase();
  if (!["critical", "high", "medium", "low"].includes(severity)) {
    throw new CheckConfigurationError("fail-on must be one of: critical, high, medium, low.");
  }
  return severity;
}
function currentFindingsAtOrAbove(result, threshold) {
  if (!threshold) return false;
  return flattenFindings(result.findings).filter((finding) => finding.confidence >= 0.8).some((finding) => isSeverityAtLeast(finding.severity, threshold));
}
async function evaluateCheck(options = {}) {
  const minScore = parseNumber(options.minScore, "min-score", 75);
  const maxRegression = parseNumber(options.maxRegression, "max-regression", 0);
  const failOn = parseSeverity(options.failOn);
  const baselineRef = options.baseline?.trim() || void 0;
  const cwd = options.cwd || process.cwd();
  const gitRoot = baselineRef ? getGitRoot(cwd) : void 0;
  const resolvedBaselineRef = baselineRef && gitRoot ? resolveGitRef(gitRoot, baselineRef) : void 0;
  if (baselineRef && !resolvedBaselineRef) {
    throw new CheckConfigurationError(`Could not resolve baseline ref "${baselineRef}".`);
  }
  const current = await scanRepository({
    cwd,
    sessionPath: options.session,
    // Runtime traces are ephemeral and are not part of a committed baseline.
    includeRuntime: !baselineRef
  });
  let baseline = null;
  let comparison = null;
  let baselineTree;
  if (baselineRef && gitRoot && resolvedBaselineRef) {
    try {
      baselineTree = archiveGitRef(gitRoot, resolvedBaselineRef);
      baseline = await scanRepository({
        cwd: baselineTree,
        includeRuntime: false,
        gitHistoryRoot: gitRoot,
        gitRef: resolvedBaselineRef
      });
      comparison = compareScanResults(baseline, current, baselineRef);
    } finally {
      if (baselineTree) removeTemporaryDirectory(baselineTree);
    }
  }
  const failures = [];
  if (current.overallScore < minScore) {
    failures.push(`score ${current.overallScore} is below minimum ${minScore}`);
  }
  if (comparison && comparison.scoreDelta < -maxRegression) {
    failures.push(`score regressed by ${Math.abs(comparison.scoreDelta)} points (allowed ${maxRegression})`);
  }
  if (failOn) {
    const severityFailure = comparison ? hasRegressionAtLeast(
      comparison.regressions.filter((regression) => {
        if (!regression.fingerprint) return true;
        const finding = flattenFindings(current.findings).find(
          (candidate) => (candidate.fingerprint || createFindingFingerprint(candidate)) === regression.fingerprint
        );
        return !finding || finding.confidence >= 0.8;
      }),
      failOn
    ) : currentFindingsAtOrAbove(current, failOn);
    if (severityFailure) {
      failures.push(`found a ${failOn.toUpperCase()} or higher severity issue`);
    }
  }
  return {
    schemaVersion: CHECK_SCHEMA_VERSION,
    result: current,
    baseline,
    comparison,
    passed: failures.length === 0,
    failures,
    exitCode: failures.length === 0 ? 0 : 1
  };
}

// src/core/regression/report.ts
var AGENTDOCTOR_REPORT_MARKER = "<!-- agentdoctor-report -->";
function escapeMarkdown(value) {
  return value.replace(/[|\\]/g, "\\$&").replace(/\r?\n/g, " ");
}
function formatAgentDoctorMarkdown(result) {
  const lines = [AGENTDOCTOR_REPORT_MARKER, "## AgentDoctor Report", ""];
  if (result.comparison) {
    const comparison = result.comparison;
    const delta = comparison.scoreDelta === 0 ? "\u21920" : comparison.scoreDelta > 0 ? `\u2191${comparison.scoreDelta}` : `\u2193${Math.abs(comparison.scoreDelta)}`;
    lines.push("| | Score |", "| --- | ---: |", `| ${escapeMarkdown(comparison.baselineRef)} | ${comparison.baselineScore} |`, `| HEAD | ${comparison.headScore} ${delta} |`, "");
    lines.push("### New regressions", "");
    if (comparison.regressions.length === 0) {
      lines.push("No new regressions detected.", "");
    } else {
      for (const regression of comparison.regressions.slice(0, 12)) {
        lines.push(`- **${regression.severity.toUpperCase()}**: ${escapeMarkdown(regression.title)}`);
      }
      if (comparison.regressions.length > 12) {
        lines.push(`- _and ${comparison.regressions.length - 12} more_`);
      }
      lines.push("");
    }
  } else {
    lines.push(`**Agent Efficiency: ${result.result.overallScore}/100**`, "");
  }
  if (result.failures.length > 0) {
    lines.push(`**Status: \u274C Failed** \u2014 ${escapeMarkdown(result.failures.join("; "))}`, "");
  } else {
    lines.push("**Status: \u2705 Passed**", "");
  }
  lines.push(`<sub>Scanned ${result.result.repositoryName} in ${result.result.metadata.scanDurationMs} ms \xB7 AgentDoctor schema v${result.result.schemaVersion}</sub>`);
  return lines.join("\n");
}

// src/action/index.ts
function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  try {
    return JSON.parse(fs11.readFileSync(eventPath, "utf-8"));
  } catch {
    return {};
  }
}
function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  let delimiter = `agentdoctor_${name}_EOF`;
  while (value.includes(delimiter)) delimiter += "_";
  fs11.appendFileSync(outputPath, `${name}<<${delimiter}
${value}
${delimiter}
`, "utf-8");
}
function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs11.appendFileSync(summaryPath, `${markdown}
`, "utf-8");
}
async function updatePullRequestComment(body, token, repository, issueNumber) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
  const endpoint = `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`;
  const listResponse = await fetch(endpoint, { headers });
  if (!listResponse.ok) throw new Error(`GitHub comments API returned ${listResponse.status}`);
  const comments = await listResponse.json();
  const existing = comments.find((comment) => comment.body?.includes("<!-- agentdoctor-report -->"));
  const response = existing ? await fetch(`${endpoint}/${existing.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body })
  }) : await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ body })
  });
  if (!response.ok) throw new Error(`GitHub comments API returned ${response.status}`);
}
async function main() {
  const event = readEvent();
  const baselineInput = process.env.AGENTDOCTOR_BASELINE?.trim();
  const baseline = baselineInput || event.pull_request?.base?.ref || void 0;
  const evaluation = await evaluateCheck({
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    minScore: process.env.AGENTDOCTOR_MIN_SCORE || void 0,
    maxRegression: process.env.AGENTDOCTOR_MAX_REGRESSION || void 0,
    failOn: process.env.AGENTDOCTOR_FAIL_ON || void 0,
    baseline
  });
  const markdown = formatAgentDoctorMarkdown(evaluation);
  writeSummary(markdown);
  writeOutput("score", String(evaluation.result.overallScore));
  writeOutput("baseline-score", evaluation.comparison ? String(evaluation.comparison.baselineScore) : "");
  writeOutput("regression", evaluation.comparison ? String(Math.max(0, -evaluation.comparison.scoreDelta)) : "0");
  writeOutput("regression-count", String(evaluation.comparison?.regressions.length || 0));
  writeOutput("passed", String(evaluation.passed));
  writeOutput("report", markdown);
  const issueNumber = event.pull_request?.number;
  const token = process.env.AGENTDOCTOR_GITHUB_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY;
  if (issueNumber && token && repository) {
    try {
      await updatePullRequestComment(markdown, token, repository, issueNumber);
    } catch (error) {
      console.warn(`AgentDoctor could not update the PR comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = evaluation.exitCode;
}
main().catch((error) => {
  console.error(`AgentDoctor Action failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) : 1;
});
