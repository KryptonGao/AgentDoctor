// src/action/index.ts
import * as fs25 from "fs";
import * as path26 from "path";

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
import * as path25 from "path";

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
import * as fs6 from "fs";
import * as path6 from "path";
import { createTwoFilesPatch } from "diff";

// src/core/fix/transaction.ts
import * as fs4 from "fs";
import * as path4 from "path";

// src/core/fix/paths.ts
import * as fs3 from "fs";
import * as path3 from "path";
function toRepoRelative(repoRoot, filePath) {
  if (!filePath) return filePath;
  if (!path3.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
  const relative4 = path3.relative(repoRoot, filePath).replace(/\\/g, "/");
  if (relative4.startsWith("..")) return filePath.replace(/\\/g, "/");
  return relative4 || ".";
}

// src/core/fix/journal.ts
import * as fs5 from "fs";
import * as path5 from "path";

// src/core/fix/fixEngine.ts
function generateDiff(filePath, oldContent, newContent) {
  const fileName = path6.basename(filePath);
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
function combinedDiff(changes) {
  return changes.map((change) => {
    const oldContent = change.kind === "create" || change.replaceFile ? change.kind === "create" ? "" : change.oldText ?? "" : change.oldText ?? "";
    let newContent = change.newText ?? "";
    if (change.kind === "update" && !change.replaceFile && change.oldText !== void 0) {
      newContent = oldContent.replace(change.oldText, change.newText ?? "");
    }
    if (change.kind === "delete") newContent = "";
    return generateDiff(change.path, oldContent, newContent);
  }).join("\n");
}
function createFix(options) {
  const { id, title, description, isSafe, file, oldText, newText, fullOldContent, changes } = options;
  const normalizedChanges = changes && changes.length > 0 ? changes : [{
    path: file,
    kind: !oldText && newText ? "create" : "update",
    oldText,
    newText,
    replaceFile: !oldText && Boolean(newText)
  }];
  let diff = "";
  if (normalizedChanges.length > 1 || normalizedChanges.some((change) => change.kind === "create" || change.kind === "delete")) {
    if (fullOldContent !== void 0 && normalizedChanges.length === 1) {
      const change = normalizedChanges[0];
      const next = change.replaceFile ? change.newText ?? "" : fullOldContent.replace(oldText, newText);
      diff = generateDiff(file, fullOldContent, next);
    } else {
      diff = combinedDiff(normalizedChanges.map((change) => {
        if (change.kind === "update" && !change.replaceFile && fullOldContent !== void 0 && normalizedChanges.length === 1) {
          return { ...change, oldText: fullOldContent, newText: fullOldContent.replace(oldText, newText), replaceFile: true };
        }
        if (change.kind === "update" && !change.replaceFile && fs6.existsSync(change.path)) {
          const current = fs6.readFileSync(change.path, "utf-8");
          return { ...change, oldText: current, newText: current.replace(change.oldText ?? "", change.newText ?? ""), replaceFile: true };
        }
        return change;
      }));
    }
  } else if (fullOldContent !== void 0) {
    const fullNewContent = oldText ? fullOldContent.replace(oldText, newText) : newText;
    diff = generateDiff(file, fullOldContent, fullNewContent);
  } else if (fs6.existsSync(file)) {
    const current = fs6.readFileSync(file, "utf-8");
    const updated = oldText ? current.replace(oldText, newText) : newText;
    diff = generateDiff(file, current, updated);
  } else {
    diff = combinedDiff(normalizedChanges);
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
    changes: normalizedChanges
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
import * as fs7 from "fs";
import * as path7 from "path";
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
  const hasPnpmLock = manifestFiles.some((file) => path7.basename(file) === "pnpm-lock.yaml");
  const hasYarnLock = manifestFiles.some((file) => path7.basename(file) === "yarn.lock");
  const hasNpmLock = manifestFiles.some((file) => path7.basename(file) === "package-lock.json");
  const hasBunLock = manifestFiles.some((file) => ["bun.lockb", "bun.lock"].includes(path7.basename(file)));
  const hasTsConfig = manifestFiles.some((file) => path7.basename(file) === "tsconfig.json");
  let packageManagerField;
  const dependencies = [];
  for (const relativePath of manifestFiles.filter((file) => path7.basename(file) === "package.json").sort()) {
    try {
      const pkg = JSON.parse(fs7.readFileSync(path7.join(repoRoot, relativePath), "utf-8"));
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
import * as fs8 from "fs";
import * as path8 from "path";
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
  const ext = path8.extname(pathValue).replace(/^\./, "").toLowerCase();
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
  const base = path8.basename(clean);
  const candidates = [
    path8.join("apps", clean),
    path8.join("packages", clean),
    path8.join("src", clean),
    path8.join("apps", base),
    path8.join("packages", base)
  ];
  const matches = [...new Set(candidates)].filter(
    (candidate) => fs8.existsSync(path8.join(repoRoot, candidate))
  );
  if (matches.length === 1) {
    return matches[0];
  }
  return null;
}
function resolveCandidatePath(repoRoot, contextPath, rawCandidate) {
  const pathValue = stripFragment(rawCandidate).replace(/^\/+/, "");
  if (!pathValue) return null;
  const contextDirectory = path8.dirname(path8.join(repoRoot, contextPath));
  const contextRelativeDirectory = path8.dirname(contextPath);
  const isRootMetadataFile = contextRelativeDirectory === ".github" || contextRelativeDirectory === ".cursor" || contextRelativeDirectory.startsWith(".cursor/");
  const isExplicitRelative = pathValue.startsWith("./") || pathValue.startsWith("../");
  const baseDirectory = isExplicitRelative || !isRootMetadataFile ? contextDirectory : repoRoot;
  const absolutePath = path8.resolve(baseDirectory, pathValue);
  const relativePath = path8.relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..") || path8.isAbsolute(relativePath)) return null;
  return {
    absolutePath,
    repositoryPath: relativePath.split(path8.sep).join("/")
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
        if (fs8.existsSync(resolvedCandidate.absolutePath)) {
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
        const hasFileExtension = path8.extname(stripFragment(rawCandidate)).length > 1;
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
          const hasFileExt = path8.extname(normalized).length > 1;
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
import * as fs9 from "fs";
import * as path9 from "path";
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
  const pkgPath = path9.join(repoRoot, "package.json");
  if (fs9.existsSync(pkgPath)) {
    try {
      const content = fs9.readFileSync(pkgPath, "utf-8");
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
  const workflowsDir = path9.join(repoRoot, ".github", "workflows");
  if (fs9.existsSync(workflowsDir)) {
    try {
      const ciFiles = fs9.readdirSync(workflowsDir);
      for (const cf of ciFiles) {
        if (cf.endsWith(".yml") || cf.endsWith(".yaml")) {
          const cfPath = path9.join(workflowsDir, cf);
          const content = fs9.readFileSync(cfPath, "utf-8");
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

// src/analyzers/context/agentFiles.ts
import * as fs10 from "fs";
import * as path10 from "path";
import fg2 from "fast-glob";
import micromatch from "micromatch";
var AGENT_FILE_IGNORE = [
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
];
var AGENT_INSTRUCTION_GLOBS = [
  "**/AGENTS.md",
  "**/AGENTS.override.md",
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/GEMINI.md",
  "**/GEMINI.local.md",
  "**/CONVENTIONS.md",
  "**/.cursorrules",
  "**/.windsurfrules",
  "**/.clinerules",
  "**/.roorules",
  "**/.cursor/rules/**/*.{md,mdc}",
  "**/.github/copilot-instructions.md",
  "**/.github/instructions/**/*.md",
  "**/.claude/skills/**/*.md",
  "**/.claude/agents/**/*.{md,mdc}",
  "**/.claude/rules/**/*.md",
  "**/.codex/skills/**/*.md",
  "**/.codex/agents/**/*.{md,toml}",
  "**/.agents/skills/**/*.md",
  "**/.github/skills/**/*.md",
  "**/.windsurf/rules/**/*.{md,mdc}",
  "**/.clinerules/**/*.{md,mdc}",
  "**/.roo/rules/**/*.{md,mdc}",
  "**/.roo/rules-*/**/*.{md,mdc}",
  "**/.opencode/**/*.{md,mdc}"
];
var AGENT_CONFIG_GLOBS = [
  ".mcp.json",
  "**/.mcp.json",
  ".cursor/mcp.json",
  "**/.cursor/mcp.json",
  ".cursor/cli.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude.json",
  ".claude/hooks.json",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".gemini/settings.json",
  ".gemini/settings.local.json",
  ".github/hooks/**/*.json",
  "**/.github/copilot-mcp.json",
  ".github/mcp.json",
  ".windsurf/mcp.json",
  ".windsurf/mcp_config.json",
  "**/.windsurf/mcp.json",
  ".cline/mcp.json",
  ".cline/mcp_settings.json",
  "**/.cline/mcp*.json",
  ".roo/mcp.json",
  "**/.roo/mcp.json",
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
  "**/.aider.conf.yml",
  "**/.aider.conf.yaml",
  "**/.aider.conf.json",
  ".roomodes"
];
function normalizeAgentRelativePath(relativePath) {
  return relativePath.replace(/\\/g, "/");
}
function globAgentFilesSync(repoRoot, globs) {
  return fg2.sync(globs, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: AGENT_FILE_IGNORE
  }).sort((a, b) => a.localeCompare(b));
}
async function globAgentFiles(repoRoot, globs) {
  const relativePaths = await fg2(globs, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: AGENT_FILE_IGNORE
  });
  return relativePaths.sort((a, b) => a.localeCompare(b));
}
function readAgentTextFile(repoRoot, relativePath) {
  const absolutePath = path10.join(repoRoot, relativePath);
  try {
    if (!fs10.existsSync(absolutePath) || !fs10.statSync(absolutePath).isFile()) return null;
    return {
      relativePath: normalizeAgentRelativePath(relativePath),
      absolutePath,
      content: fs10.readFileSync(absolutePath, "utf-8")
    };
  } catch {
    return null;
  }
}

// src/analyzers/context/contextAnalyzer.ts
var LOW_VALUE_PATTERNS = [
  /^(?:[\s*\-#\d.)>]*)(?:write clean (?:and maintainable )?code|always write clean code)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:follow best practices|adhere to standard conventions)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:be careful(?:\s+and avoid bugs)?|ensure no bugs are introduced)[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:think (?:step by step|carefully before editing))[\s.!]*$/i,
  /^(?:[\s*\-#\d.)>]*)(?:do your best|be helpful and thorough)[\s.!]*$/i
];
async function findContextFiles(repoRoot) {
  const relativePaths = await globAgentFiles(repoRoot, AGENT_INSTRUCTION_GLOBS);
  const files = [];
  for (const rel of relativePaths) {
    const file = readAgentTextFile(repoRoot, rel);
    if (file) files.push(file);
  }
  return files;
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
import * as fs11 from "fs";
import * as path11 from "path";
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
    const absPath = path11.join(repoRoot, relFile);
    try {
      const content = fs11.readFileSync(absPath, "utf-8");
      const lineCount = content.split(/\r?\n/).length;
      if (isGeneratedFile(content)) continue;
      const isTestFile = relFile.includes("tests/") || relFile.includes("test/") || path11.basename(relFile).startsWith("test_") || relFile.includes(".test.") || relFile.includes(".spec.");
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
    const instructionFiles = globAgentFilesSync(repoRoot, AGENT_INSTRUCTION_GLOBS);
    let mentionsGeneratedWarning = false;
    for (const inst of instructionFiles) {
      const instPath = path11.join(repoRoot, inst);
      if (fs11.existsSync(instPath)) {
        const text = fs11.readFileSync(instPath, "utf-8").toLowerCase();
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
    workflows.install = fs11.existsSync(path11.join(repoRoot, "requirements.txt")) || fs11.existsSync(path11.join(repoRoot, "pyproject.toml")) || fs11.existsSync(path11.join(repoRoot, "poetry.lock")) || fs11.existsSync(path11.join(repoRoot, "uv.lock"));
    workflows.test = profile.testRoots.length > 0 || fs11.existsSync(path11.join(repoRoot, "pytest.ini")) || (profile.configFiles.python?.includes("pyproject.toml") ?? false);
    workflows.lint = fs11.existsSync(path11.join(repoRoot, ".pre-commit-config.yaml")) || fs11.existsSync(path11.join(repoRoot, "ruff.toml"));
    workflows.build = fs11.existsSync(path11.join(repoRoot, "setup.py")) || (profile.configFiles.python?.includes("pyproject.toml") ?? false);
  }
  if (profile.ecosystems.includes("node")) {
    const packageRelativePath = profile.configFiles.node?.find((file) => path11.basename(file) === "package.json");
    const pkgPath = packageRelativePath ? path11.join(repoRoot, packageRelativePath) : "";
    if (pkgPath && fs11.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs11.readFileSync(pkgPath, "utf-8"));
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
import * as fs13 from "fs";
import * as path13 from "path";

// src/analyzers/verification/nodeScripts.ts
import * as fs12 from "fs";
import * as path12 from "path";
function findNodePackagePaths(repoRoot, profile) {
  const configured = profile.configFiles.node?.filter((file) => path12.basename(file) === "package.json") || [];
  const candidates = ["package.json", ...configured].filter((file, index, all) => all.indexOf(file) === index);
  return candidates.filter((file) => fs12.existsSync(path12.join(repoRoot, file)));
}
function readNodePackageScripts(repoRoot, profile) {
  const paths = findNodePackagePaths(repoRoot, profile);
  const scripts = {};
  const sources = {};
  const rootScripts = {};
  for (const packagePath of paths) {
    try {
      const pkg = JSON.parse(fs12.readFileSync(path12.join(repoRoot, packagePath), "utf-8"));
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
function detectNodePackageManager(repoRoot) {
  if (fs12.existsSync(path12.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fs12.existsSync(path12.join(repoRoot, "yarn.lock"))) return "yarn";
  if (fs12.existsSync(path12.join(repoRoot, "bun.lock")) || fs12.existsSync(path12.join(repoRoot, "bun.lockb"))) {
    return "bun";
  }
  try {
    const pkg = JSON.parse(fs12.readFileSync(path12.join(repoRoot, "package.json"), "utf-8"));
    const field = pkg.packageManager || "";
    if (field.startsWith("pnpm")) return "pnpm";
    if (field.startsWith("yarn")) return "yarn";
    if (field.startsWith("bun")) return "bun";
  } catch {
  }
  return "npm";
}

// src/analyzers/verification/verificationAnalyzer.ts
function discoverInstructionFiles(repoRoot) {
  return globAgentFilesSync(repoRoot, AGENT_INSTRUCTION_GLOBS);
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
  const ciWorkflowsDir = path13.join(repoRoot, ".github", "workflows");
  let ciTestCommand;
  if (fs13.existsSync(ciWorkflowsDir)) {
    try {
      const files = fs13.readdirSync(ciWorkflowsDir).sort((a, b) => a.localeCompare(b));
      for (const cf of files) {
        if (cf.endsWith(".yml") || cf.endsWith(".yaml")) {
          const content = fs13.readFileSync(path13.join(ciWorkflowsDir, cf), "utf-8");
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
    const hasPytest = profile.testRoots.length > 0 || fs13.existsSync(path13.join(repoRoot, "pytest.ini")) || fs13.existsSync(path13.join(repoRoot, "tox.ini"));
    let pyprojectHasPytest = false;
    let pyprojectHasMypy = false;
    let pyprojectHasRuff = false;
    let pyprojectHasBuild = false;
    const pyprojectPath = path13.join(repoRoot, "pyproject.toml");
    if (fs13.existsSync(pyprojectPath)) {
      const pyprojectContent = fs13.readFileSync(pyprojectPath, "utf-8");
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
        source: pyprojectHasPytest ? "pyproject.toml" : "tests",
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
    const hasPrecommit = fs13.existsSync(path13.join(repoRoot, ".pre-commit-config.yaml"));
    if (pyprojectHasRuff || hasPrecommit || fs13.existsSync(path13.join(repoRoot, "ruff.toml"))) {
      statusMap.lint = {
        name: "lint",
        status: "healthy",
        command: pyprojectHasRuff ? "ruff check ." : "pre-commit run",
        source: pyprojectHasRuff ? "pyproject.toml" : ".pre-commit-config.yaml",
        detail: "Linter configured (ruff / pre-commit)"
      };
    } else {
      statusMap.lint = {
        name: "lint",
        status: "unknown",
        detail: "No Python linter (ruff, flake8) detected"
      };
    }
    if (pyprojectHasMypy || fs13.existsSync(path13.join(repoRoot, "mypy.ini"))) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "healthy",
        command: "mypy .",
        source: "pyproject.toml",
        detail: "Static type checker (mypy/pyright) configured"
      };
    } else {
      statusMap.typecheck = {
        name: "typecheck",
        status: "not_applicable",
        detail: "Type checker (mypy/pyright) not configured for Python project"
      };
    }
    if (pyprojectHasBuild || fs13.existsSync(path13.join(repoRoot, "setup.py"))) {
      statusMap.build = {
        name: "build",
        status: "healthy",
        command: "python -m build",
        source: "pyproject.toml",
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
    statusMap.test = { name: "test", status: "healthy", command: "cargo test", source: "Cargo.toml", detail: "Standard Cargo test" };
    statusMap.lint = { name: "lint", status: "healthy", command: "cargo clippy", source: "Cargo.toml", detail: "Standard Cargo clippy" };
    statusMap.typecheck = { name: "typecheck", status: "healthy", command: "cargo check", source: "Cargo.toml", detail: "Cargo compiler typecheck" };
    statusMap.build = { name: "build", status: "healthy", command: "cargo build", source: "Cargo.toml", detail: "Standard Cargo build" };
  } else if (profile.primaryEcosystem === "go") {
    statusMap.test = { name: "test", status: "healthy", command: "go test ./...", source: "go.mod", detail: "Standard Go test" };
    statusMap.lint = { name: "lint", status: "healthy", command: "go vet ./...", source: "go.mod", detail: "Standard Go vet" };
    statusMap.typecheck = { name: "typecheck", status: "healthy", command: "go build", source: "go.mod", detail: "Go compiler typecheck" };
    statusMap.build = { name: "build", status: "healthy", command: "go build ./...", source: "go.mod", detail: "Standard Go build" };
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
          source: packageScriptSources[configuredTest.name] || "package.json",
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
          source: packageScriptSources[configuredTest.name] || "package.json",
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
        source: packageScriptSources.lint || "package.json",
        detail: `Defined in package.json: "${packageScripts.lint}"`
      };
    } else {
      statusMap.lint = {
        name: "lint",
        status: "unknown",
        detail: "No lint script found"
      };
    }
    const hasTs = fs13.existsSync(path13.join(repoRoot, "tsconfig.json"));
    const typecheckCmd = packageScripts.typecheck || packageScripts["type-check"] || packageScripts.tsc;
    const inferredTypecheck = Object.entries(packageScripts).find(
      ([name, command]) => /type[-:]?check/i.test(name) || /\b(?:tsc|tsgo)\b/.test(command) || hasTs && name === "compile"
    )?.[1];
    if (typecheckCmd || inferredTypecheck) {
      statusMap.typecheck = {
        name: "typecheck",
        status: "healthy",
        command: typecheckCmd || inferredTypecheck,
        source: "package.json",
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
        source: packageScriptSources.build || "package.json",
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
    const instPath = path13.join(repoRoot, instName);
    if (!fs13.existsSync(instPath)) continue;
    const content = fs13.readFileSync(instPath, "utf-8");
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
import * as fs21 from "fs";
import * as path21 from "path";

// src/analyzers/runtime/adapters/agentdoctor.ts
import * as fs14 from "fs";
import * as path14 from "path";

// src/analyzers/runtime/sessionBuilder.ts
function deriveSessionRepeats(filesRead, searchOperations, timeline) {
  const fileReadCounts = {};
  for (const f of filesRead) fileReadCounts[f] = (fileReadCounts[f] || 0) + 1;
  const repeatedReads = Object.entries(fileReadCounts).filter(([, count]) => count >= 3).map(([file, count]) => ({ file, count }));
  const searchCounts = {};
  for (const s of searchOperations) {
    const norm = s.toLowerCase().trim();
    if (norm) searchCounts[norm] = (searchCounts[norm] || 0) + 1;
  }
  const repeatedSearches = Object.entries(searchCounts).filter(([, count]) => count >= 2).map(([query, count]) => ({ query, count }));
  const failedCmdCounts = {};
  for (const t of timeline) {
    if (t.status === "failed") failedCmdCounts[t.action] = (failedCmdCounts[t.action] || 0) + 1;
  }
  const repeatedFailures = Object.entries(failedCmdCounts).filter(([, count]) => count >= 2).map(([command, count]) => ({ command, count }));
  return { repeatedReads, repeatedSearches, repeatedFailures };
}
function finalizeSession(partial) {
  const { repeatedReads, repeatedSearches, repeatedFailures } = deriveSessionRepeats(
    partial.filesRead,
    partial.searchOperations,
    partial.timeline
  );
  let failureReasons = partial.failureReasons;
  if (!failureReasons) {
    failureReasons = partial.timeline.filter((t) => t.status === "failed").slice(0, 20).map((t) => ({ action: t.action, reason: t.detail || "failed" }));
  }
  const sessionScore = Math.max(
    30,
    Math.min(
      98,
      100 - repeatedReads.length * 8 - repeatedSearches.length * 6 - repeatedFailures.length * 12 - Math.min(20, Math.floor(partial.failedToolCalls * 2))
    )
  );
  return {
    ...partial,
    tokenUsage: {
      input: partial.tokenUsage?.input || 0,
      output: partial.tokenUsage?.output || 0,
      total: partial.tokenUsage?.total || (partial.tokenUsage?.input || 0) + (partial.tokenUsage?.output || 0)
    },
    toolOutputTokens: partial.toolOutputTokens || 0,
    efficiencyScore: sessionScore,
    repeatedReads,
    repeatedSearches,
    repeatedFailures,
    failureReasons,
    approvalsCount: partial.approvalsCount || 0,
    retriesCount: partial.retriesCount || 0,
    restoresCount: partial.restoresCount || 0,
    redactedFields: partial.redactedFields || 0
  };
}
function emptyPartial(id, agentName) {
  return {
    id,
    agentName,
    date: "Unknown",
    durationSeconds: 0,
    durationUnknown: true,
    tokenUsage: { input: 0, output: 0, total: 0 },
    tokensUnknown: true,
    toolCalls: 0,
    failedToolCalls: 0,
    commandsExecuted: 0,
    filesRead: [],
    filesEdited: [],
    searchOperations: [],
    toolOutputTokens: 0,
    timeline: []
  };
}

// src/analyzers/runtime/adapters/agentdoctor.ts
function parseAgentdoctorContent(content, filePath) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = data.id || path14.basename(filePath, path14.extname(filePath));
  const agentName = data.agentName || (typeof data.model === "string" && data.model.includes("claude") ? "Claude Code" : "Codex");
  const partial = emptyPartial(String(id), agentName);
  partial.sourcePath = filePath;
  partial.date = data.date || "Unknown";
  if (typeof data.nativeId === "string") partial.nativeId = data.nativeId;
  if (typeof data.sessionCwd === "string") partial.sessionCwd = data.sessionCwd;
  if (typeof data.gitBranch === "string") partial.gitBranch = data.gitBranch;
  if (typeof data.gitCommit === "string") partial.gitCommit = data.gitCommit;
  if (typeof data.gitDirty === "boolean") partial.gitDirty = data.gitDirty;
  if (typeof data.gitMessage === "string") partial.gitMessage = data.gitMessage;
  if (typeof data.prNumber === "number") partial.prNumber = data.prNumber;
  if (typeof data.prTitle === "string") partial.prTitle = data.prTitle;
  if (typeof data.prState === "string") partial.prState = data.prState;
  if (typeof data.taskTitle === "string") partial.taskTitle = data.taskTitle;
  if (typeof data.contextTokens === "number") partial.contextTokens = data.contextTokens;
  if (typeof data.contextWindowTokens === "number") partial.contextWindowTokens = data.contextWindowTokens;
  if (typeof data.durationSeconds === "number" && data.durationSeconds >= 0) {
    partial.durationSeconds = data.durationSeconds;
    partial.durationUnknown = false;
  }
  if (typeof data.startedAtMs === "number" && Number.isFinite(data.startedAtMs)) {
    partial.startedAtMs = data.startedAtMs;
  }
  if (typeof data.endedAtMs === "number" && Number.isFinite(data.endedAtMs)) {
    partial.endedAtMs = data.endedAtMs;
  }
  if (partial.startedAtMs === void 0 && typeof data.date === "string") {
    const parsedDate = Date.parse(data.date);
    if (Number.isFinite(parsedDate)) partial.startedAtMs = parsedDate;
  }
  if (partial.endedAtMs === void 0 && partial.startedAtMs !== void 0 && !partial.durationUnknown) {
    partial.endedAtMs = partial.startedAtMs + partial.durationSeconds * 1e3;
  }
  partial.filesRead = Array.isArray(data.filesRead) ? [...data.filesRead] : [];
  partial.filesEdited = Array.isArray(data.filesEdited) ? [...data.filesEdited] : [];
  partial.searchOperations = Array.isArray(data.searchOperations) ? [...data.searchOperations] : [];
  partial.timeline = Array.isArray(data.timeline) ? [...data.timeline] : [];
  let commandsExecuted = typeof data.commandsExecuted === "number" ? data.commandsExecuted : 0;
  for (const t of partial.timeline) {
    const action = (t.action || "").toLowerCase();
    if (t.action.toLowerCase().includes("read ") || t.action.toLowerCase().includes("view ")) {
      const match = t.action.match(/(?:read|view)\s+([a-zA-Z0-9_\-./]+)/i);
      if (match?.[1]) {
        const file = match[1];
        if (!partial.filesRead.includes(file)) partial.filesRead.push(file);
        else partial.filesRead.push(file);
      }
    }
    if (action.includes("search ") || action.includes("grep ")) {
      const match = t.action.match(/(?:search|grep)\s+([^\n]+)/i);
      if (match?.[1]) partial.searchOperations.push(match[1].replace(/['"]/g, "").trim());
    }
    if (action.includes("edit ") || action.includes("write ")) {
      const match = t.action.match(/(?:edit|write)\s+([a-zA-Z0-9_\-./]+)/i);
      if (match?.[1] && !partial.filesEdited.includes(match[1])) partial.filesEdited.push(match[1]);
    }
    if (t.tool === "bash" || t.tool === "command" || action.startsWith("run ") || action.includes("test")) {
      commandsExecuted++;
    }
  }
  partial.commandsExecuted = commandsExecuted;
  partial.toolCalls = typeof data.toolCalls === "number" ? data.toolCalls : partial.timeline.length;
  partial.failedToolCalls = typeof data.failedToolCalls === "number" ? data.failedToolCalls : partial.timeline.filter((t) => t.status === "failed").length;
  if (data.tokenUsage && typeof data.tokenUsage === "object") {
    const input = Number(data.tokenUsage.input) || 0;
    const output = Number(data.tokenUsage.output) || 0;
    const total = Number(data.tokenUsage.total) || input + output;
    partial.tokenUsage = { input, output, total };
    partial.tokensUnknown = total === 0;
  }
  if (typeof data.toolOutputTokens === "number") {
    partial.toolOutputTokens = data.toolOutputTokens;
  } else {
    partial.toolOutputTokens = partial.timeline.reduce(
      (sum, t) => sum + estimateTokens(t.detail || ""),
      0
    );
  }
  if (typeof data.model === "string") partial.model = data.model;
  if (data.cacheTokens) partial.cacheTokens = data.cacheTokens;
  if (typeof data.approvalsCount === "number") partial.approvalsCount = data.approvalsCount;
  if (typeof data.retriesCount === "number") partial.retriesCount = data.retriesCount;
  if (typeof data.restoresCount === "number") partial.restoresCount = data.restoresCount;
  if (Array.isArray(data.failureReasons)) partial.failureReasons = [...data.failureReasons];
  if (typeof data.tokensUnknown === "boolean") partial.tokensUnknown = data.tokensUnknown;
  if (typeof data.durationUnknown === "boolean") partial.durationUnknown = data.durationUnknown;
  return finalizeSession(partial);
}
var agentdoctorAdapter = {
  id: "agentdoctor",
  async detect() {
    return [];
  },
  async parse(ref) {
    try {
      const content = fs14.readFileSync(ref.sourcePath, "utf-8");
      return parseAgentdoctorContent(content, ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath, firstChunk) {
    if (!filePath.endsWith(".json")) return false;
    const t = firstChunk.trimStart();
    return t.startsWith("{");
  }
};

// src/analyzers/runtime/adapters/codex.ts
import * as fs15 from "fs";
import * as path15 from "path";

// src/analyzers/runtime/sessionTypes.ts
function formatTimeOffset(offsetSeconds) {
  const s = Math.max(0, Math.floor(offsetSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// src/analyzers/runtime/adapters/codex.ts
function parseTs(v) {
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1e3) : Math.floor(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1e3);
  }
  return null;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function textFrom(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const r = value;
    if (typeof r.text === "string") return r.text;
    if (r.content !== void 0) return textFrom(r.content);
    if (r.output !== void 0) return textFrom(r.output);
    if (r.message !== void 0) return textFrom(r.message);
    if (r.summary !== void 0) return textFrom(r.summary);
  }
  return "";
}
function numberFrom(...values) {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
function contextWindowFrom(value) {
  const direct = numberFrom(value);
  if (direct != null) return direct;
  const r = asRecord(value);
  return numberFrom(r.limit, r.tokens, r.size, r.max_tokens, r.context_window);
}
function safeJsonParseArgs(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return { _raw: String(parsed) };
    } catch {
      return { _raw: args };
    }
  }
  return {};
}
function recordFailure(partial, action, reason, at, index) {
  const safeAction = action.slice(0, 200);
  const safeReason = reason.slice(0, 300) || "failed";
  partial.failedToolCalls++;
  if (index !== void 0 && partial.timeline[index]) {
    partial.timeline[index].status = "failed";
    partial.timeline[index].detail = safeReason;
  } else {
    partial.timeline.push({ timeOffset: formatTimeOffset(at), action: safeAction, tool: "codex", status: "failed", detail: safeReason });
  }
  if (!partial.failureReasons) partial.failureReasons = [];
  partial.failureReasons.push({ action: safeAction, reason: safeReason });
}
function classifyCommand(partial, command) {
  const trimmed = command.trim();
  if (/^(?:rg|ripgrep|grep|git\s+grep|find)\b/i.test(trimmed)) {
    partial.searchOperations.push(trimmed.slice(0, 200));
  } else if (/^(?:cat|head|tail|sed|less|more)\b/i.test(trimmed)) {
    const match = trimmed.match(/(?:^|\s)([^\s|>]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|css|html))(?:\s|$)/i);
    if (match?.[1]) partial.filesRead.push(match[1]);
  }
}
function addToolTimeline(partial, at, name, args, status = "success", detail) {
  const lower = name.toLowerCase();
  const file = String(args.path ?? args.file ?? args.file_path ?? args.filename ?? "");
  let action = name;
  if (/shell|bash|command|exec|terminal|run/.test(lower)) {
    const command = String(args.command ?? args.cmd ?? args.script ?? args._raw ?? name);
    partial.commandsExecuted++;
    classifyCommand(partial, command);
    action = `Run ${command}`;
  } else if (/diff|edit|write|apply|patch|replace|delete/.test(lower)) {
    if (file) partial.filesEdited.push(file);
    action = `Edit ${file || name}`;
  } else if (/read|view|cat|open/.test(lower)) {
    if (file) partial.filesRead.push(file);
    action = `Read ${file || name}`;
  } else if (/search|grep|glob|find/.test(lower)) {
    const query = String(args.pattern ?? args.query ?? args.path ?? args._raw ?? name);
    partial.searchOperations.push(query);
    action = `Search ${query}`;
  }
  const index = partial.timeline.length;
  partial.timeline.push({ timeOffset: formatTimeOffset(at), action: action.slice(0, 200), tool: name, status, detail });
  return index;
}
function commandItemAction(item) {
  const command = String(item.command ?? item.cmd ?? item.process ?? "command");
  return { action: `Run ${command}`.slice(0, 200), command };
}
function parseCodexLines(lines, filePath) {
  const base = path15.basename(filePath, path15.extname(filePath));
  const partial = emptyPartial(base, "Codex");
  partial.sourcePath = filePath;
  let startSec = null;
  let endSec = null;
  let recordInput = 0;
  let recordOutput = 0;
  let recordTotal = 0;
  let recordCacheRead = 0;
  let recordCacheCreation = 0;
  let eventInput = 0;
  let eventOutput = 0;
  let eventTotal = 0;
  let eventCacheRead = 0;
  let eventCacheCreation = 0;
  let genericInput = 0;
  let genericOutput = 0;
  let genericTotal = 0;
  let genericCacheRead = 0;
  let genericCacheCreation = 0;
  let tokensSeen = false;
  let tokenUsageRecordSeen = false;
  let approvals = 0;
  let retries = 0;
  let completedNativeTools = false;
  const pendingCalls = /* @__PURE__ */ new Map();
  const customCalls = [];
  const customOutputs = /* @__PURE__ */ new Map();
  const noteTime = (sec) => {
    if (sec == null) return;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };
  const pushTimeline = (sec, action, tool, status, detail) => {
    const offset = startSec != null ? Math.max(0, sec - startSec) : partial.timeline.length * 30;
    const index = partial.timeline.length;
    partial.timeline.push({ timeOffset: formatTimeOffset(offset), action: action.slice(0, 200), tool, status, detail });
    return index;
  };
  const addUsage = (usageValue, target) => {
    const usage = asRecord(usageValue);
    if (Object.keys(usage).length === 0) return;
    const input = numberFrom(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens) ?? 0;
    const output = numberFrom(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens) ?? 0;
    const total = numberFrom(usage.total_tokens, usage.totalTokens, usage.total) ?? input + output;
    const cacheRead = numberFrom(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cacheReadInputTokens) ?? 0;
    const cacheCreation = numberFrom(usage.cache_write_input_tokens, usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) ?? 0;
    if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && cacheCreation === 0) return;
    tokensSeen = true;
    if (target === "record") {
      recordInput = input;
      recordOutput = output;
      recordTotal = total;
      recordCacheRead = cacheRead;
      recordCacheCreation = cacheCreation;
    } else if (target === "eventSnapshot") {
      eventInput = input;
      eventOutput = output;
      eventTotal = total;
      eventCacheRead = cacheRead;
      eventCacheCreation = cacheCreation;
    } else if (target === "event") {
      eventInput += input;
      eventOutput += output;
      eventTotal += total;
      eventCacheRead += cacheRead;
      eventCacheCreation += cacheCreation;
    } else {
      genericInput += input;
      genericOutput += output;
      genericTotal += total;
      genericCacheRead += cacheRead;
      genericCacheCreation += cacheCreation;
    }
    partial.contextTokens = Math.max(partial.contextTokens ?? 0, input);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let evt;
    try {
      evt = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    const sec = parseTs(evt.timestamp ?? evt.time);
    noteTime(sec);
    const at = sec ?? (endSec ?? 0);
    const type = String(evt.type ?? "");
    const p = asRecord(evt.payload ?? evt);
    const payloadType = String(p.type ?? p.msg_type ?? p.msgType ?? "");
    if (type === "session_meta" || type === "turn_context") {
      const meta = type === "session_meta" ? asRecord(p.session_meta ?? p) : p;
      if (typeof meta.session_id === "string") partial.nativeId = meta.session_id;
      if (typeof meta.sessionId === "string") partial.nativeId = meta.sessionId;
      if (typeof meta.id === "string" && !partial.nativeId) partial.nativeId = meta.id;
      if (typeof meta.model === "string") partial.model = meta.model;
      if (typeof meta.cwd === "string") partial.sessionCwd = meta.cwd;
      const task = textFrom(meta.task ?? meta.title ?? meta.summary ?? meta.prompt);
      if (task && !partial.taskTitle) partial.taskTitle = task.slice(0, 140);
      if (meta.git && typeof meta.git === "object") {
        const git = asRecord(meta.git);
        if (typeof git.branch === "string") partial.gitBranch = git.branch;
        if (typeof git.commit === "string") partial.gitCommit = git.commit;
        if (typeof git.commit_hash === "string" && !partial.gitCommit) partial.gitCommit = git.commit_hash;
        if (typeof git.sha === "string" && !partial.gitCommit) partial.gitCommit = git.sha;
        if (typeof git.dirty === "boolean") partial.gitDirty = git.dirty;
        if (typeof git.message === "string") partial.gitMessage = git.message;
      }
      const window = contextWindowFrom(meta.context_window ?? meta.contextWindowTokens ?? meta.model_context_window);
      if (window != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, window);
      if (type === "session_meta" || type === "turn_context") continue;
    }
    if (!partial.nativeId && typeof p.session_id === "string") partial.nativeId = p.session_id;
    if (!partial.sessionCwd && typeof p.cwd === "string") partial.sessionCwd = p.cwd;
    if (typeof p.model === "string" && !partial.model) partial.model = p.model;
    const genericContextWindow = contextWindowFrom(p.model_context_window ?? p.context_window ?? evt.model_context_window);
    if (genericContextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, genericContextWindow);
    if (type === "compacted" || payloadType === "compacted" || p.replacement_history || p.contextCompaction || p.context_compaction) {
      retries++;
    }
    if (type === "token_usage_record") {
      tokenUsageRecordSeen = true;
      addUsage(p.usage ?? p, "record");
    } else if (type === "event_msg" && payloadType === "token_count") {
      const info = asRecord(p.info);
      if (info.last_token_usage ?? p.count ?? p.tokens) addUsage(info.last_token_usage ?? p.count ?? p.tokens, "event");
      else if (info.total_token_usage) addUsage(info.total_token_usage, "eventSnapshot");
      const window = contextWindowFrom(info.model_context_window ?? p.model_context_window);
      if (window != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, window);
    } else {
      addUsage(p.usage ?? p.msg?.usage ?? p.payload?.usage, "generic");
    }
    const signal = `${type} ${payloadType} ${textFrom(p.info)} ${textFrom(p.message)}`;
    if (/approval|permission/i.test(signal) && /request|requested|denied|blocked|confirm|approval/i.test(signal)) approvals++;
    if (type === "event_msg" && payloadType === "item_completed" && p.item && typeof p.item === "object") {
      const item = asRecord(p.item);
      const itemType = String(item.type ?? item.kind ?? "");
      if (itemType === "UserMessage") {
        const task = textFrom(item.content ?? item.message ?? item.text);
        if (task && !partial.taskTitle) partial.taskTitle = task.trim().slice(0, 140);
      } else if (itemType === "CommandExecution") {
        completedNativeTools = true;
        const { action, command } = commandItemAction(item);
        partial.toolCalls++;
        partial.commandsExecuted++;
        classifyCommand(partial, command);
        const exitCode = numberFrom(item.exit_code, item.exitCode);
        const itemStatus = String(item.status ?? "").toLowerCase();
        const failed = exitCode != null && exitCode !== 0 || /fail|error|cancel|abort/.test(itemStatus);
        const output = textFrom(item.aggregated_output ?? item.stdout ?? item.stderr ?? item.output);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const detail = failed ? (textFrom(item.stderr) || output || (exitCode != null ? `exit ${exitCode}` : "command failed")).slice(0, 300) : void 0;
        const index = pushTimeline(at, action, "bash", failed ? "failed" : "success", detail);
        if (failed) recordFailure(partial, action, detail || "command failed", at, index);
      } else if (itemType === "Extension") {
        completedNativeTools = true;
        const name = String(item.kind ?? item.name ?? item.extension ?? "extension");
        const query = textFrom(item.query ?? item.input ?? item.arguments);
        partial.toolCalls++;
        if (/search|web|grep|find/i.test(name)) partial.searchOperations.push(query || name);
        const output = textFrom(item.output ?? item.result ?? item.aggregated_output);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const failed = /fail|error/i.test(String(item.status ?? ""));
        const action = /search|web/i.test(name) ? `Search ${query || name}` : name;
        const index = pushTimeline(at, action, name, failed ? "failed" : "success", failed ? output.slice(0, 300) : void 0);
        if (failed) recordFailure(partial, action, output || "extension failed", at, index);
      } else if (itemType === "FileChange") {
        completedNativeTools = true;
        const changes = item.changes && typeof item.changes === "object" ? Object.keys(item.changes) : [];
        for (const file of changes) partial.filesEdited.push(file);
        const output = textFrom(item.stdout ?? item.stderr ?? item.output);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const status = String(item.status ?? "").toLowerCase();
        const failed = /fail|error|cancel|abort/.test(status) || item.failed === true;
        const action = `Edit ${changes.length === 1 ? changes[0] : `${changes.length} files`}`;
        partial.toolCalls++;
        const index = pushTimeline(at, action, "FileChange", failed ? "failed" : "success", failed ? output.slice(0, 300) : void 0);
        if (failed) recordFailure(partial, action, output || "file change failed", at, index);
      }
    }
    if (type === "response_item") {
      const kind = payloadType || String(p.kind ?? "");
      if (kind === "function_call") {
        const name = String(p.name ?? "tool");
        const callId = String(p.call_id ?? p.callId ?? `${partial.toolCalls}`);
        partial.toolCalls++;
        const index = addToolTimeline(partial, at, name, safeJsonParseArgs(p.arguments));
        pendingCalls.set(callId, { name, sec: at, timelineIndex: index });
      } else if (kind === "custom_tool_call") {
        customCalls.push({
          id: String(p.call_id ?? p.callId ?? p.id ?? `${customCalls.length}`),
          name: String(p.name ?? p.tool_name ?? "tool"),
          args: safeJsonParseArgs(p.input ?? p.arguments ?? p.args),
          sec: at
        });
      } else if (kind === "function_call_output") {
        const callId = String(p.call_id ?? p.callId ?? "");
        const pending = callId ? pendingCalls.get(callId) : void 0;
        const output = textFrom(p.output ?? p.result ?? p.text);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const commandExecution = asRecord(p.commandExecution ?? p.command_execution);
        const exitCode = numberFrom(commandExecution.exitCode, commandExecution.exit_code);
        const status = String(commandExecution.status ?? "").toLowerCase();
        const failed = exitCode != null && exitCode !== 0 || /fail|error|cancel|abort/.test(status) || /error|fail|exception|traceback/i.test(output.slice(0, 500));
        if (failed) {
          const reason = output || (exitCode != null ? `exit ${exitCode}` : status) || "tool failed";
          recordFailure(partial, `Run ${commandExecution.command ?? pending?.name ?? "command"}`, reason, at, pending?.timelineIndex);
        }
        if (callId) pendingCalls.delete(callId);
      } else if (kind === "custom_tool_call_output") {
        const callId = String(p.call_id ?? p.callId ?? p.id ?? "");
        const output = textFrom(p.output ?? p.result ?? p.text);
        const failed = /error|fail|exception|traceback/i.test(output.slice(0, 500));
        if (callId) customOutputs.set(callId, { text: output, failed, detail: output.slice(0, 300) });
      } else if (kind === "message") {
        const content = textFrom(p.content);
        if (String(p.role ?? "").toLowerCase() === "user" && content && !partial.taskTitle) partial.taskTitle = content.trim().slice(0, 140);
        if (content) partial.toolOutputTokens += estimateTokens(content);
      }
    }
  }
  if (!completedNativeTools) {
    for (const call of customCalls) {
      partial.toolCalls++;
      const index = addToolTimeline(partial, call.sec, call.name, call.args);
      const result = customOutputs.get(call.id);
      if (result?.text) partial.toolOutputTokens += estimateTokens(result.text);
      if (result?.failed) recordFailure(partial, call.name, result.detail || "tool failed", call.sec, index);
    }
  }
  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.model && !partial.taskTitle) return null;
  if (startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1e3;
    partial.endedAtMs = endSec * 1e3;
    const d = new Date(startSec * 1e3);
    partial.date = Number.isNaN(d.getTime()) ? "Unknown" : d.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    const input = tokenUsageRecordSeen ? recordInput : eventInput + genericInput;
    const output = tokenUsageRecordSeen ? recordOutput : eventOutput + genericOutput;
    const total = tokenUsageRecordSeen ? recordTotal : eventTotal + genericTotal;
    const cacheRead = tokenUsageRecordSeen ? recordCacheRead : eventCacheRead + genericCacheRead;
    const cacheCreation = tokenUsageRecordSeen ? recordCacheCreation : eventCacheCreation + genericCacheCreation;
    partial.tokenUsage = { input, output, total: total || input + output };
    partial.tokensUnknown = false;
    if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
  }
  partial.approvalsCount = approvals;
  partial.retriesCount = retries;
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}
var codexAdapter = {
  id: "codex",
  async detect() {
    return [];
  },
  async parse(ref) {
    try {
      const content = fs15.readFileSync(ref.sourcePath, "utf-8");
      return parseCodexLines(content.split("\n"), ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath, firstChunk) {
    if (filePath.includes(".codex") || /rollout-.*\.jsonl$/.test(filePath)) return true;
    const t = firstChunk.trimStart().split("\n")[0] || "";
    return t.includes('"session_meta"') || t.includes('"type"') && t.includes('"response_item"');
  }
};

// src/analyzers/runtime/adapters/claude.ts
import * as fs16 from "fs";
import * as path16 from "path";
function parseTs2(v) {
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1e3) : Math.floor(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1e3);
  }
  return null;
}
function textFrom2(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom2).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const r = value;
    if (typeof r.text === "string") return r.text;
    if (r.content !== void 0) return textFrom2(r.content);
    if (r.message !== void 0) return textFrom2(r.message);
  }
  return "";
}
function parseClaudeLines(lines, filePath) {
  const base = path16.basename(filePath, path16.extname(filePath));
  const partial = emptyPartial(base, "Claude Code");
  partial.sourcePath = filePath;
  let startSec = null;
  let endSec = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let tokensSeen = false;
  let approvals = 0;
  let retries = 0;
  let restores = 0;
  const noteTime = (sec) => {
    if (sec == null) return;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };
  const pushTimeline = (sec, action, tool, status, detail) => {
    const offset = startSec != null ? Math.max(0, sec - startSec) : partial.timeline.length * 30;
    partial.timeline.push({ timeOffset: formatTimeOffset(offset), action, tool, status, detail });
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const sec = parseTs2(evt.timestamp);
    noteTime(sec);
    const at = sec ?? (endSec ?? 0);
    const type = evt.type;
    if (!partial.nativeId && typeof evt.sessionId === "string") partial.nativeId = evt.sessionId;
    if (!partial.nativeId && typeof evt.uuid === "string") partial.nativeId = evt.uuid;
    if (!partial.sessionCwd && typeof evt.cwd === "string") partial.sessionCwd = evt.cwd;
    if (typeof evt.gitBranch === "string" && !partial.gitBranch) partial.gitBranch = evt.gitBranch;
    if (typeof evt.gitCommit === "string" && !partial.gitCommit) partial.gitCommit = evt.gitCommit;
    if (typeof evt.prNumber === "number" && partial.prNumber === void 0) partial.prNumber = evt.prNumber;
    if (typeof evt.prTitle === "string" && !partial.prTitle) partial.prTitle = evt.prTitle;
    if (typeof evt.prState === "string" && !partial.prState) partial.prState = evt.prState;
    if (typeof evt.taskTitle === "string" && !partial.taskTitle) partial.taskTitle = evt.taskTitle.slice(0, 140);
    if (typeof evt.version === "string" && !partial.model) partial.model = `claude (${evt.version})`;
    const contextWindow = Number(evt.contextWindowTokens ?? evt.context_window ?? evt.modelContextWindow ?? evt.model_context_window);
    if (Number.isFinite(contextWindow) && contextWindow > 0) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
    const nativeRetry = Number(evt.retryCount ?? evt.retry_count ?? evt.retries);
    if (Number.isFinite(nativeRetry) && nativeRetry > 0) retries += nativeRetry;
    else if (evt.retry === true || evt.retried === true) retries++;
    if (evt.approvalRequired === true || evt.approval_required === true || evt.permissionRequired === true) approvals++;
    if (evt.permissionMode && typeof evt.permissionMode === "string") {
    }
    if (type === "file-history-snapshot") {
      restores++;
      retries++;
      continue;
    }
    if (type === "queue-operation") {
      retries++;
      continue;
    }
    if (type === "progress") {
      const msg = String(evt.data?.message ?? evt.message ?? "");
      if (/permission|approv|confirm/i.test(msg)) approvals++;
      continue;
    }
    if (type === "system") {
      const msg = String(evt.message ?? evt.subtype ?? "");
      if (/permission|approv|hook/i.test(msg)) approvals++;
      continue;
    }
    if (type === "assistant") {
      const msg = evt.message ?? {};
      if (typeof msg.model === "string") partial.model = msg.model;
      const usage = msg.usage ?? evt.usage;
      if (usage && typeof usage === "object") {
        const i = Number(usage.input_tokens ?? 0);
        const o = Number(usage.output_tokens ?? 0);
        const cr = Number(usage.cache_read_input_tokens ?? 0);
        const cc = Number(usage.cache_creation_input_tokens ?? 0);
        if (i > 0 || o > 0 || cr > 0 || cc > 0) {
          inputTokens += i;
          outputTokens += o;
          cacheRead += cr;
          cacheCreation += cc;
          tokensSeen = true;
          partial.contextTokens = Math.max(partial.contextTokens ?? 0, i);
        }
      }
      const usageContext = Number(usage?.context_window ?? usage?.contextWindowTokens ?? usage?.model_context_window);
      if (Number.isFinite(usageContext) && usageContext > 0) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, usageContext);
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            continue;
          }
          if (block.type === "tool_use") {
            const name = String(block.name ?? "tool");
            const input = block.input ?? {};
            partial.toolCalls++;
            if (name === "Read") {
              const fp = String(input.file_path ?? input.path ?? "");
              if (fp) partial.filesRead.push(fp);
              pushTimeline(at, `Read ${fp || name}`.slice(0, 200), name, "success");
            } else if (name === "Write" || name === "Edit") {
              const fp = String(input.file_path ?? input.path ?? "");
              if (fp) partial.filesEdited.push(fp);
              pushTimeline(at, `Edit ${fp || name}`.slice(0, 200), name, "success");
            } else if (name === "Bash") {
              const cmd = String(input.command ?? input.cmd ?? name);
              partial.commandsExecuted++;
              pushTimeline(at, `Run ${cmd}`.slice(0, 200), name, "success");
            } else if (name === "Grep" || name === "Glob") {
              const q = String(input.pattern ?? input.path ?? name);
              partial.searchOperations.push(q);
              pushTimeline(at, `Search ${q}`.slice(0, 200), name, "success");
            } else if (name === "Task") {
              retries++;
              const desc = String(input.description ?? input.prompt ?? name).slice(0, 120);
              pushTimeline(at, `Task ${desc}`.slice(0, 200), name, "success");
            } else {
              pushTimeline(at, `${name}`, name, "success");
            }
          }
        }
      }
      continue;
    }
    if (type === "user") {
      const content = evt.message?.content ?? evt.content;
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result" || block.tool_use_id) {
          const out = textFrom2(block.content ?? block.text ?? "");
          if (out) partial.toolOutputTokens += estimateTokens(out);
          const isErr = block.is_error === true || /error|failed|exception|ENOENT/i.test(out.slice(0, 400));
          if (isErr) {
            partial.failedToolCalls++;
            const idx = partial.timeline.length - 1;
            const reason = out.slice(0, 300);
            if (idx >= 0) {
              partial.timeline[idx].status = "failed";
              partial.timeline[idx].detail = reason;
            }
            if (!partial.failureReasons) partial.failureReasons = [];
            const action = idx >= 0 ? partial.timeline[idx].action : "tool";
            partial.failureReasons.push({ action, reason });
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          if (!partial.taskTitle && block.text.trim().length > 0) {
            partial.taskTitle = block.text.trim().slice(0, 140);
          }
        }
      }
      continue;
    }
  }
  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen) return null;
  if (startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1e3;
    partial.endedAtMs = endSec * 1e3;
    const d = new Date(startSec * 1e3);
    partial.date = Number.isNaN(d.getTime()) ? "Unknown" : d.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    partial.tokenUsage = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
    partial.tokensUnknown = false;
    if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
  }
  partial.approvalsCount = approvals;
  partial.retriesCount = retries;
  partial.restoresCount = restores;
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId || base;
  return finalizeSession(partial);
}
var claudeAdapter = {
  id: "claude",
  async detect() {
    return [];
  },
  async parse(ref) {
    try {
      const content = fs16.readFileSync(ref.sourcePath, "utf-8");
      return parseClaudeLines(content.split("\n"), ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath, firstChunk) {
    if (filePath.includes(".claude/projects")) return true;
    const t = firstChunk.trimStart().split("\n")[0] || "";
    return t.includes('"tool_use"') && (t.includes('"sessionId"') || t.includes('"parentUuid"'));
  }
};

// src/analyzers/runtime/adapters/cursor.ts
import * as fs17 from "fs";
import * as path17 from "path";
function parseTs3(value) {
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1e3) : Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1e3);
  }
  return null;
}
function asRecord2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function textFromContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value;
    if (typeof record.text === "string") return record.text;
    if (record.content !== void 0) return textFromContent(record.content);
    if (record.output !== void 0) return textFromContent(record.output);
  }
  return "";
}
function taskText(value) {
  const query = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1];
  return (query || value).replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "").trim();
}
function numberFrom2(...values) {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
function usageFrom(value) {
  const usage = asRecord2(value);
  if (Object.keys(usage).length === 0) return null;
  const input = numberFrom2(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens) ?? 0;
  const output = numberFrom2(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens) ?? 0;
  const total = numberFrom2(usage.total_tokens, usage.totalTokens, usage.total) ?? input + output;
  const cacheRead = numberFrom2(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cacheReadInputTokens) ?? 0;
  const cacheCreation = numberFrom2(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) ?? 0;
  if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && cacheCreation === 0) return null;
  return { input, output, total, cacheRead, cacheCreation };
}
function inputRecord(block) {
  return asRecord2(block.input ?? block.arguments ?? block.params ?? block.args);
}
function addFailure(partial, action, reason, at) {
  const detail = reason.slice(0, 300);
  partial.failedToolCalls++;
  partial.timeline.push({ timeOffset: formatTimeOffset(at), action: action.slice(0, 200), tool: "cursor", status: "failed", detail });
  if (!partial.failureReasons) partial.failureReasons = [];
  partial.failureReasons.push({ action: action.slice(0, 200), reason: detail });
}
function parseCursorLines(lines, filePath) {
  const base = path17.basename(filePath, path17.extname(filePath));
  const partial = emptyPartial(base, "Cursor");
  partial.sourcePath = filePath;
  let startSec = null;
  let endSec = null;
  let tokensSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedTotal = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let realTimestamps = false;
  let eventIndex = 0;
  let approvals = 0;
  let retries = 0;
  let restores = 0;
  const toolIndexes = /* @__PURE__ */ new Map();
  const noteTime = (sec) => {
    if (sec == null) return;
    realTimestamps = true;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let evt;
    try {
      evt = asRecord2(JSON.parse(line));
    } catch {
      continue;
    }
    eventIndex++;
    const message = asRecord2(evt.message);
    const sec = parseTs3(evt.timestamp ?? evt.createdAt ?? evt.created_at ?? message.timestamp);
    noteTime(sec);
    const at = sec ?? Math.max(0, (eventIndex - 1) * 30);
    const nativeId = evt.sessionId ?? evt.session_id ?? evt.conversationId ?? evt.conversation_id;
    if (!partial.nativeId && typeof nativeId === "string") partial.nativeId = nativeId;
    if (!partial.sessionCwd && typeof evt.cwd === "string") partial.sessionCwd = evt.cwd;
    if (!partial.sessionCwd && typeof evt.workspaceRoot === "string") partial.sessionCwd = evt.workspaceRoot;
    if (typeof evt.model === "string" && !partial.model) partial.model = evt.model;
    if (typeof evt.gitBranch === "string" && !partial.gitBranch) partial.gitBranch = evt.gitBranch;
    if (typeof evt.gitCommit === "string" && !partial.gitCommit) partial.gitCommit = evt.gitCommit;
    if (typeof evt.prNumber === "number" && partial.prNumber === void 0) partial.prNumber = evt.prNumber;
    if (typeof evt.prTitle === "string" && !partial.prTitle) partial.prTitle = evt.prTitle;
    const usage = usageFrom(evt.usage ?? message.usage ?? evt.tokens ?? message.tokens);
    if (usage) {
      inputTokens += usage.input;
      outputTokens += usage.output;
      reportedTotal += usage.total;
      cacheRead += usage.cacheRead;
      cacheCreation += usage.cacheCreation;
      tokensSeen = true;
      partial.contextTokens = Math.max(partial.contextTokens ?? 0, usage.input);
    }
    const contextWindow = numberFrom2(
      evt.contextWindowTokens,
      evt.context_window,
      evt.modelContextWindow,
      evt.model_context_window,
      message.contextWindowTokens,
      message.context_window
    );
    if (contextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
    const observedContext = numberFrom2(evt.contextTokens, evt.context_tokens, message.contextTokens, message.context_tokens);
    if (observedContext != null) partial.contextTokens = Math.max(partial.contextTokens ?? 0, observedContext);
    const role = String(evt.role ?? evt.type ?? message.role ?? "").toLowerCase();
    const eventType = String(evt.type ?? "").toLowerCase();
    const content = message.content ?? evt.content;
    const blocks = Array.isArray(content) ? content : content == null ? [] : [content];
    const recordText = textFromContent(content);
    const signalText = `${eventType} ${role} ${recordText} ${textFromContent(evt.error)}`;
    const explicitApproval = evt.approvalRequired === true || evt.approval_required === true || message.approvalRequired === true || message.approval_required === true;
    if (explicitApproval || /approval|permission/i.test(signalText) && /request|requested|denied|blocked|confirm|approval/i.test(signalText)) approvals++;
    const explicitRetry = numberFrom2(evt.retryCount, evt.retry_count, message.retryCount, message.retry_count);
    if (explicitRetry != null) retries += explicitRetry;
    else if (evt.retry === true || evt.retried === true || message.retry === true || message.retried === true || /\bretr(?:y|ied|ies)\b/i.test(eventType)) retries++;
    if (evt.restore === true || evt.restored === true || /restore|checkpoint|rollback/i.test(eventType)) restores++;
    if ((role === "user" || eventType === "user") && recordText.trim() && !partial.taskTitle) {
      partial.taskTitle = taskText(recordText).slice(0, 140);
    }
    for (const rawBlock of blocks) {
      const block = asRecord2(rawBlock);
      const blockType = String(block.type ?? block.kind ?? "").toLowerCase();
      if (blockType === "tool_use" || blockType === "tool_call" || blockType === "tooluse") {
        const name = String(block.name ?? block.tool_name ?? block.toolName ?? "tool");
        const input = inputRecord(block);
        const callId = String(block.id ?? block.tool_use_id ?? block.call_id ?? `${partial.toolCalls}`);
        partial.toolCalls++;
        const lowerName = name.toLowerCase();
        const file = String(input.file_path ?? input.path ?? input.file ?? "");
        const query = String((input.pattern ?? input.query ?? input.glob_pattern ?? input.glob ?? file) || name);
        let action = name;
        if (/read|view|cat|open/.test(lowerName)) {
          if (file) partial.filesRead.push(file);
          action = `Read ${file || name}`;
        } else if (/write|edit|apply|replace|patch|delete/.test(lowerName)) {
          if (file) partial.filesEdited.push(file);
          action = `Edit ${file || name}`;
        } else if (/grep|glob|search|find/.test(lowerName)) {
          partial.searchOperations.push(query);
          action = `Search ${query}`;
        } else if (/bash|shell|terminal|command|exec|run/.test(lowerName)) {
          const command = String(input.command ?? input.cmd ?? input.script ?? name);
          partial.commandsExecuted++;
          action = `Run ${command}`;
        }
        const index = partial.timeline.length;
        partial.timeline.push({ timeOffset: formatTimeOffset(at), action: action.slice(0, 200), tool: name, status: "success" });
        toolIndexes.set(callId, index);
        const inlineResult = block.result ?? block.output;
        if (inlineResult !== void 0) {
          const output = textFromContent(inlineResult);
          if (output) partial.toolOutputTokens += estimateTokens(output);
          if (block.is_error === true || /error|failed|exception/i.test(output.slice(0, 400))) {
            partial.timeline[index].status = "failed";
            partial.timeline[index].detail = output.slice(0, 300);
            partial.failedToolCalls++;
            if (!partial.failureReasons) partial.failureReasons = [];
            partial.failureReasons.push({ action: action.slice(0, 200), reason: output.slice(0, 300) || "tool error" });
          }
        }
        continue;
      }
      if (blockType === "tool_result" || blockType === "tooloutput" || block.tool_use_id !== void 0) {
        const output = textFromContent(block.content ?? block.output ?? block.result ?? block.text);
        if (output) partial.toolOutputTokens += estimateTokens(output);
        const isError = block.is_error === true || block.isError === true || /error|failed|exception|denied|ENOENT/i.test(output.slice(0, 500));
        const callId = String(block.tool_use_id ?? block.toolCallId ?? block.call_id ?? "");
        const index = callId ? toolIndexes.get(callId) : void 0;
        if (isError) {
          if (index !== void 0) {
            partial.timeline[index].status = "failed";
            partial.timeline[index].detail = output.slice(0, 300) || "tool error";
            const action = partial.timeline[index].action;
            if (!partial.failureReasons) partial.failureReasons = [];
            partial.failureReasons.push({ action, reason: output.slice(0, 300) || "tool error" });
            partial.failedToolCalls++;
          } else {
            addFailure(partial, "Cursor tool", output || "tool error", at);
          }
        }
      }
    }
    if (eventType === "turn_ended" || eventType === "turn_end" || eventType === "error" || role === "error") {
      const status = String(evt.status ?? evt.state ?? "").toLowerCase();
      const errorText = textFromContent(evt.error ?? evt.message ?? evt.detail ?? evt.reason);
      if (/error|fail|cancel|abort/.test(status) || eventType === "error" || role === "error") {
        addFailure(partial, "Cursor turn", errorText || status || "session error", at);
      }
    }
  }
  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.taskTitle) return null;
  if (realTimestamps && startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1e3;
    partial.endedAtMs = endSec * 1e3;
    const date = new Date(startSec * 1e3);
    partial.date = Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    partial.tokenUsage = { input: inputTokens, output: outputTokens, total: reportedTotal || inputTokens + outputTokens };
    partial.tokensUnknown = false;
    if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
  }
  partial.approvalsCount = approvals;
  partial.retriesCount = retries;
  partial.restoresCount = restores;
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}
var cursorAdapter = {
  id: "cursor",
  async detect() {
    return [];
  },
  async parse(ref) {
    try {
      return parseCursorLines(fs17.readFileSync(ref.sourcePath, "utf-8").split("\n"), ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath, firstChunk) {
    const normalized = filePath.replaceAll(path17.sep, "/");
    if (normalized.includes("/.cursor/") || normalized.includes("/agent-transcripts/")) return true;
    const head = firstChunk.trimStart();
    return head.includes('"tool_use"') && (head.includes('"role":"assistant"') || head.includes('"role": "assistant"') || head.includes('"type":"tool_use"'));
  }
};

// src/analyzers/runtime/adapters/gemini.ts
import * as fs18 from "fs";
import * as path18 from "path";
function parseTs4(value) {
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1e3) : Math.floor(value);
  if (typeof value === "string") {
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value);
      return Number.isFinite(n) ? n > 1e12 ? Math.floor(n / 1e3) : Math.floor(n) : null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1e3);
  }
  return null;
}
function asRecord3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function textFrom3(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom3).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const r = value;
    if (typeof r.text === "string") return r.text;
    if (r.content !== void 0) return textFrom3(r.content);
    if (r.output !== void 0) return textFrom3(r.output);
    if (r.result !== void 0) return textFrom3(r.result);
  }
  return "";
}
function numberFrom3(...values) {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
function recordingToolInput(tool) {
  const input = tool.args ?? tool.input ?? tool.inputs ?? tool.arguments;
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return asRecord3(parsed);
    } catch {
      return { _raw: input };
    }
  }
  return {};
}
function parseGeminiRecording(records, filePath) {
  if (records.length === 0) return null;
  const base = path18.basename(filePath, path18.extname(filePath));
  const partial = emptyPartial(base, "Gemini CLI");
  partial.sourcePath = filePath;
  let startSec = null;
  let endSec = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheRead = 0;
  let tokensSeen = false;
  const noteTime = (value) => {
    const sec = parseTs4(value);
    if (sec == null) return;
    if (startSec == null || sec < startSec) startSec = sec;
    if (endSec == null || sec > endSec) endSec = sec;
  };
  const normalized = [];
  for (const record of records) {
    if (Array.isArray(record.messages)) {
      for (const message of record.messages) normalized.push(asRecord3(message));
      if (record.sessionId) partial.nativeId = String(record.sessionId);
      if (typeof record.model === "string") partial.model = record.model;
      if (typeof record.cwd === "string") partial.sessionCwd = record.cwd;
      if (record.startTime !== void 0) noteTime(record.startTime);
      if (record.lastUpdated !== void 0) noteTime(record.lastUpdated);
    } else {
      normalized.push(record);
      if (record.sessionId && !partial.nativeId) partial.nativeId = String(record.sessionId);
      if (typeof record.model === "string" && !partial.model) partial.model = record.model;
      if (typeof record.cwd === "string" && !partial.sessionCwd) partial.sessionCwd = record.cwd;
      if (record.startTime !== void 0) noteTime(record.startTime);
      if (record.lastUpdated !== void 0) noteTime(record.lastUpdated);
    }
  }
  let messageIndex = 0;
  for (const message of normalized) {
    const type = String(message.type ?? message.role ?? "").toLowerCase();
    const at = parseTs4(message.timestamp ?? message.time) ?? messageIndex++ * 45;
    const content = message.content ?? message.message ?? message.text;
    const contentText = textFrom3(content);
    if (type === "user" && contentText.trim() && !partial.taskTitle) partial.taskTitle = contentText.trim().slice(0, 140);
    if (type === "gemini" || type === "assistant" || message.model) {
      if (typeof message.model === "string") partial.model = message.model;
      const tokens = asRecord3(message.tokens ?? message.usage);
      const i = numberFrom3(tokens.input, tokens.input_tokens, tokens.prompt, tokens.prompt_tokens) ?? 0;
      const o = numberFrom3(tokens.output, tokens.output_tokens, tokens.completion, tokens.completion_tokens) ?? 0;
      const thoughts = numberFrom3(tokens.thoughts, tokens.thought_tokens) ?? 0;
      const total = numberFrom3(tokens.total, tokens.total_tokens) ?? i + o + thoughts;
      const cached = numberFrom3(tokens.cached, tokens.cached_input_tokens, tokens.cache_read_input_tokens) ?? 0;
      if (i > 0 || o > 0 || thoughts > 0 || total > 0 || cached > 0) {
        inputTokens += i;
        outputTokens += o + thoughts;
        totalTokens += total;
        cacheRead += cached;
        tokensSeen = true;
        partial.contextTokens = Math.max(partial.contextTokens ?? 0, i);
      }
      const contextWindow = numberFrom3(message.contextWindowTokens, message.context_window, message.modelContextWindow, message.model_context_window);
      if (contextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
    }
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawTool of toolCalls) {
      const tool = asRecord3(rawTool);
      const name = String(tool.name ?? tool.tool ?? "tool");
      const lowerName = name.toLowerCase();
      const input = recordingToolInput(tool);
      const output = textFrom3(tool.result ?? tool.output ?? tool.outputs);
      const status = String(tool.status ?? "success").toLowerCase();
      const failed = status === "error" || status === "failed" || status === "failure" || tool.ok === false || /error|failed|exception/i.test(output.slice(0, 500));
      partial.toolCalls++;
      if (output) partial.toolOutputTokens += estimateTokens(output);
      let action = name;
      if (/bash|shell|command|exec|run|terminal/.test(lowerName)) {
        partial.commandsExecuted++;
        action = `Run ${String(input.command ?? input.cmd ?? input.script ?? name)}`;
      } else if (/read|view|open|cat/.test(lowerName)) {
        const file = String(input.file_path ?? input.path ?? input.file ?? "");
        if (file) partial.filesRead.push(file);
        action = `Read ${file || name}`;
      } else if (/write|edit|replace|patch|delete/.test(lowerName)) {
        const file = String(input.file_path ?? input.path ?? input.file ?? "");
        if (file) partial.filesEdited.push(file);
        action = `Edit ${file || name}`;
      } else if (/search|grep|glob|find/.test(lowerName)) {
        const query = String(input.pattern ?? input.query ?? input.glob ?? input.path ?? name);
        partial.searchOperations.push(query);
        action = `Search ${query}`;
      }
      partial.timeline.push({
        timeOffset: formatTimeOffset(at),
        action: action.slice(0, 200),
        tool: name,
        status: failed ? "failed" : "success",
        detail: failed ? output.slice(0, 300) || status || "tool error" : void 0
      });
      if (failed) {
        partial.failedToolCalls++;
        if (!partial.failureReasons) partial.failureReasons = [];
        partial.failureReasons.push({ action: action.slice(0, 200), reason: output.slice(0, 300) || status || "tool error" });
      }
    }
    if (type === "error") {
      const reason = (contentText || textFrom3(message.error) || "gemini error").slice(0, 300);
      partial.failedToolCalls++;
      partial.timeline.push({ timeOffset: formatTimeOffset(at), action: "Gemini error", tool: "gemini", status: "failed", detail: reason });
      if (!partial.failureReasons) partial.failureReasons = [];
      partial.failureReasons.push({ action: "Gemini error", reason });
    }
    const retryCount = numberFrom3(message.retryCount, message.retry_count, message.retries);
    if (retryCount != null) partial.retriesCount = (partial.retriesCount || 0) + retryCount;
    else if (message.retry === true || message.retried === true || /\bretr(?:y|ied|ies)\b/i.test(`${type} ${contentText}`)) {
      partial.retriesCount = (partial.retriesCount || 0) + 1;
    }
    const approvalRequired = message.approvalRequired === true || message.approval_required === true || message.permissionRequired === true;
    if (approvalRequired || /approval|permission/i.test(`${type} ${contentText}`)) {
      partial.approvalsCount = (partial.approvalsCount || 0) + 1;
    }
  }
  if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.taskTitle) return null;
  if (startSec != null && endSec != null && endSec >= startSec) {
    partial.durationSeconds = endSec - startSec;
    partial.durationUnknown = false;
    partial.startedAtMs = startSec * 1e3;
    partial.endedAtMs = endSec * 1e3;
    const date = new Date(startSec * 1e3);
    partial.date = Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().slice(0, 10);
  }
  if (tokensSeen) {
    partial.tokenUsage = { input: inputTokens, output: outputTokens, total: totalTokens || inputTokens + outputTokens };
    partial.tokensUnknown = false;
    if (cacheRead > 0) partial.cacheTokens = { read: cacheRead };
  }
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}
function parseGeminiContent(content, filePath) {
  let data;
  const records = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {
    }
  }
  const isRecording = records.some(
    (record) => record.sessionId || record.projectHash || Array.isArray(record.messages) || ["user", "gemini", "assistant", "error", "warning", "info"].includes(String(record.type ?? "").toLowerCase())
  );
  if (isRecording) {
    const recording = parseGeminiRecording(records, filePath);
    if (recording) return recording;
  }
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const base = path18.basename(filePath, path18.extname(filePath));
  const partial = emptyPartial(base, "Gemini CLI");
  partial.sourcePath = filePath;
  const stats = data.stats ?? {};
  const sessionStats = stats.session ?? {};
  const modelStats = stats.model ?? {};
  const toolStats = stats.tools ?? {};
  const err = data.error;
  let toolCalls = Number(toolStats.calls ?? data.toolCalls ?? 0);
  if (stats && (sessionStats.duration != null || toolCalls > 0 || modelStats.turns != null || err)) {
    const durMs = Number(sessionStats.duration ?? 0);
    if (durMs > 0) {
      partial.durationSeconds = Math.floor(durMs / 1e3);
      partial.durationUnknown = false;
    }
    if (toolCalls > 0) partial.toolCalls = toolCalls;
    if (typeof data.response === "string" && data.response) {
      partial.toolOutputTokens += estimateTokens(data.response);
    }
    if (err && typeof err === "object") {
      partial.failedToolCalls = 1;
      partial.failureReasons = [
        { action: "gemini", reason: String(err.message ?? err.type ?? err.code ?? "error").slice(0, 300) }
      ];
      partial.timeline.push({
        timeOffset: formatTimeOffset(0),
        action: "gemini headless run",
        tool: "gemini",
        status: "failed",
        detail: String(err.message ?? err.type ?? "error").slice(0, 300)
      });
    } else if (toolCalls > 0 || typeof data.response === "string") {
      partial.timeline.push({
        timeOffset: formatTimeOffset(0),
        action: `gemini run (${modelStats.turns ?? "?"} turns, ${toolCalls} tool calls)`,
        tool: "gemini",
        status: "success"
      });
    }
    if (typeof data.model === "string") partial.model = data.model;
    if (!partial.nativeId) partial.nativeId = base;
    partial.id = partial.nativeId;
    return finalizeSession(partial);
  }
  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  const responses = Array.isArray(data.responses) ? data.responses : [];
  const tools = Array.isArray(data.tools) ? data.tools : Array.isArray(data.toolExecutions) ? data.toolExecutions : [];
  const usage = data.usage && typeof data.usage === "object" ? data.usage : void 0;
  const hasUsage = !!usage && (usage.input_tokens != null || usage.inputTokens != null || usage.output_tokens != null || usage.outputTokens != null);
  if (prompts.length === 0 && responses.length === 0 && tools.length === 0 && !hasUsage) return null;
  if (!partial.taskTitle && typeof prompts[0] === "string") {
    partial.taskTitle = prompts[0].slice(0, 140);
  } else if (!partial.taskTitle && prompts[0]?.text) {
    partial.taskTitle = String(prompts[0].text).slice(0, 140);
  }
  let t = 0;
  const step = 45;
  for (let i = 0; i < Math.max(prompts.length, responses.length); i++) {
    const pr = prompts[i];
    const rs = responses[i];
    if (pr != null) {
      const text = typeof pr === "string" ? pr : String(pr.text ?? pr.content ?? "prompt");
      if (i === 0) partial.taskTitle = partial.taskTitle || text.slice(0, 140);
      t += step;
    }
    if (rs != null) {
      const text = typeof rs === "string" ? rs : String(rs.text ?? rs.content ?? "");
      if (text) partial.toolOutputTokens += estimateTokens(text);
      t += step;
    }
  }
  for (const tool of tools) {
    const name = String(tool.name ?? tool.tool ?? "tool");
    const input = tool.input ?? tool.inputs ?? {};
    const output = String(tool.output ?? tool.outputs ?? tool.result ?? "");
    partial.toolCalls++;
    if (/bash|shell|command|run/i.test(name)) {
      partial.commandsExecuted++;
      const cmd = String(input.command ?? name);
      const failed = /error|fail/i.test(output.slice(0, 300)) || tool.status === "error" || tool.ok === false;
      if (failed) partial.failedToolCalls++;
      partial.timeline.push({
        timeOffset: formatTimeOffset(t),
        action: `Run ${cmd}`.slice(0, 200),
        tool: name,
        status: failed ? "failed" : "success",
        detail: failed ? output.slice(0, 300) : void 0
      });
    } else if (/read|view/i.test(name)) {
      const fp = String(input.path ?? input.file ?? "");
      if (fp) partial.filesRead.push(fp);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: `Read ${fp || name}`.slice(0, 200), tool: name, status: "success" });
    } else if (/write|edit|replace/i.test(name)) {
      const fp = String(input.path ?? input.file ?? "");
      if (fp) partial.filesEdited.push(fp);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: `Edit ${fp || name}`.slice(0, 200), tool: name, status: "success" });
    } else if (/search|grep|glob|find/i.test(name)) {
      const q = String(input.pattern ?? input.query ?? name);
      partial.searchOperations.push(q);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: `Search ${q}`.slice(0, 200), tool: name, status: "success" });
    } else {
      if (output) partial.toolOutputTokens += estimateTokens(output);
      partial.timeline.push({ timeOffset: formatTimeOffset(t), action: name.slice(0, 200), tool: name, status: "success" });
    }
    t += step;
  }
  const iu = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const ou = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  if (iu > 0 || ou > 0) {
    partial.tokenUsage = { input: iu, output: ou, total: iu + ou };
    partial.tokensUnknown = false;
  }
  if (typeof data.model === "string") partial.model = data.model;
  if (typeof data.durationMs === "number" && data.durationMs > 0) {
    partial.durationSeconds = Math.floor(data.durationMs / 1e3);
    partial.durationUnknown = false;
  } else if (t > 0) {
    partial.durationSeconds = 0;
    partial.durationUnknown = true;
  }
  if (!partial.nativeId) partial.nativeId = base;
  partial.id = partial.nativeId;
  return finalizeSession(partial);
}
var geminiAdapter = {
  id: "gemini",
  async detect() {
    return [];
  },
  async parse(ref) {
    try {
      const content = fs18.readFileSync(ref.sourcePath, "utf-8");
      return parseGeminiContent(content, ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath, firstChunk) {
    if (filePath.includes(".gemini/tmp") || filePath.includes("/chats/")) return true;
    const t = firstChunk.trimStart();
    return t.startsWith("{") && (t.includes('"toolExecutions"') || t.includes('"stats"') && t.includes('"session"') || t.includes('"projectHash"') || t.includes('"sessionId"') || t.includes('"type":"gemini"') && t.includes('"toolCalls"'));
  }
};

// src/analyzers/runtime/adapters/otel.ts
import * as fs19 from "fs";
import * as path19 from "path";
function anyValue(v) {
  if (!v || typeof v !== "object") return void 0;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.intValue !== void 0) return Number(v.intValue);
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (Array.isArray(v.arrayValue?.values)) return JSON.stringify(v.arrayValue.values);
  if (Array.isArray(v.kvlistValue?.values)) {
    return JSON.stringify(Object.fromEntries(v.kvlistValue.values.map((entry) => [entry.key, anyValue(entry.value)])));
  }
  return void 0;
}
function attrsToMap(attrs) {
  const m = /* @__PURE__ */ new Map();
  if (!Array.isArray(attrs)) return m;
  for (const a of attrs) {
    if (!a || typeof a.key !== "string") continue;
    const v = anyValue(a.value);
    if (v !== void 0) m.set(a.key, v);
  }
  return m;
}
function attrText(attrs, ...keys) {
  for (const key of keys) {
    const value = attrs.get(key);
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return void 0;
}
function attrNumber(attrs, ...keys) {
  for (const key of keys) {
    const value = attrs.get(key);
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return void 0;
}
function parseToolArgs(value) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { _raw: String(parsed) };
  } catch {
    return { _raw: value };
  }
}
function nanoToSec(v) {
  if (typeof v === "number") return Math.floor(v / 1e9);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = BigInt(v.trim());
    return Number(n / 1000000000n);
  }
  return null;
}
function extractSpans(doc) {
  const out = [];
  const resourceSpans = doc?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans) {
    const resAttrs = attrsToMap(rs?.resource?.attributes);
    const serviceName = resAttrs.get("service.name") || resAttrs.get("service.namespace");
    const scopeSpans = rs?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = ss?.spans;
      if (!Array.isArray(spans)) continue;
      for (const s of spans) {
        const attrs = new Map(resAttrs);
        for (const [key, value] of attrsToMap(s?.attributes)) attrs.set(key, value);
        out.push({
          traceId: String(s?.traceId ?? ""),
          name: String(s?.name ?? "span"),
          startSec: nanoToSec(s?.startTimeUnixNano),
          endSec: nanoToSec(s?.endTimeUnixNano),
          attrs,
          events: Array.isArray(s?.events) ? s.events.map((event) => ({ name: String(event?.name ?? "event"), attrs: attrsToMap(event?.attributes) })) : [],
          statusCode: typeof s?.status?.code === "number" ? s.status.code : String(s?.status?.code ?? "").toLowerCase() === "error" ? 2 : 0,
          serviceName: typeof serviceName === "string" ? serviceName : void 0
        });
      }
    }
  }
  return out;
}
function mapAgentName(serviceName, provider) {
  const hay = `${serviceName ?? ""} ${provider ?? ""}`.toLowerCase();
  if (hay.includes("claude")) return "Claude Code";
  if (hay.includes("codex") || hay.includes("openai")) return "Codex";
  if (hay.includes("cursor")) return "Cursor";
  if (hay.includes("gemini") || hay.includes("google") || hay.includes("gcp")) return "Gemini CLI";
  if (hay.includes("opencode")) return "OpenCode";
  return "Other";
}
function parseOtelContent(content, filePath) {
  const docs = [];
  const trimmed = content.trim();
  if (!trimmed) return [];
  try {
    const single = JSON.parse(trimmed);
    if (single?.resourceSpans) docs.push(single);
    else throw new Error("not otlp");
  } catch {
    for (const raw of trimmed.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const doc = JSON.parse(line);
        if (doc?.resourceSpans) docs.push(doc);
      } catch {
        continue;
      }
    }
  }
  if (docs.length === 0) return [];
  const spans = docs.flatMap(extractSpans).filter((s) => s.traceId);
  if (spans.length === 0) return [];
  const groups = /* @__PURE__ */ new Map();
  for (const s of spans) {
    const conv = s.attrs.get("gen_ai.conversation.id");
    const key = typeof conv === "string" && conv || s.traceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const base = path19.basename(filePath, path19.extname(filePath));
  const sessions = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
    const first = list.find((s) => s.attrs.get("gen_ai.agent.name") || s.serviceName) ?? list[0];
    const provider = first.attrs.get("gen_ai.provider.name") ?? first.attrs.get("gen_ai.system");
    const agent = first.attrs.get("gen_ai.agent.name") ?? provider;
    const partial = emptyPartial(key.slice(0, 32) || base, mapAgentName(first.serviceName, agent));
    partial.sourcePath = filePath;
    partial.nativeId = key;
    const task = attrText(first.attrs, "gen_ai.task.title", "gen_ai.task", "agent.task.title", "task.title");
    if (task) partial.taskTitle = task.slice(0, 140);
    const cwd = attrText(first.attrs, "gen_ai.session.cwd", "process.cwd", "code.workspace");
    if (cwd) partial.sessionCwd = cwd;
    const branch = attrText(first.attrs, "vcs.repository.ref.name", "git.branch", "vcs.ref.name");
    const commit = attrText(first.attrs, "vcs.ref.head.revision", "git.commit", "vcs.commit");
    if (branch) partial.gitBranch = branch;
    if (commit) partial.gitCommit = commit;
    const prNumber = attrNumber(first.attrs, "vcs.pull_request.number", "git.pr.number", "pr.number");
    if (prNumber != null) partial.prNumber = prNumber;
    const prTitle = attrText(first.attrs, "vcs.pull_request.title", "git.pr.title", "pr.title");
    if (prTitle) partial.prTitle = prTitle.slice(0, 200);
    const starts = list.map((s) => s.startSec).filter((v) => v != null);
    const ends = list.map((s) => s.endSec).filter((v) => v != null);
    const startSec = starts.length ? Math.min(...starts) : null;
    const endSec = ends.length ? Math.max(...ends) : null;
    if (startSec != null && endSec != null && endSec >= startSec) {
      partial.durationSeconds = endSec - startSec;
      partial.durationUnknown = false;
      partial.startedAtMs = startSec * 1e3;
      partial.endedAtMs = endSec * 1e3;
      const d = new Date(startSec * 1e3);
      partial.date = Number.isNaN(d.getTime()) ? "Unknown" : d.toISOString().slice(0, 10);
    }
    const model = first.attrs.get("gen_ai.request.model") || first.attrs.get("gen_ai.response.model");
    if (model) partial.model = model;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let tokensSeen = false;
    for (const s of list) {
      const op = String(s.attrs.get("gen_ai.operation.name") ?? "");
      const lowerOp = op.toLowerCase();
      const at = s.startSec ?? startSec ?? 0;
      const offset = startSec != null && s.startSec != null ? Math.max(0, s.startSec - startSec) : 0;
      const errorType = attrText(s.attrs, "error.type", "exception.type", "error.code");
      const errorMessage = attrText(s.attrs, "error.message", "exception.message", "exception.stacktrace");
      const eventFailure = s.events.some((event) => /error|exception|failure/i.test(event.name));
      const eventErrorMessage = s.events.map((event) => attrText(event.attrs, "error.message", "exception.message", "message")).find(Boolean);
      const failed = s.statusCode === 2 || !!errorType || eventFailure;
      const finish = s.attrs.get("gen_ai.response.finish_reasons");
      for (const event of s.events) {
        const retryCount2 = attrNumber(event.attrs, "gen_ai.retry.count", "retry.count", "agent.retry.count");
        if (retryCount2 != null) partial.retriesCount = (partial.retriesCount || 0) + retryCount2;
        else if (/retry|restore|checkpoint/i.test(event.name)) partial.retriesCount = (partial.retriesCount || 0) + 1;
        const approval2 = attrText(event.attrs, "gen_ai.approval.status", "gen_ai.approval.required", "approval.status", "permission.status");
        if (approval2 && /request|pending|denied|blocked|true|approval/i.test(approval2)) partial.approvalsCount = (partial.approvalsCount || 0) + 1;
      }
      const iNew = attrNumber(s.attrs, "gen_ai.usage.input_tokens", "gen_ai.response.input_tokens");
      const oNew = attrNumber(s.attrs, "gen_ai.usage.output_tokens", "gen_ai.response.output_tokens");
      const iLegacy = attrNumber(s.attrs, "gen_ai.usage.prompt_tokens");
      const oLegacy = attrNumber(s.attrs, "gen_ai.usage.completion_tokens");
      const i = iNew ?? iLegacy ?? 0;
      const o = oNew ?? oLegacy ?? 0;
      if (i > 0 || o > 0) {
        input += i;
        output += o;
        tokensSeen = true;
        partial.contextTokens = Math.max(partial.contextTokens ?? 0, i);
      }
      const cr = attrNumber(s.attrs, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_tokens", "gen_ai.usage.cached_input_tokens") ?? 0;
      const cc = attrNumber(s.attrs, "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_tokens") ?? 0;
      if (cr > 0 || cc > 0) {
        cacheRead += cr;
        cacheCreation += cc;
        tokensSeen = true;
      }
      const contextWindow = attrNumber(
        s.attrs,
        "gen_ai.request.max_tokens",
        "gen_ai.request.context_window",
        "gen_ai.request.context_window_tokens",
        "gen_ai.response.model_context_window",
        "context.window.size",
        "context_window_tokens"
      );
      if (contextWindow != null) partial.contextWindowTokens = Math.max(partial.contextWindowTokens ?? 0, contextWindow);
      const retryCount = attrNumber(s.attrs, "gen_ai.retry.count", "retry.count", "agent.retry.count");
      if (retryCount != null) partial.retriesCount = (partial.retriesCount || 0) + retryCount;
      else if (/retry|restore|checkpoint/i.test(`${s.name} ${op}`)) partial.retriesCount = (partial.retriesCount || 0) + 1;
      const approval = attrText(s.attrs, "gen_ai.approval.status", "gen_ai.approval.required", "approval.status", "permission.status");
      if (approval && /request|pending|denied|blocked|true|approval/i.test(approval)) partial.approvalsCount = (partial.approvalsCount || 0) + 1;
      if (lowerOp === "execute_tool" || lowerOp === "tool") {
        const toolName = String(s.attrs.get("gen_ai.tool.name") ?? "tool");
        partial.toolCalls++;
        if (failed) {
          partial.failedToolCalls++;
          if (!partial.failureReasons) partial.failureReasons = [];
          partial.failureReasons.push({
            action: `Tool ${toolName}`.slice(0, 200),
            reason: (errorMessage || errorType || eventErrorMessage || "span error").slice(0, 300)
          });
        }
        const argsValue = s.attrs.get("gen_ai.tool.call.arguments") ?? s.attrs.get("gen_ai.tool.input");
        const args = parseToolArgs(argsValue);
        const toolOutput = attrText(s.attrs, "gen_ai.tool.call.result", "gen_ai.tool.output", "gen_ai.tool.response");
        if (toolOutput) partial.toolOutputTokens += estimateTokens(toolOutput);
        const file = String(args.path ?? args.file ?? args.file_path ?? "");
        const lowerTool = toolName.toLowerCase();
        let action = `Tool ${toolName}`;
        if (/bash|shell|command|exec|terminal|run/.test(lowerTool)) {
          partial.commandsExecuted++;
          action = `Run ${String(args.command ?? args.cmd ?? args._raw ?? toolName)}`;
        } else if (/read|view|open|cat/.test(lowerTool)) {
          if (file) partial.filesRead.push(file);
          action = `Read ${file || toolName}`;
        } else if (/write|edit|patch|replace|delete/.test(lowerTool)) {
          if (file) partial.filesEdited.push(file);
          action = `Edit ${file || toolName}`;
        } else if (/search|grep|glob|find/.test(lowerTool)) {
          const query = String(args.pattern ?? args.query ?? args.path ?? args._raw ?? toolName);
          partial.searchOperations.push(query);
          action = `Search ${query}`;
        }
        partial.timeline.push({
          timeOffset: formatTimeOffset(offset),
          action: action.slice(0, 200),
          tool: toolName,
          status: failed ? "failed" : "success",
          detail: failed ? (errorMessage || errorType || eventErrorMessage || String(finish ?? "span error")).slice(0, 300) : finish != null ? String(finish).slice(0, 200) : void 0
        });
        void at;
        continue;
      }
      if (lowerOp === "chat" || lowerOp === "generate_content" || lowerOp === "text_completion" || lowerOp === "invoke_agent") {
        if (lowerOp === "invoke_agent" && partial.timeline.length < 200) {
          partial.timeline.push({
            timeOffset: formatTimeOffset(offset),
            action: s.name.slice(0, 200),
            status: failed ? "failed" : "success",
            detail: failed ? (errorMessage || errorType || eventErrorMessage || "span error").slice(0, 300) : finish != null ? String(finish).slice(0, 200) : void 0
          });
        }
        if (failed) {
          if (!partial.failureReasons) partial.failureReasons = [];
          partial.failedToolCalls++;
          partial.failureReasons.push({ action: s.name.slice(0, 200), reason: (errorMessage || errorType || eventErrorMessage || "span error").slice(0, 300) });
        }
        continue;
      }
      if (lowerOp === "retrieval") {
        const q = attrText(s.attrs, "gen_ai.retrieval.query_text", "gen_ai.tool.call.query");
        if (q) partial.searchOperations.push(q.slice(0, 200));
        continue;
      }
    }
    if (tokensSeen) {
      partial.tokenUsage = { input, output, total: input + output };
      partial.tokensUnknown = false;
      if (cacheRead > 0 || cacheCreation > 0) partial.cacheTokens = { read: cacheRead, creation: cacheCreation };
    } else {
      partial.toolOutputTokens = 0;
    }
    if (partial.toolCalls === 0 && partial.timeline.length === 0 && !tokensSeen && !partial.taskTitle && partial.contextWindowTokens == null) continue;
    sessions.push(finalizeSession(partial));
  }
  return sessions;
}
var otelAdapter = {
  id: "otel",
  async detect() {
    return [];
  },
  async parse(ref) {
    const all = await this.parseMany(ref);
    return all[0] ?? null;
  },
  async parseMany(ref) {
    try {
      const content = fs19.readFileSync(ref.sourcePath, "utf-8");
      return parseOtelContent(content, ref.sourcePath);
    } catch {
      return [];
    }
  },
  canParseFile(_filePath, firstChunk) {
    const t = firstChunk.trimStart().slice(0, 500);
    return t.includes('"resourceSpans"');
  }
};

// src/analyzers/runtime/sessionDetect.ts
import * as fs20 from "fs";
import * as os2 from "os";
import * as path20 from "path";
import { createHash as createHash2 } from "crypto";
import fg4 from "fast-glob";
var REPO_SESSION_GLOBS = [
  ".agent/sessions/**/*.{json,jsonl}",
  ".claude/sessions/**/*.{json,jsonl}",
  ".sessions/**/*.{json,jsonl}",
  "sessions/**/*.{json,jsonl}",
  ".agent/otel-traces.jsonl",
  ".cursor/agent-transcripts/**/*.{json,jsonl}",
  ".cursor/sessions/**/*.{json,jsonl}"
  // Back-compat: top-level single globs are covered by ** above.
];
var MAX_GLOBAL_BYTES_SNIFF = 4096;
var MAX_GLOBAL_FILES_SCANNED = 120;
function statRef(agent, p) {
  try {
    const st = fs20.statSync(p);
    if (!st.isFile()) return null;
    return { agent, sourcePath: p, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}
function readHead(p) {
  try {
    const fd = fs20.openSync(p, "r");
    try {
      const buf = Buffer.alloc(MAX_GLOBAL_BYTES_SNIFF);
      const n = fs20.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf-8");
    } finally {
      fs20.closeSync(fd);
    }
  } catch {
    return "";
  }
}
function encodeClaudeProjectDir(repoRoot) {
  return repoRoot.replace(/\//g, "-");
}
function encodeGeminiProjectHash(repoRoot) {
  return createHash2("sha256").update(path20.resolve(repoRoot)).digest("hex");
}
function encodeCursorProjectDir(repoRoot) {
  return path20.resolve(repoRoot).replace(/^[/\\]+/, "").replace(/[\\/]/g, "-");
}
function matchCodexCwd(head, repoRoot) {
  return head.includes(`"cwd":"${repoRoot}"`) || head.includes(`"cwd": "${repoRoot}"`);
}
async function detectGlobalSessions(repoRoot, maxGlobalSessions = 20) {
  const home = os2.homedir();
  const found = [];
  const push = (r) => {
    if (r) found.push(r);
  };
  try {
    const dir = path20.join(home, ".claude", "projects", encodeClaudeProjectDir(repoRoot));
    if (fs20.existsSync(dir)) {
      const files = await fg4(["*.jsonl"], { cwd: dir, onlyFiles: true, absolute: true });
      for (const f of files) push(statRef("claude", f));
    }
  } catch {
  }
  try {
    const codexDir = path20.join(home, ".codex", "sessions");
    if (fs20.existsSync(codexDir)) {
      const files = await fg4(["**/*.jsonl"], {
        cwd: codexDir,
        onlyFiles: true,
        absolute: true,
        stats: true
      });
      const sorted = files.map((e) => typeof e === "string" ? { path: e, stats: void 0 } : e).sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0)).slice(0, MAX_GLOBAL_FILES_SCANNED);
      for (const e of sorted) {
        const p = e.path ?? e;
        if (matchCodexCwd(readHead(p), repoRoot)) push(statRef("codex", p));
        if (found.filter((f) => f.agent === "codex").length >= maxGlobalSessions) break;
      }
    }
  } catch {
  }
  try {
    const cursorProjects = path20.join(home, ".cursor", "projects");
    const encoded = encodeCursorProjectDir(repoRoot);
    const candidates = [.../* @__PURE__ */ new Set([encoded, `-${encoded}`])];
    for (const projectDir of candidates) {
      const dir = path20.join(cursorProjects, projectDir);
      if (!fs20.existsSync(dir)) continue;
      const files = await fg4(["agent-transcripts/**/*.{json,jsonl}"], {
        cwd: dir,
        onlyFiles: true,
        absolute: true,
        stats: true
      });
      for (const e of files) {
        const p = typeof e === "string" ? e : e.path;
        push(statRef("cursor", p));
      }
    }
  } catch {
  }
  try {
    const configuredGeminiHome = process.env.GEMINI_CLI_HOME;
    const geminiTmpDirs = configuredGeminiHome ? [path20.join(configuredGeminiHome, "tmp"), path20.join(configuredGeminiHome, ".gemini", "tmp")] : [path20.join(home, ".gemini", "tmp")];
    for (const geminiTmp of [...new Set(geminiTmpDirs)]) {
      if (!fs20.existsSync(geminiTmp)) continue;
      const projectHash = encodeGeminiProjectHash(repoRoot);
      const directDir = path20.join(geminiTmp, projectHash, "chats");
      let files = [];
      if (fs20.existsSync(directDir)) {
        files = await fg4(["*.{json,jsonl}"], {
          cwd: directDir,
          onlyFiles: true,
          absolute: true,
          stats: true
        });
      }
      if (files.length === 0) {
        files = await fg4(["*/chats/*.{json,jsonl}"], {
          cwd: geminiTmp,
          onlyFiles: true,
          absolute: true,
          stats: true
        });
      }
      const sorted = files.map((e) => typeof e === "string" ? { path: e, stats: void 0 } : e).sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0)).slice(0, MAX_GLOBAL_FILES_SCANNED);
      for (const e of sorted) {
        const p = e.path ?? e;
        const head = readHead(p);
        if (p.startsWith(`${directDir}${path20.sep}`) || head.includes(`"projectHash":"${projectHash}"`) || head.includes(`"projectHash": "${projectHash}"`)) {
          push(statRef("gemini", p));
        }
        if (found.filter((f) => f.agent === "gemini").length >= maxGlobalSessions) break;
      }
    }
  } catch {
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, maxGlobalSessions);
}
async function detectRepoSessions(repoRoot) {
  const out = [];
  try {
    const files = await fg4(REPO_SESSION_GLOBS, { cwd: repoRoot, dot: true, onlyFiles: true, absolute: true });
    for (const f of files.sort()) {
      const normalized = f.replaceAll(path20.sep, "/");
      const agent = normalized.includes("/.cursor/") || normalized.includes("/agent-transcripts/") ? "cursor" : normalized.includes("/otel-traces") ? "otel" : f.endsWith(".jsonl") ? "claude" : "agentdoctor";
      const ref = statRef(agent, f);
      if (ref) out.push(ref);
    }
  } catch {
  }
  return out;
}
function shouldIncludeGlobal(includeGlobal) {
  if (includeGlobal !== void 0) return includeGlobal;
  return process.env.AGENTDOCTOR_INCLUDE_GLOBAL !== "0";
}

// src/analyzers/runtime/redact.ts
var PATTERNS = [
  { type: "PRIVATE_KEY", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    type: "ASSIGNMENT",
    // api_key=..., password: "...", secret='...' — keep the key name, redact the value.
    regex: /((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|token|secret|passwd|password|private[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)([^"'\s,;}]{4,})(["']?)/gi
  },
  {
    type: "CLI_SECRET",
    regex: /((?:--?|\/)(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|token|secret|passwd|password)\s+)([^"'\s,;}]{4,})/gi
  },
  { type: "OPENAI_KEY", regex: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { type: "GITHUB_TOKEN", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g },
  { type: "SLACK_TOKEN", regex: /\bxox[bpas]-[A-Za-z0-9-]{6,}\b/g },
  { type: "AWS_KEY", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GOOGLE_KEY", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: "NPM_TOKEN", regex: /\bnpm_[A-Za-z0-9]{10,}\b/g },
  { type: "JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "BEARER", regex: /\b(Bearer\s+)[A-Za-z0-9\-._~+/=]{8,}/g }
];
function redactText(input) {
  if (!input) return { text: input, redactedCount: 0 };
  let text = input;
  let redactedCount = 0;
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    if (p.type === "BEARER") {
      text = text.replace(p.regex, (_m, prefix) => {
        redactedCount++;
        return `${prefix}[REDACTED:BEARER]`;
      });
    } else if (p.type === "ASSIGNMENT") {
      text = text.replace(p.regex, (_m, pre, _val, post) => {
        redactedCount++;
        return `${pre}[REDACTED:${p.type}]${post}`;
      });
    } else if (p.type === "CLI_SECRET") {
      text = text.replace(p.regex, (_m, pre) => {
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
function redactString(value) {
  if (value === void 0) return { value, count: 0 };
  const r = redactText(value);
  return { value: r.text, count: r.redactedCount };
}
function redactStringArray(values) {
  let count = 0;
  const next = values.map((value) => {
    const r = redactText(value);
    count += r.redactedCount;
    return r.text;
  });
  return { values: next, count };
}
function redactEvent(ev) {
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
function redactSession(session) {
  let total = session.redactedFields || 0;
  for (const key of ["id", "nativeId", "model", "sessionCwd", "gitBranch", "gitCommit", "prState"]) {
    const r = redactString(session[key]);
    session[key] = r.value;
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
  const repeats = deriveSessionRepeats(session.filesRead, session.searchOperations, session.timeline);
  session.repeatedReads = repeats.repeatedReads;
  session.repeatedSearches = repeats.repeatedSearches;
  session.repeatedFailures = repeats.repeatedFailures;
  session.redactedFields = total;
  return session;
}

// src/analyzers/runtime/gitLink.ts
import { execFileSync as execFileSync3 } from "child_process";
function run(cmd, args, cwd, timeout = 3e3) {
  try {
    const out = execFileSync3(cmd, args, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
var gitCache = /* @__PURE__ */ new Map();
function getSessionGitContext(repoRoot) {
  const cached = gitCache.get(repoRoot);
  if (cached) return cached;
  const ctx = {};
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, 2e3);
  if (branch) ctx.branch = branch;
  const commit = run("git", ["rev-parse", "HEAD"], repoRoot, 2e3);
  if (commit) ctx.commit = commit;
  const status = run("git", ["status", "--porcelain"], repoRoot, 2e3);
  if (status !== null) ctx.dirty = status.length > 0;
  const message = run("git", ["log", "-1", "--format=%s"], repoRoot, 2e3);
  if (message) ctx.message = message.slice(0, 200);
  gitCache.set(repoRoot, ctx);
  return ctx;
}
var ghAvailable = null;
var prCache = /* @__PURE__ */ new Map();
function hasGh() {
  if (ghAvailable !== null) return ghAvailable;
  try {
    execFileSync3("gh", ["--version"], { encoding: "utf-8", timeout: 2e3, stdio: ["pipe", "pipe", "ignore"] });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }
  return ghAvailable;
}
function getSessionPrContext(repoRoot, branch) {
  if (!hasGh()) return {};
  const cacheKey = `${repoRoot}\0${branch || ""}`;
  const cached = prCache.get(cacheKey);
  if (cached) return cached;
  try {
    const args = branch ? ["pr", "view", branch, "--json", "number,title,state"] : ["pr", "status", "--json", "currentBranch", "--jq", ".currentBranch | {number,title,state}"];
    const out = execFileSync3("gh", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 4e3,
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    if (!out) return {};
    const data = JSON.parse(out);
    const number = Number(data?.number);
    if (data && Number.isFinite(number) && number > 0) {
      const result = { number, title: String(data.title ?? "").slice(0, 200), state: String(data.state ?? "") };
      prCache.set(cacheKey, result);
      return result;
    }
    prCache.set(cacheKey, {});
    return {};
  } catch {
    prCache.set(cacheKey, {});
    return {};
  }
}

// src/analyzers/runtime/runtimeAnalyzer.ts
var ADAPTERS = [
  otelAdapter,
  codexAdapter,
  cursorAdapter,
  claudeAdapter,
  geminiAdapter,
  agentdoctorAdapter
];
function readHead2(filePath, n = 4096) {
  try {
    const fd = fs21.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(n);
      const read = fs21.readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, read).toString("utf-8");
    } finally {
      fs21.closeSync(fd);
    }
  } catch {
    return "";
  }
}
function pickAdapter(ref) {
  const head = readHead2(ref.sourcePath);
  for (const a of ADAPTERS) {
    try {
      if (a.canParseFile?.(ref.sourcePath, head)) return a;
    } catch {
    }
  }
  if (ref.agent === "codex") return codexAdapter;
  if (ref.agent === "claude") return claudeAdapter;
  if (ref.agent === "cursor") return cursorAdapter;
  if (ref.agent === "gemini") return geminiAdapter;
  if (ref.agent === "otel") return otelAdapter;
  if (ref.sourcePath.endsWith(".jsonl")) return claudeAdapter;
  return agentdoctorAdapter;
}
async function analyzeRuntimeSessions(repoRoot, explicitSessionPath, opts = {}) {
  const findings = [];
  const sessions = [];
  const allowSensitive = opts.allowSensitive ?? process.env.AGENTDOCTOR_ALLOW_SENSITIVE === "1";
  const includeGlobal = shouldIncludeGlobal(opts.includeGlobal);
  const maxGlobal = opts.maxGlobalSessions ?? 20;
  const refs = [];
  if (explicitSessionPath && fs21.existsSync(explicitSessionPath)) {
    const st = fs21.statSync(explicitSessionPath);
    refs.push({ agent: "agentdoctor", sourcePath: explicitSessionPath, mtime: st.mtimeMs });
  } else {
    refs.push(...await detectRepoSessions(repoRoot));
    if (includeGlobal) {
      refs.push(...await detectGlobalSessions(repoRoot, maxGlobal));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const uniqueRefs = refs.filter((r) => {
    const key = path21.resolve(r.sourcePath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const gitCtx = getSessionGitContext(repoRoot);
  const prCtx = getSessionPrContext(repoRoot, gitCtx.branch);
  for (const ref of uniqueRefs) {
    try {
      const adapter = pickAdapter(ref);
      const parsed = adapter.parseMany ? await adapter.parseMany(ref) : [await adapter.parse(ref)];
      for (const s of parsed) {
        if (!s) continue;
        const sessionPrCtx = s.gitBranch && s.gitBranch !== gitCtx.branch ? getSessionPrContext(repoRoot, s.gitBranch) : prCtx;
        if (!s.gitBranch && gitCtx.branch) s.gitBranch = gitCtx.branch;
        if (!s.gitCommit && gitCtx.commit) s.gitCommit = gitCtx.commit;
        if (s.gitDirty === void 0 && gitCtx.dirty !== void 0) s.gitDirty = gitCtx.dirty;
        if (!s.gitMessage && gitCtx.message) s.gitMessage = gitCtx.message;
        if (s.prNumber === void 0 && sessionPrCtx.number !== void 0) {
          s.prNumber = sessionPrCtx.number;
          s.prTitle = sessionPrCtx.title;
          s.prState = sessionPrCtx.state;
        }
        if (!s.sourcePath) s.sourcePath = ref.sourcePath;
        if (!allowSensitive) redactSession(s);
        sessions.push(s);
      }
    } catch {
    }
  }
  for (const session of sessions) {
    const p = path21.relative(repoRoot, session.sourcePath || session.id) || session.id;
    for (const rr of session.repeatedReads) {
      findings.push({
        id: `runtime-repeated-read-${session.id}-${rr.file.replace(/[^a-zA-Z0-9]/g, "-")}`,
        ruleId: "runtime/repeated-file-retrieval",
        category: "runtime",
        severity: "medium",
        confidence: session.tokensUnknown ? 0.75 : 0.9,
        title: `Repeated file retrieval: ${rr.file} (${rr.count} times)`,
        description: `${rr.file} was read ${rr.count} times in session ${session.id}. AI agents repeatedly retrieve files when instruction context lacks clear summaries or architectural relationships.`,
        evidence: [
          {
            file: rr.file,
            snippet: `Retrieved ${rr.count} times in session ${session.id}`,
            source: p
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
        id: `runtime-repeated-search-${session.id}-${rs.query.replace(/[^a-zA-Z0-9]/g, "-")}`,
        ruleId: "runtime/repeated-searches",
        category: "runtime",
        severity: "medium",
        confidence: 0.85,
        title: `Repeated search operations for "${rs.query}" (${rs.count} times)`,
        description: `Agent executed ${rs.count} repetitive search queries for "${rs.query}". Indicates poor directory discoverability or lack of documentation of key service locations.`,
        evidence: [
          {
            file: p,
            snippet: `Query "${rs.query}" repeated ${rs.count} times`,
            source: "session trace"
          }
        ],
        recommendation: `Document the entry point or implementation directory for "${rs.query}" in AGENTS.md.`
      });
    }
    for (const rf of session.repeatedFailures) {
      findings.push({
        id: `runtime-repeated-failure-${session.id}-${rf.command.replace(/[^a-zA-Z0-9]/g, "-")}`,
        ruleId: "runtime/repeated-command-failures",
        category: "runtime",
        severity: "high",
        confidence: 0.95,
        title: `Repeated failed command: "${rf.command}" (${rf.count} times)`,
        description: `Same command failed ${rf.count} times in session without successful configuration adjustments. Agent wasted turns in trial-and-error loop.`,
        evidence: [
          {
            file: p,
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
            file: p,
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
    const retries = session.retriesCount || 0;
    const restores = session.restoresCount || 0;
    if (retries >= 3 || restores >= 2) {
      findings.push({
        id: `runtime-retry-loop-${session.id}`,
        ruleId: "runtime/retry-loop",
        category: "runtime",
        severity: "medium",
        confidence: 0.8,
        title: `Retry/restore loop detected (${retries} retries, ${restores} restores)`,
        description: `Session ${session.id} shows ${retries} retries and ${restores} checkpoint restores. The agent is looping instead of converging \u2014 usually missing error context or flaky verification commands.`,
        evidence: [
          {
            file: p,
            snippet: `${retries} retries, ${restores} restores in session ${session.id}`,
            source: "session trace"
          }
        ],
        recommendation: "Capture the first failure reason into AGENTS.md troubleshooting notes so the next attempt doesn't repeat it."
      });
    }
    const approvals = session.approvalsCount || 0;
    if (approvals >= 3 && session.filesEdited.length === 0) {
      findings.push({
        id: `runtime-approval-blocked-${session.id}`,
        ruleId: "runtime/approval-blocked",
        category: "runtime",
        severity: "low",
        confidence: 0.75,
        title: `Approval friction without progress (${approvals} approvals, 0 edits)`,
        description: `Session ${session.id} required ${approvals} approvals but produced no file edits. Approval gates may be blocking the agent, or the task is underspecified.`,
        evidence: [
          {
            file: p,
            snippet: `${approvals} approvals, 0 files edited`,
            source: "session trace"
          }
        ],
        recommendation: "Prefer scoped auto-approve for read-only tools (read/search) and keep approvals for write/exec."
      });
    }
  }
  sessions.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id));
  return { findings, sessions };
}

// src/analyzers/security/files.ts
import * as fs22 from "fs";
import * as path22 from "path";
import fg5 from "fast-glob";
var UNTRUSTED_DOC_GLOBS = [
  "README.md",
  "README.rst",
  "CONTRIBUTING.md",
  ".github/ISSUE_TEMPLATE/**/*.{md,yml,yaml}",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/**/ISSUE_TEMPLATE.md"
];
var MAX_BYTES = 512 * 1024;
function readFile(repoRoot, relativePath, kind) {
  const absolutePath = path22.join(repoRoot, relativePath);
  try {
    const stat = fs22.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buf = fs22.readFileSync(absolutePath);
    if (buf.includes(0)) return null;
    return {
      relativePath: relativePath.replace(/\\/g, "/"),
      absolutePath,
      content: buf.toString("utf-8"),
      kind
    };
  } catch {
    return null;
  }
}
async function collect(repoRoot, globs, kind) {
  const relativePaths = await fg5(globs, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: AGENT_FILE_IGNORE
  });
  const files = [];
  for (const rel of relativePaths.sort((a, b) => a.localeCompare(b))) {
    const file = readFile(repoRoot, rel, kind);
    if (file) files.push(file);
  }
  return files;
}
async function findSecurityScanFiles(repoRoot) {
  const [instructions, configs, docs] = await Promise.all([
    collect(repoRoot, AGENT_INSTRUCTION_GLOBS, "instruction"),
    collect(repoRoot, AGENT_CONFIG_GLOBS, "agent-config"),
    collect(repoRoot, UNTRUSTED_DOC_GLOBS, "untrusted-doc")
  ]);
  const seen = /* @__PURE__ */ new Set();
  const files = [];
  for (const file of [...instructions, ...configs, ...docs]) {
    if (seen.has(file.relativePath)) continue;
    seen.add(file.relativePath);
    files.push(file);
  }
  return files;
}
var GENERATED_DIR_NAMES = [
  "generated",
  "dist",
  "build",
  "openapi-generated",
  ".next",
  "out",
  "target"
];
async function findGeneratedDirectories(repoRoot) {
  return (await fg5(GENERATED_DIR_NAMES, {
    cwd: repoRoot,
    dot: true,
    onlyDirectories: true,
    unique: true,
    ignore: ["**/.git/**", "**/node_modules/**", "**/.venv/**", "**/venv/**"]
  })).sort((a, b) => a.localeCompare(b));
}

// src/analyzers/security/detectors.ts
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";

// src/analyzers/security/helpers.ts
function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
function lineAt(content, index) {
  const line = lineNumberAt(content, index);
  const lines = content.split(/\r?\n/);
  const text = lines[line - 1] ?? "";
  const start = content.slice(0, index).split(/\r?\n/).slice(0, -1).join("\n").length;
  return { line, text, start: start === 0 ? 0 : start + 1 };
}
function snippetFor(text, max = 160) {
  const redacted = redactText(text).text.replace(/\s+/g, " ").trim();
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max - 1)}\u2026`;
}
var NEGATION = /\b(?:never|do not|don't|dont|avoid|must not|shall not|禁止|不要|切勿|严禁|不得)\b/i;
function isNegatedLine(line) {
  return NEGATION.test(line);
}
function isPlaceholderSecret(value) {
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
function createFinding(options) {
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
        source: options.file.relativePath
      }
    ],
    recommendation: options.recommendation,
    groupKey: options.ruleId
  };
}
function parseJsonRecord(content) {
  try {
    const value = JSON.parse(content);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return null;
  } catch {
    return parseJsoncRecord(content);
  }
}
function parseJsoncRecord(content) {
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  try {
    const value = JSON.parse(stripped);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// src/analyzers/security/detectors.ts
var INJECTION_PATTERNS = [
  { regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|preceding)\s+(?:instructions?|prompts?|rules?|guidelines?)\b/i, label: "ignore-previous-instructions", strong: true },
  { regex: /\bdisregard\s+(?:the\s+)?(?:above|previous|prior)\s+(?:instructions?|prompts?|rules?)?\b/i, label: "disregard-previous", strong: true },
  { regex: /\bforget\s+(?:your|all|the)\s+(?:previous\s+)?(?:instructions?|rules?|guidelines?|system prompt)\b/i, label: "forget-instructions", strong: true },
  { regex: /\byou are now\s+(?:in\s+)?(?:DAN|developer mode|unrestricted|jailbreak)\b/i, label: "role-override", strong: true },
  { regex: /\b(?:enable|enter|activate)\s+(?:DAN mode|jailbreak)\b/i, label: "jailbreak", strong: true },
  { regex: /\boverride\s+(?:the\s+)?(?:system|developer|parent)\s+(?:prompt|instructions?|rules?)\b/i, label: "system-override", strong: true },
  { regex: /\b(?:new|these)\s+instructions?\s+(?:take|have)\s+priority\s+over\b/i, label: "priority-override", strong: true },
  { regex: /\bdo not follow\s+(?:the\s+)?(?:AGENTS\.md|CLAUDE\.md|system|developer)\b/i, label: "disable-system-file", strong: true },
  { regex: /<!--[\s\S]{0,240}?(?:ignore (?:all |previous )?instructions?|system prompt|you are now)[\s\S]{0,240}?-->/i, label: "html-comment-injection", strong: true },
  { regex: /<(?:system|important|secret_instruction)(?:\s[^>]*)?>[\s\S]{0,400}<\/(?:system|important|secret_instruction)>/i, label: "fake-system-tag", strong: true }
];
var UNICODE_POINTS = [
  { code: 173, name: "SOFT HYPHEN", severity: "medium" },
  { code: 847, name: "COMBINING GRAPHEME JOINER", severity: "high" },
  { code: 1564, name: "ARABIC LETTER MARK", severity: "high" },
  { code: 6158, name: "MONGOLIAN VOWEL SEPARATOR", severity: "high" },
  { code: 8203, name: "ZERO WIDTH SPACE", severity: "high" },
  { code: 8204, name: "ZERO WIDTH NON-JOINER", severity: "high" },
  { code: 8205, name: "ZERO WIDTH JOINER", severity: "high" },
  { code: 8206, name: "LEFT-TO-RIGHT MARK", severity: "high" },
  { code: 8207, name: "RIGHT-TO-LEFT MARK", severity: "high" },
  { code: 8234, name: "LEFT-TO-RIGHT EMBEDDING", severity: "high" },
  { code: 8235, name: "RIGHT-TO-LEFT EMBEDDING", severity: "high" },
  { code: 8236, name: "POP DIRECTIONAL FORMATTING", severity: "high" },
  { code: 8237, name: "LEFT-TO-RIGHT OVERRIDE", severity: "high" },
  { code: 8238, name: "RIGHT-TO-LEFT OVERRIDE", severity: "high" },
  { code: 8288, name: "WORD JOINER", severity: "high" },
  { code: 8289, name: "FUNCTION APPLICATION", severity: "medium" },
  { code: 8290, name: "INVISIBLE TIMES", severity: "medium" },
  { code: 8291, name: "INVISIBLE SEPARATOR", severity: "medium" },
  { code: 8292, name: "INVISIBLE PLUS", severity: "medium" },
  { code: 8294, name: "LEFT-TO-RIGHT ISOLATE", severity: "high" },
  { code: 8295, name: "RIGHT-TO-LEFT ISOLATE", severity: "high" },
  { code: 8296, name: "FIRST STRONG ISOLATE", severity: "high" },
  { code: 8297, name: "POP DIRECTIONAL ISOLATE", severity: "high" },
  { code: 65279, name: "ZERO WIDTH NO-BREAK SPACE", severity: "high" },
  { code: 65440, name: "HALFWIDTH HANGUL FILLER", severity: "medium" }
];
var UNICODE_LOOKUP = new Map(UNICODE_POINTS.map((item) => [item.code, item]));
var DANGEROUS_SHELL = [
  { regex: /\brm\s+-rf\s+(?:\/|~|\$HOME|\.\.)(?:\s|$|[;&|])/, label: "recursive-delete-root", severity: "critical" },
  { regex: /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, label: "fork-bomb", severity: "critical" },
  { regex: /\b(?:curl|wget)\b[^\n]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/i, label: "pipe-remote-shell", severity: "critical" },
  { regex: /\bbase64\s+-d\b[^\n]{0,80}\|\s*(?:ba)?sh\b/i, label: "decode-pipe-shell", severity: "critical" },
  { regex: /\beval\s*\(\s*(?:curl|wget)\b/i, label: "eval-remote", severity: "critical" },
  { regex: /\bbash\s+-i\s+>&\s*\/dev\/tcp\//i, label: "reverse-shell", severity: "critical" },
  { regex: /\b(?:nc|ncat|netcat)\b[^\n]{0,80}\s-e\s/i, label: "nc-exec", severity: "critical" },
  { regex: /\bchmod\s+(?:-R\s+)?777\b/, label: "chmod-777", severity: "high" },
  { regex: /\bdd\s+if=/, label: "dd-overwrite", severity: "high" },
  { regex: /\bmkfs(?:\.\w+)?\s+/, label: "mkfs", severity: "critical" },
  { regex: /\b(?:shutdown|reboot|halt)\b(?:\s|$)/, label: "power-control", severity: "high" }
];
var UNTRUSTED_FOLLOW = [
  { regex: /\b(?:follow|obey|execute|treat)\s+(?:the\s+)?(?:readme|github issues?|issues?|pull requests?|prs?|tool outputs?|tool results?)\s+(?:as|like)\s+(?:your\s+)?(?:system\s+)?(?:instructions?|commands?|source of truth)\b/i, label: "follow-untrusted-as-instructions" },
  { regex: /\b(?:readme|github issues?|tool outputs?)\s+is\s+(?:your|the)\s+(?:only|source of)\s+(?:instruction|truth)\b/i, label: "untrusted-source-of-truth" },
  { regex: /\bexecute\s+(?:any|all|every)\s+commands?\s+(?:in|from|inside)\s+(?:the\s+)?(?:readme|issue|pr|tool output)\b/i, label: "execute-commands-from-untrusted" }
];
var GENERATED_EDIT = /\b(?:edit|modify|update|rewrite|patch|commit|check in)\s+(?:the\s+)?(?:files?\s+in\s+|code\s+in\s+)?(?:generated|dist|build|openapi-generated|\.next|out|target)\b/i;
var NETWORK_INSTRUCTION = /\b(?:always|must|should)\s+(?:use|call|run|enable)\s+(?:web_?search|web_?fetch|webfetch|websearch)\b/i;
var EXFIL = /\b(?:post|upload|send|exfiltrate)\s+(?:this|the|your)?\s*(?:diff|source|code|secret|token|key|prompt)\s+to\s+https?:\/\//i;
var BROAD_PERMISSION = /^(?:\*|bash\(\*\)|shell\(\*\)|webfetch\(\*\)|websearch\(\*\)|web_fetch\(\*\)|web_search\(\*\))$/i;
var LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i;
function visibleSnippet(line) {
  return [...line].map((char) => {
    const info = UNICODE_LOOKUP.get(char.codePointAt(0) || 0);
    if (!info) return char;
    return `<U+${info.code.toString(16).toUpperCase().padStart(4, "0")}>`;
  }).join("");
}
function isTagCharacter(code) {
  return code === 917505 || code >= 917536 && code <= 917631;
}
function detectPromptInjection(files) {
  const findings = [];
  for (const file of files) {
    if (file.kind === "untrusted-doc") continue;
    for (const pattern of INJECTION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const flags = pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`;
      const global = new RegExp(pattern.regex.source, flags);
      let match;
      while (match = global.exec(file.content)) {
        const loc = lineAt(file.content, match.index);
        if (isNegatedLine(loc.text)) continue;
        findings.push(createFinding({
          file,
          ruleId: "security/prompt-injection",
          severity: "high",
          confidence: pattern.label.startsWith("html") || pattern.label.startsWith("fake") ? 0.88 : 0.92,
          title: `Prompt injection pattern in ${file.relativePath}`,
          description: `Instruction text matches a prompt-injection / jailbreak pattern (${pattern.label}). Coding agents that load this file may treat the injected directive as a higher-priority system instruction.`,
          recommendation: "Remove override/jailbreak language. Keep repository instructions additive and never tell the agent to ignore system or parent instructions.",
          line: loc.line,
          snippet: loc.text,
          idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`
        }));
      }
    }
  }
  return findings;
}
function detectHiddenUnicode(files) {
  const findings = [];
  for (const file of files) {
    const hits = [];
    for (let i = 0; i < file.content.length; i++) {
      const code = file.content.codePointAt(i);
      if (code === void 0) continue;
      if (code > 65535) i++;
      if (code === 65279 && i === 0) continue;
      const info = UNICODE_LOOKUP.get(code);
      if (info) {
        hits.push({ index: i, info });
        continue;
      }
      if (isTagCharacter(code)) {
        hits.push({ index: i, info: { code, name: "UNICODE TAG CHARACTER", severity: "high" } });
      }
    }
    if (hits.length === 0) continue;
    const first = hits[0];
    const loc = lineAt(file.content, first.index);
    const names = [...new Set(hits.slice(0, 6).map((hit) => `U+${hit.info.code.toString(16).toUpperCase().padStart(4, "0")} ${hit.info.name}`))];
    const high = hits.some((hit) => hit.info.severity === "high");
    findings.push(createFinding({
      file,
      ruleId: "security/hidden-unicode",
      severity: high ? "high" : "medium",
      confidence: 0.96,
      title: `Hidden Unicode in ${file.relativePath}`,
      description: `${hits.length} invisible or bidirectional Unicode character(s) found (${names.join(", ")}). These can hide instructions, reverse displayed text, or smuggle payloads past human review.`,
      recommendation: "Delete zero-width, tag, and bidi override characters from agent-readable files. Keep the visible text identical to the bytes the model receives.",
      line: loc.line,
      snippet: visibleSnippet(loc.text),
      idSuffix: `${file.relativePath}-unicode`
    }));
  }
  return findings;
}
function detectInstructionSecrets(files) {
  const findings = [];
  const prefixed = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|gho_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{10,}|xox[bpas]-[A-Za-z0-9-]{6,})\b/;
  const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
  const assignment = /(?:^|[\s,{])((?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*["']?)([^"'\s,;}]{8,})/gi;
  for (const file of files) {
    const liveAssignments = [];
    assignment.lastIndex = 0;
    let match;
    while (match = assignment.exec(file.content)) {
      if (!isPlaceholderSecret(match[2])) liveAssignments.push(match[2]);
    }
    const hasPrefixed = prefixed.test(file.content) || privateKey.test(file.content);
    if (!hasPrefixed && liveAssignments.length === 0) continue;
    const prefixAt = file.content.search(prefixed);
    const assignAt = (() => {
      assignment.lastIndex = 0;
      const found = assignment.exec(file.content);
      return found ? found.index : -1;
    })();
    const loc = lineAt(file.content, Math.max(0, prefixAt >= 0 ? prefixAt : assignAt));
    findings.push(createFinding({
      file,
      ruleId: "security/instruction-secrets",
      severity: "critical",
      confidence: 0.93,
      title: `Secret material in ${file.relativePath}`,
      description: "An agent instruction or MCP/hook config file contains a live-looking credential. Models and session logs will copy it into prompts, traces, and patches.",
      recommendation: "Remove the literal secret. Reference an environment variable name only, and rotate the exposed credential.",
      line: loc.line,
      snippet: loc.text,
      idSuffix: `${file.relativePath}-secret`
    }));
  }
  return findings;
}
function detectDangerousShell(files) {
  const findings = [];
  for (const file of files) {
    for (const pattern of DANGEROUS_SHELL) {
      const global = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
      let match;
      while (match = global.exec(file.content)) {
        const loc = lineAt(file.content, match.index);
        if (isNegatedLine(loc.text)) continue;
        findings.push(createFinding({
          file,
          ruleId: "security/dangerous-shell",
          severity: pattern.severity,
          confidence: file.kind === "agent-config" ? 0.94 : 0.9,
          title: `Dangerous shell command (${pattern.label})`,
          description: `A ${file.kind === "agent-config" ? "hook/MCP command" : "instruction"} contains a destructive or remote-execution shell pattern (${pattern.label}). Agents and hook runners may execute it with repository privileges.`,
          recommendation: "Delete the command. If documentation must mention it, keep a clear never/do-not prefix and do not place it in hooks, MCP stdio commands, or copy-pasteable fenced blocks without negation.",
          line: loc.line,
          snippet: loc.text,
          idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`
        }));
      }
    }
  }
  return findings;
}
function parseConfig(file) {
  if (file.relativePath.endsWith(".toml")) {
    try {
      const value = parseToml(file.content);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  if (file.relativePath.endsWith(".yml") || file.relativePath.endsWith(".yaml")) {
    try {
      const value = YAML.parse(file.content);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  return parseJsonRecord(file.content);
}
function looksLikeMcpServerMap(value) {
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, config]) => {
    if (!isRecord(config)) return false;
    return typeof config.command === "string" || Array.isArray(config.command) || typeof config.url === "string" || typeof config.type === "string" || Array.isArray(config.args);
  });
}
function collectMcpServers(data) {
  const roots = [data.mcpServers, data.mcp_servers];
  if (isRecord(data.mcp)) {
    roots.push(data.mcp.servers, data.mcp.mcpServers);
    if (!isRecord(data.mcp.servers) && !isRecord(data.mcp.mcpServers) && looksLikeMcpServerMap(data.mcp)) {
      roots.push(data.mcp);
    }
  }
  const servers = [];
  for (const root of roots) {
    if (!isRecord(root)) continue;
    for (const [name, config] of Object.entries(root)) {
      if (isRecord(config)) servers.push({ name, config });
    }
  }
  return servers;
}
function walkHookCommands(data, visit) {
  if (!isRecord(data)) return;
  const hooksRoot = isRecord(data.hooks) ? data.hooks : data;
  for (const [event, groups] of Object.entries(hooksRoot)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : "*";
      const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const handler of handlers) {
        if (!isRecord(handler)) continue;
        if (typeof handler.command === "string" && handler.command.trim()) {
          visit(handler.command, event, matcher);
        }
      }
    }
  }
}
function permissionList(data) {
  const permissions = isRecord(data.permissions) ? data.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const defaultMode = typeof permissions.defaultMode === "string" ? [permissions.defaultMode] : [];
  const autoApprove = Array.isArray(data.autoApprove) ? data.autoApprove : [];
  const alwaysAllow = Array.isArray(data.alwaysAllow) ? data.alwaysAllow : [];
  return [...allow, ...defaultMode, ...autoApprove, ...alwaysAllow].filter((item) => typeof item === "string");
}
function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
function detectMcpAndHookPermissions(files) {
  const findings = [];
  for (const file of files) {
    if (file.kind !== "agent-config") continue;
    const data = parseConfig(file);
    if (!data) continue;
    const permissions = permissionList(data);
    const broad = permissions.filter((item) => BROAD_PERMISSION.test(item.trim()) || item.trim() === "bypassPermissions");
    if (broad.length > 0) {
      findings.push(createFinding({
        file,
        ruleId: "security/mcp-hook-permissions",
        severity: "high",
        confidence: 0.92,
        title: `Unrestricted agent tool permission in ${file.relativePath}`,
        description: `Permissions allow unrestricted execution (${broad.join(", ")}). Combined with a prompt-injection in any loaded file, the agent can run arbitrary shell or network tools without an approval gate.`,
        recommendation: "Replace wildcard allow-lists with explicit tools and commands. Keep Bash/WebFetch denied or require approval.",
        snippet: broad.join(", "),
        idSuffix: `${file.relativePath}-perm`
      }));
    }
    const approval = String(data.approval_policy || data.approvalPolicy || "");
    const sandbox = String(data.sandbox_mode || data.sandbox || data.sandboxMode || "");
    if (/^(?:never|untrusted|danger-full-access)$/i.test(approval) || /danger-full-access/i.test(sandbox)) {
      findings.push(createFinding({
        file,
        ruleId: "security/mcp-hook-permissions",
        severity: "high",
        confidence: 0.9,
        title: `Agent sandbox/approval disabled in ${file.relativePath}`,
        description: `approval_policy=${approval || "unset"} sandbox=${sandbox || "unset"} removes the human approval or filesystem sandbox that normally contains a compromised agent.`,
        recommendation: "Use an approval policy that prompts on unknown commands and a sandbox that cannot write outside the workspace.",
        snippet: `approval_policy=${approval} sandbox=${sandbox}`,
        idSuffix: `${file.relativePath}-sandbox`
      }));
    }
    for (const server of collectMcpServers(data)) {
      const alwaysAllow = server.config.alwaysAllow === true || server.config.autoApprove === true;
      const autoList = Array.isArray(server.config.autoApprove) ? server.config.autoApprove : [];
      const star = autoList.some((item) => item === "*" || item === "all");
      if (alwaysAllow || star) {
        findings.push(createFinding({
          file,
          ruleId: "security/mcp-hook-permissions",
          severity: "high",
          confidence: 0.91,
          title: `MCP server "${server.name}" auto-approves tools`,
          description: "This MCP server skips tool approval. A poisoned server or injected tool call can run without a human in the loop.",
          recommendation: `Remove alwaysAllow/autoApprove from MCP server "${server.name}" and approve tools per session.`,
          snippet: `mcpServers.${server.name}`,
          idSuffix: `${file.relativePath}-mcp-${server.name}`
        }));
      }
    }
    walkHookCommands(data, (command, event, matcher) => {
      if (matcher !== "*" && matcher !== "") return;
      findings.push(createFinding({
        file,
        ruleId: "security/mcp-hook-permissions",
        severity: "medium",
        confidence: 0.84,
        title: `Unscoped ${event} hook command`,
        description: `Hook event "${event}" runs \`${command}\` for matcher "${matcher || "*"}". Broad matchers fire on every tool call, which is a privilege-escalation path if the command is network-capable or mutates the tree.`,
        recommendation: "Scope the hook matcher to the specific tool (for example Bash or Write) and keep the command read-only unless it is a local formatter.",
        snippet: `${event} ${matcher}: ${command}`,
        idSuffix: `${file.relativePath}-hook-${event}`
      }));
    });
  }
  return findings;
}
function detectExternalNetwork(files) {
  const findings = [];
  for (const file of files) {
    if (file.kind === "instruction") {
      const patterns = [NETWORK_INSTRUCTION, EXFIL];
      for (const regex of patterns) {
        const global = new RegExp(regex.source, "gi");
        let match;
        while (match = global.exec(file.content)) {
          const loc = lineAt(file.content, match.index);
          if (isNegatedLine(loc.text)) continue;
          findings.push(createFinding({
            file,
            ruleId: "security/external-network",
            severity: EXFIL.test(match[0]) ? "critical" : "medium",
            confidence: 0.88,
            title: "Instruction grants or directs external network access",
            description: "Agent instructions tell the model to call web tools or send repository data to a remote URL. That is an exfiltration and supply-chain channel.",
            recommendation: "Do not instruct agents to fetch or post to the public internet by default. If a specific host is required, name it and keep WebFetch/WebSearch behind approval.",
            line: loc.line,
            snippet: loc.text,
            idSuffix: `${file.relativePath}-${loc.line}-net`
          }));
        }
      }
    }
    if (file.kind !== "agent-config") continue;
    const data = parseConfig(file);
    if (!data) continue;
    for (const server of collectMcpServers(data)) {
      const url = typeof server.config.url === "string" ? server.config.url : "";
      if (!/^https?:\/\//i.test(url)) continue;
      const host = hostFromUrl(url);
      if (LOCAL_HOST.test(host)) continue;
      findings.push(createFinding({
        file,
        ruleId: "security/external-network",
        severity: "medium",
        confidence: 0.9,
        title: `Remote MCP server "${server.name}"`,
        description: `MCP server "${server.name}" connects to ${host || url}. Tool names, file contents, and secrets in env can leave the machine.`,
        recommendation: "Prefer local stdio MCP servers. If a remote server is required, pin a trusted host, strip secrets from env, and keep tool auto-approve off.",
        snippet: url,
        idSuffix: `${file.relativePath}-mcp-url-${server.name}`
      }));
    }
    walkHookCommands(data, (command, event) => {
      if (!/\b(?:curl|wget|nc|ncat|fetch)\b/i.test(command) && !/https?:\/\//i.test(command)) return;
      const loc = lineAt(file.content, file.content.indexOf(command));
      findings.push(createFinding({
        file,
        ruleId: "security/external-network",
        severity: "high",
        confidence: 0.9,
        title: `Hook ${event} performs outbound network I/O`,
        description: "A hook command reaches the network. Prompt injection in any later tool output can turn this into data theft.",
        recommendation: "Remove network calls from hooks. If a webhook is required, pin the destination and pass no file contents or secrets.",
        line: loc.line > 0 ? loc.line : void 0,
        snippet: command,
        idSuffix: `${file.relativePath}-hook-net-${event}`
      }));
    });
  }
  return findings;
}
function detectGeneratedEdits(files, generatedDirs) {
  const findings = [];
  for (const file of files) {
    if (file.kind !== "instruction" && file.kind !== "agent-config") continue;
    const global = new RegExp(GENERATED_EDIT.source, "gi");
    let match;
    while (match = global.exec(file.content)) {
      const loc = lineAt(file.content, match.index);
      if (isNegatedLine(loc.text)) continue;
      findings.push(createFinding({
        file,
        ruleId: "security/generated-file-edit",
        severity: "high",
        confidence: 0.9,
        title: "Instructions tell the agent to edit generated output",
        description: "The agent is directed to modify build/generated artifacts. Those edits are overwritten on the next build and often bypass source review.",
        recommendation: "Tell agents never to edit generated directories. Point them at the generator input instead.",
        line: loc.line,
        snippet: loc.text,
        idSuffix: `${file.relativePath}-${loc.line}-generated`
      }));
    }
  }
  for (const file of files) {
    if (file.kind !== "agent-config" || generatedDirs.length === 0) continue;
    const data = parseConfig(file);
    if (!data) continue;
    walkHookCommands(data, (command, event) => {
      const touches = generatedDirs.some((dir) => command.includes(`${dir}/`) || command.includes(`${dir} `));
      if (!touches) return;
      findings.push(createFinding({
        file,
        ruleId: "security/generated-file-edit",
        severity: "medium",
        confidence: 0.86,
        title: `Hook ${event} writes generated directories`,
        description: `Hook command \`${command}\` targets generated output (${generatedDirs.join(", ")}).`,
        recommendation: "Keep hooks away from dist/generated/. Run the generator from source instead.",
        snippet: command,
        idSuffix: `${file.relativePath}-hook-generated-${event}`
      }));
    });
  }
  return findings;
}
function detectUntrustedInput(files) {
  const findings = [];
  for (const file of files) {
    if (file.kind === "instruction") {
      for (const pattern of UNTRUSTED_FOLLOW) {
        const global = new RegExp(pattern.regex.source, "gi");
        let match;
        while (match = global.exec(file.content)) {
          const loc = lineAt(file.content, match.index);
          if (isNegatedLine(loc.text)) continue;
          findings.push(createFinding({
            file,
            ruleId: "security/untrusted-content-injection",
            severity: "high",
            confidence: 0.91,
            title: "Untrusted README/issue/tool output treated as instructions",
            description: "The agent is told to follow README, GitHub issues, or tool output as commands. Those sources are attacker-controlled in many workflows (copied issues, malicious READMEs, poisoned tool results).",
            recommendation: "State explicitly that README, issues, PRs, and tool output are untrusted data. The agent must not execute commands found there unless they already exist in repository instructions.",
            line: loc.line,
            snippet: loc.text,
            idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`
          }));
        }
      }
    }
    if (file.kind !== "untrusted-doc") continue;
    for (const pattern of INJECTION_PATTERNS) {
      const global = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
      let match;
      while (match = global.exec(file.content)) {
        const loc = lineAt(file.content, match.index);
        if (isNegatedLine(loc.text)) continue;
        if (/security\/[a-z0-9-]+/.test(loc.text) || /ignore-previous-instructions/.test(loc.text)) continue;
        findings.push(createFinding({
          file,
          ruleId: "security/untrusted-content-injection",
          severity: "high",
          confidence: 0.9,
          title: `Injection payload in untrusted ${file.relativePath}`,
          description: `README/issue/PR text contains a prompt-injection pattern (${pattern.label}). Agents that dump this file into the prompt can be steered by repository visitors or copied issue bodies.`,
          recommendation: "Delete hidden or jailbreak language from README and issue templates. Add an instruction that those documents are data, not system commands.",
          line: loc.line,
          snippet: loc.text,
          idSuffix: `${file.relativePath}-${loc.line}-${pattern.label}`
        }));
      }
    }
  }
  return findings;
}

// src/analyzers/security/securityAnalyzer.ts
async function analyzeSecurity(repoRoot) {
  const files = await findSecurityScanFiles(repoRoot);
  const generatedDirs = await findGeneratedDirectories(repoRoot);
  const findings = [
    ...detectPromptInjection(files),
    ...detectHiddenUnicode(files),
    ...detectInstructionSecrets(files),
    ...detectDangerousShell(files),
    ...detectExternalNetwork(files),
    ...detectMcpAndHookPermissions(files),
    ...detectGeneratedEdits(files, generatedDirs),
    ...detectUntrustedInput(files)
  ].sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
  return {
    findings,
    scannedFiles: files.map((file) => file.relativePath)
  };
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
  const securityScoreVal = calculateCategoryScore("security", findings);
  const runtimeScoreVal = hasRuntimeData ? calculateCategoryScore("runtime", findings) : void 0;
  let contextWeight = 0.3;
  let repoWeight = 0.15;
  let verifWeight = 0.15;
  let securityWeight = 0.15;
  const runtimeWeight = 0.25;
  let overallScore;
  let scoreExplanation;
  if (hasRuntimeData && runtimeScoreVal !== void 0) {
    overallScore = contextScoreVal * contextWeight + repoScoreVal * repoWeight + verifScoreVal * verifWeight + securityScoreVal * securityWeight + runtimeScoreVal * runtimeWeight;
    scoreExplanation = "Full assessment (5 of 5 dimensions evaluated)";
  } else {
    const totalStaticWeight = contextWeight + repoWeight + verifWeight + securityWeight;
    contextWeight /= totalStaticWeight;
    repoWeight /= totalStaticWeight;
    verifWeight /= totalStaticWeight;
    securityWeight /= totalStaticWeight;
    overallScore = contextScoreVal * contextWeight + repoScoreVal * repoWeight + verifScoreVal * verifWeight + securityScoreVal * securityWeight;
    scoreExplanation = "Based on 4 of 5 dimensions (Runtime session data unavailable)";
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
    security: {
      score: securityScoreVal,
      weight: Number(securityWeight.toFixed(3)),
      findingsCount: countFindingsBySeverity(findings, "security")
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
  if (lowerRule.startsWith("security/")) {
    return {
      constraints: [
        "\u53EA\u4FEE\u6539\u6307\u4EE4\u6587\u4EF6\u3001MCP \u914D\u7F6E\u6216 hook \u914D\u7F6E\u4E2D\u5F15\u5165\u98CE\u9669\u7684\u5185\u5BB9",
        "\u4E0D\u8981\u628A\u771F\u5B9E\u5BC6\u94A5\u5199\u8FDB\u8BC1\u636E\u3001\u6CE8\u91CA\u6216\u65B0\u7684\u6307\u4EE4\u6587\u672C\uFF1B\u5982\u5DF2\u6CC4\u9732\uFF0C\u8BF4\u660E\u9700\u8981\u8F6E\u6362",
        "\u4FDD\u7559\u4ED3\u5E93\u91CC\u6B63\u5F53\u7684\u5B89\u5168\u7EA6\u675F\uFF08\u4F8B\u5982 never edit generated files\uFF09",
        "\u4E0D\u8981\u4E3A\u4E86\u6D88\u9664\u544A\u8B66\u800C\u5220\u9664\u6709\u7528\u7684\u67B6\u6784\u8BF4\u660E"
      ],
      verification: [
        "\u518D\u6B21\u8FD0\u884C agentdoctor audit\uFF0C\u786E\u8BA4\u5BF9\u5E94 ruleId \u5DF2\u6D88\u5931",
        "\u786E\u8BA4\u6307\u4EE4\u4ECD\u7136\u80FD\u6307\u5BFC agent \u5B8C\u6210\u6B63\u5F53\u5F00\u53D1\u4EFB\u52A1"
      ]
    };
  }
  if (lowerRule.includes("missing-agents-md")) {
    return {
      constraints: [
        "\u6839\u636E\u4ED3\u5E93\u771F\u5B9E\u5E03\u5C40\u3001\u5305\u7BA1\u7406\u5668\u548C\u9A8C\u8BC1\u547D\u4EE4\u751F\u6210 AGENTS.md",
        "\u53EA\u5199 Agent \u65E0\u6CD5\u4ECE lockfile / package.json \u63A8\u65AD\u7684\u4FE1\u606F",
        "\u4E0D\u8981\u590D\u5236\u5230 CLAUDE.md \u7B49 shim \u6587\u4EF6\u4E2D\uFF1Bshim \u53EA\u505A\u6307\u9488",
        "\u660E\u786E\u7981\u6B62\u7F16\u8F91 generated/dist/build \u7B49\u4EA7\u7269\u76EE\u5F55"
      ],
      verification: [
        "\u518D\u6B21\u8FD0\u884C agentdoctor scan\uFF0C\u786E\u8BA4 context/missing-agents-md \u5DF2\u6D88\u5931",
        "\u786E\u8BA4 Critical Commands \u4E0E package.json / CI \u4E00\u81F4"
      ]
    };
  }
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

// src/core/fix/bootstrap.ts
import * as fs24 from "fs";
import * as path24 from "path";

// src/core/fix/agentsMarkdown.ts
import * as fs23 from "fs";
import * as path23 from "path";
var GENERATED_DIR_NAMES2 = ["generated", "dist", "build", "openapi-generated", ".next", "out", "target"];
function detectGeneratedDirectories(repoRoot) {
  return GENERATED_DIR_NAMES2.filter((name) => fs23.existsSync(path23.join(repoRoot, name)));
}
function bulletList(values, empty = "none detected") {
  if (values.length === 0) return empty;
  return values.map((value) => `\`${value}\``).join(", ");
}
function formatCommand(item, fallback) {
  if (item?.command && (item.status === "healthy" || item.status === "warning")) {
    return item.command;
  }
  return fallback;
}
function displayCommand(raw, packageManager, scriptHint) {
  if (!raw) return void 0;
  if (/^(?:npm|pnpm|yarn|bun|cargo|go|pytest|ruff|mypy|pre-commit)\b/.test(raw)) return raw;
  if (scriptHint) {
    if (packageManager === "npm" && scriptHint === "test") return "npm test";
    return `${packageManager} run ${scriptHint}`;
  }
  return raw;
}
function generateAgentsMarkdown(options) {
  const { repoRoot, profile, verificationStatus } = options;
  const name = options.repositoryName || path23.basename(repoRoot);
  const manager = detectNodePackageManager(repoRoot);
  const byName = Object.fromEntries(verificationStatus.map((item) => [item.name, item]));
  const generatedDirs = detectGeneratedDirectories(repoRoot);
  const sourceRoots = profile.packageRoots.length > 0 ? profile.packageRoots : ["src"];
  const install = profile.ecosystems.includes("node") || profile.primaryEcosystem === "node" ? `${manager} install` : profile.primaryEcosystem === "python" ? "pip install -e ." : profile.primaryEcosystem === "rust" ? "cargo fetch" : profile.primaryEcosystem === "go" ? "go mod download" : void 0;
  const test = displayCommand(formatCommand(byName.test), manager, "test") ?? (profile.primaryEcosystem === "python" ? "pytest" : profile.primaryEcosystem === "rust" ? "cargo test" : profile.primaryEcosystem === "go" ? "go test ./..." : void 0);
  const lint = displayCommand(formatCommand(byName.lint), manager, "lint");
  const typecheck = displayCommand(formatCommand(byName.typecheck), manager, "typecheck");
  const build = displayCommand(formatCommand(byName.build), manager, "build") ?? (profile.primaryEcosystem === "rust" ? "cargo build" : profile.primaryEcosystem === "go" ? "go build ./..." : void 0);
  const commandLines = [
    install ? `- Install: \`${install}\`` : void 0,
    build ? `- Build: \`${build}\`` : void 0,
    test ? `- Test: \`${test}\`` : void 0,
    typecheck ? `- Typecheck: \`${typecheck}\`` : void 0,
    lint ? `- Lint: \`${lint}\`` : void 0,
    "- Verify (opt-in, executes commands): `npx agentdoctor verify`",
    "- Security audit: `npx agentdoctor audit`"
  ].filter((line) => Boolean(line));
  const overviewBits = [
    profile.summary || `${name} repository`,
    profile.isMonorepo ? "This is a monorepo." : void 0,
    `Primary ecosystem: ${profile.primaryEcosystem}.`,
    profile.languages.length > 0 ? `Languages: ${profile.languages.join(", ")}.` : void 0
  ].filter(Boolean);
  const layoutLines = [
    `- Package roots: ${bulletList(sourceRoots)}`,
    `- Entry points: ${bulletList(profile.entryPoints)}`,
    `- Test roots: ${bulletList(profile.testRoots)}`
  ];
  const generatedRule = generatedDirs.length > 0 ? `- Never manually edit generated files in ${generatedDirs.map((dir) => `\`${dir}/\``).join(", ")}.` : "- Never manually edit generated files in `dist/` or `build/`.";
  return `# AGENTS.md

## Repository Overview
${overviewBits.join(" ")}

## Layout
${layoutLines.join("\n")}

## Critical Commands
${commandLines.join("\n")}

## Architecture & Conventions
- Source code is encapsulated in ${sourceRoots.map((root) => `\`${root}/\``).join(", ")}.
${generatedRule}
- Follow strict typing and modular architecture.
- Keep agent-specific overrides in shim files; do not duplicate this command table.
`;
}

// src/core/fix/bootstrap.ts
function buildMissingAgentsFix(repoRoot, profile, verificationStatus) {
  const agentsPath = path24.join(repoRoot, "AGENTS.md");
  if (fs24.existsSync(agentsPath)) return null;
  const content = generateAgentsMarkdown({ repoRoot, profile, verificationStatus, repositoryName: path24.basename(repoRoot) });
  return createFix({
    id: "fix-generate-agents-md",
    title: "Generate AGENTS.md from repository structure",
    description: "Create a high-signal AGENTS.md using detected layout, commands, and generated directories.",
    isSafe: true,
    file: agentsPath,
    oldText: "",
    newText: content,
    changes: [{ path: agentsPath, kind: "create", newText: content, replaceFile: true }]
  });
}
function buildInstructionBootstrap(repoRoot, profile, verificationStatus) {
  const findings = [];
  const fixes = [];
  const agentsFix = buildMissingAgentsFix(repoRoot, profile, verificationStatus);
  if (agentsFix) {
    fixes.push(agentsFix);
    findings.push({
      id: "context-missing-agents-md",
      ruleId: "context/missing-agents-md",
      category: "context",
      severity: "high",
      confidence: 0.95,
      title: "Repository is missing AGENTS.md",
      description: "No AGENTS.md was found. Coding agents lack a single source of truth for layout, commands, and generated-file policy.",
      evidence: [{ file: "AGENTS.md", snippet: "File not found", source: "filesystem" }],
      recommendation: "Run `agentdoctor fix --safe` or `agentdoctor init` to generate AGENTS.md from the detected repository structure.",
      fix: agentsFix
    });
  }
  return { findings, fixes };
}

// src/core/scan/scanner.ts
async function scanRepository(options = {}) {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const repositoryName = path25.basename(repoRoot);
  const branch = getGitBranch(repoRoot);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const projectProfile = detectProjectProfile(repoRoot);
  const contextResult = await analyzeContext(repoRoot, {
    gitHistoryRoot: options.gitHistoryRoot,
    gitRef: options.gitRef
  });
  const repoResult = await analyzeRepository(repoRoot, projectProfile);
  const verifResult = await analyzeVerification(repoRoot, projectProfile);
  const runtimeResult = options.includeRuntime === false ? { findings: [], sessions: [] } : await analyzeRuntimeSessions(repoRoot, options.sessionPath, {
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
    maxGlobalSessions: options.maxGlobalSessions
  });
  const securityResult = await analyzeSecurity(repoRoot);
  const bootstrap = buildInstructionBootstrap(repoRoot, projectProfile, verifResult.verificationStatus);
  const allFindings = [
    ...contextResult.findings,
    ...repoResult.findings,
    ...verifResult.findings,
    ...runtimeResult.findings,
    ...securityResult.findings,
    ...bootstrap.findings
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
    ...verifResult.fixes,
    ...bootstrap.fixes
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
      scannedFilesCount: contextResult.scannedFiles.length + repoResult.metrics.totalFiles + securityResult.scannedFiles.length,
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
    includeRuntime: !baselineRef,
    includeGlobal: options.includeGlobal,
    allowSensitive: options.allowSensitive,
    maxGlobalSessions: options.maxGlobalSessions
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

// src/core/report/sarif.ts
function sarifLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}
function findingUri(repoRoot, finding) {
  const evidence = finding.evidence[0];
  const file = evidence?.file || ".";
  return {
    uri: toRepoRelative(repoRoot, file),
    startLine: evidence?.line,
    endLine: evidence?.endLine
  };
}
function scanResultToSarif(result, options = {}) {
  const findings = flattenFindings(result.findings);
  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))].sort((a, b) => a.localeCompare(b));
  const ruleIndex = new Map(ruleIds.map((id, index) => [id, index]));
  const rules = ruleIds.map((id) => {
    const sample = findings.find((finding) => finding.ruleId === id);
    return {
      id,
      name: id,
      shortDescription: { text: sample?.title || id },
      helpUri: "https://github.com/search?q=agentdoctor"
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "AgentDoctor",
            version: options.version,
            informationUri: "https://www.npmjs.com/package/@gaochenkai/agentdoctor",
            rules
          }
        },
        originalUriBaseIds: {
          SRCROOT: { uri: `${result.repositoryRoot.replace(/\\/g, "/")}/` }
        },
        results: findings.map((finding) => {
          const loc = findingUri(result.repositoryRoot, finding);
          return {
            ruleId: finding.ruleId,
            ruleIndex: ruleIndex.get(finding.ruleId),
            level: sarifLevel(finding.severity),
            message: { text: `${finding.title}: ${finding.description}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: loc.uri, uriBaseId: "SRCROOT" },
                  region: loc.startLine ? { startLine: loc.startLine, endLine: loc.endLine && loc.endLine >= loc.startLine ? loc.endLine : loc.startLine } : void 0
                }
              }
            ]
          };
        })
      }
    ]
  };
}

// src/core/report/githubAnnotations.ts
function annotationLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "notice";
}
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function formatGitHubAnnotation(finding, repoRoot) {
  const evidence = finding.evidence[0];
  const file = escapeProperty(toRepoRelative(repoRoot, evidence?.file || "."));
  const title = escapeProperty(finding.title);
  const level = annotationLevel(finding.severity);
  const parts = [`${level} file=${file}`, `title=${title}`];
  if (evidence?.line) {
    parts.push(`line=${evidence.line}`);
    if (evidence.endLine && evidence.endLine >= evidence.line) parts.push(`endLine=${evidence.endLine}`);
  }
  const message = escapeData(`${finding.ruleId}: ${finding.description}`);
  return `::${parts.join(",")}::${message}`;
}
function formatGitHubAnnotations(result, options = {}) {
  const limit = options.limit ?? 50;
  return flattenFindings(result.findings).slice(0, limit).map((finding) => formatGitHubAnnotation(finding, result.repositoryRoot));
}

// src/action/index.ts
function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  try {
    return JSON.parse(fs25.readFileSync(eventPath, "utf-8"));
  } catch {
    return {};
  }
}
function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  let delimiter = `agentdoctor_${name}_EOF`;
  while (value.includes(delimiter)) delimiter += "_";
  fs25.appendFileSync(outputPath, `${name}<<${delimiter}
${value}
${delimiter}
`, "utf-8");
}
function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs25.appendFileSync(summaryPath, `${markdown}
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
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const sarifInput = process.env.AGENTDOCTOR_SARIF?.trim();
  const sarifPath = path26.resolve(workspace, sarifInput || "agentdoctor.sarif");
  fs25.writeFileSync(sarifPath, `${JSON.stringify(scanResultToSarif(evaluation.result), null, 2)}
`, "utf-8");
  writeOutput("sarif-path", sarifPath);
  for (const line of formatGitHubAnnotations(evaluation.result)) {
    console.log(line);
  }
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
