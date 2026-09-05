import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectProfile, SupportedEcosystem } from "../types.js";

const IGNORED_DIRS = new Set([
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
  "vendor",
]);

const NODE_WORKSPACE_DIRS = new Set(["apps", "packages", "modules", "workspaces", "components"]);
const NON_WORKSPACE_FIXTURE_DIRS = new Set(["test", "tests", "fixtures", "docs", "examples", "benchmarks"]);

interface RepositoryEntry {
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
}

function walkRepository(repoRoot: string, maxDepth = 6): RepositoryEntry[] {
  const entries: RepositoryEntry[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: repoRoot, relativePath: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === ".DS_Store") continue;
      const relativePath = current.relativePath
        ? path.join(current.relativePath, child.name)
        : child.name;
      const absolutePath = path.join(repoRoot, relativePath);
      const isDirectory = child.isDirectory();
      entries.push({ relativePath, absolutePath, isDirectory });

      if (isDirectory && current.depth < maxDepth && !IGNORED_DIRS.has(child.name)) {
        queue.push({ absolutePath, relativePath, depth: current.depth + 1 });
      }
    }
  }

  return entries;
}

function relativeDirectory(relativeFile: string): string {
  const directory = path.dirname(relativeFile);
  return directory === "." ? "." : directory;
}

function readJson(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function hasWorkspaceDeclaration(packageJson: Record<string, any> | null): boolean {
  return Boolean(packageJson?.workspaces);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function hasPathSegment(relativePath: string, names: Set<string>): boolean {
  return relativePath.split(path.sep).some((segment) => names.has(segment));
}

function isLikelyNodeWorkspacePackage(relativePath: string): boolean {
  const directory = path.dirname(relativePath);
  return hasPathSegment(directory, NODE_WORKSPACE_DIRS) && !hasPathSegment(directory, NON_WORKSPACE_FIXTURE_DIRS);
}

export function detectProjectProfile(repoRoot: string): ProjectProfile {
  if (!fs.existsSync(repoRoot)) {
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
      summary: "Unidentified ecosystem",
    };
  }

  const entries = walkRepository(repoRoot);
  const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath);
  const directories = entries.filter((entry) => entry.isDirectory).map((entry) => entry.relativePath);
  const fileSet = new Set(files);
  const dirSet = new Set(directories);
  const rootFiles = new Set(
    files.filter((file) => !file.includes(path.sep)).map((file) => path.basename(file))
  );

  const configFiles: ProjectProfile["configFiles"] = {};
  const ecosystems: SupportedEcosystem[] = [];
  const languages: string[] = [];
  const packageRoots: string[] = [];
  const workspaceRoots: string[] = [];
  const testRoots: string[] = [];
  const entryPoints: string[] = [];

  const packageJsonPaths = files.filter((file) => path.basename(file) === "package.json");
  const pythonConfigNames = new Set([
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "poetry.lock",
    "uv.lock",
    "tox.ini",
    "pytest.ini",
  ]);
  const pythonConfigPaths = files.filter((file) => pythonConfigNames.has(path.basename(file)));
  const rustConfigPaths = files.filter((file) => ["Cargo.toml", "Cargo.lock"].includes(path.basename(file)));
  const goConfigPaths = files.filter((file) => ["go.mod", "go.sum", "go.work"].includes(path.basename(file)));

  const rootPackageJson = rootFiles.has("package.json")
    ? readJson(path.join(repoRoot, "package.json"))
    : null;
  const hasNodeWorkspaceDeclaration = hasWorkspaceDeclaration(rootPackageJson) || fileSet.has("pnpm-workspace.yaml");
  const nestedNodeWorkspacePackages = packageJsonPaths.filter((file) =>
    path.basename(file) === "package.json" &&
    relativeDirectory(file) !== "." &&
    isLikelyNodeWorkspacePackage(file)
  );
  // Node.js / TypeScript / JavaScript
  if (packageJsonPaths.length > 0 || files.some((file) => ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].includes(path.basename(file)))) {
    configFiles.node = sortedUnique([
      ...packageJsonPaths,
      ...files.filter((file) => ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "tsconfig.json"].includes(path.basename(file))),
    ]);
    ecosystems.push("node");
    languages.push(fileSet.has("tsconfig.json") || files.some((file) => path.basename(file) === "tsconfig.json") ? "typescript" : "javascript");

    if (hasNodeWorkspaceDeclaration || nestedNodeWorkspacePackages.length > 0) {
      addUnique(workspaceRoots, ".");
    }
    if (rootPackageJson) addUnique(packageRoots, ".");
    for (const packagePath of packageJsonPaths) {
      const packageData = readJson(path.join(repoRoot, packagePath));
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

  // Python
  if (pythonConfigPaths.length > 0) {
    configFiles.python = sortedUnique(pythonConfigPaths);
    ecosystems.push("python");
    languages.push("python");
    if (pythonConfigPaths.some((file) => !file.includes(path.sep))) addUnique(packageRoots, ".");
    for (const initFile of files.filter((file) => path.basename(file) === "__init__.py")) {
      addUnique(packageRoots, relativeDirectory(initFile));
    }
    if (dirSet.has("src")) addUnique(packageRoots, "src");
    const pythonProjectManifests = pythonConfigPaths.filter((file) =>
      ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"].includes(path.basename(file))
    );
    const nestedPythonProjects = pythonProjectManifests.filter((file) =>
      relativeDirectory(file) !== "." && !hasPathSegment(file, NON_WORKSPACE_FIXTURE_DIRS)
    );
    if (nestedPythonProjects.length > 0) {
      addUnique(workspaceRoots, ".");
    }
  }

  // Rust
  if (rustConfigPaths.length > 0) {
    configFiles.rust = sortedUnique(rustConfigPaths);
    ecosystems.push("rust");
    languages.push("rust");
    if (rustConfigPaths.some((file) => !file.includes(path.sep))) addUnique(packageRoots, ".");
    for (const cargoPath of rustConfigPaths.filter((file) => path.basename(file) === "Cargo.toml")) {
      const cargoText = fs.readFileSync(path.join(repoRoot, cargoPath), "utf-8");
      const cargoRoot = relativeDirectory(cargoPath);
      if (cargoText.includes("[workspace]")) addUnique(workspaceRoots, cargoRoot);
      if (cargoRoot !== ".") addUnique(packageRoots, cargoRoot);
    }
    for (const candidate of ["src", "crates", "examples"]) {
      if (dirSet.has(candidate)) addUnique(packageRoots, candidate);
    }
  }

  // Go
  if (goConfigPaths.length > 0) {
    configFiles.go = sortedUnique(goConfigPaths);
    ecosystems.push("go");
    languages.push("go");
    if (goConfigPaths.some((file) => !file.includes(path.sep))) addUnique(packageRoots, ".");
    const goModulePaths = goConfigPaths.filter((file) => path.basename(file) === "go.mod");
    if (goConfigPaths.some((file) => path.basename(file) === "go.work") || goModulePaths.length > 1) {
      addUnique(workspaceRoots, ".");
    }
    for (const goMod of goConfigPaths.filter((file) => path.basename(file) === "go.mod")) {
      const moduleRoot = relativeDirectory(goMod);
      if (moduleRoot !== ".") addUnique(packageRoots, moduleRoot);
    }
    for (const candidate of ["cmd", "internal", "pkg", "api"]) {
      if (dirSet.has(candidate)) addUnique(packageRoots, candidate);
    }
  }

  // A nested package is enough to make a repository a monorepo candidate even
  // when the root workspace file is omitted or uses a non-standard tool.
  if (
    nestedNodeWorkspacePackages.length > 0 ||
    rustConfigPaths.filter((file) => path.basename(file) === "Cargo.toml").length > 1 ||
    goConfigPaths.filter((file) => path.basename(file) === "go.mod").length > 1
  ) {
    addUnique(workspaceRoots, ".");
  }

  // Discover test roots at any supported package depth.
  for (const directory of directories) {
    const base = path.basename(directory);
    if (["tests", "test", "__tests__", "spec"].includes(base)) addUnique(testRoots, directory);
  }

  const entryNames = new Set([
    "index.ts", "index.js", "main.ts", "main.js", "main.rs", "lib.rs", "main.go", "main.py", "app.py", "cli.py", "__main__.py",
  ]);
  for (const file of files) {
    if (entryNames.has(path.basename(file))) addUnique(entryPoints, file);
  }

  const rootHasPython = rootFiles.has("pyproject.toml") || rootFiles.has("setup.py") || rootFiles.has("requirements.txt");
  const rootHasNode = rootFiles.has("package.json") || rootFiles.has("package-lock.json") || rootFiles.has("pnpm-lock.yaml") || rootFiles.has("yarn.lock") || rootFiles.has("bun.lock") || rootFiles.has("bun.lockb");
  const rootHasRust = rootFiles.has("Cargo.toml") || rootFiles.has("Cargo.lock");
  const rootHasGo = rootFiles.has("go.mod") || rootFiles.has("go.work");

  let primaryEcosystem: SupportedEcosystem = "unknown";
  if (ecosystems.length === 1) {
    primaryEcosystem = ecosystems[0];
  } else if (ecosystems.length > 1) {
    if (rootHasPython) primaryEcosystem = "python";
    else if (rootHasNode) primaryEcosystem = "node";
    else if (rootHasRust) primaryEcosystem = "rust";
    else if (rootHasGo) primaryEcosystem = "go";
    else primaryEcosystem = "mixed";
  }

  const isMonorepo = workspaceRoots.length > 0 || nestedNodeWorkspacePackages.length > 0 ||
    rustConfigPaths.filter((file) => path.basename(file) === "Cargo.toml").length > 1 ||
    goConfigPaths.filter((file) => path.basename(file) === "go.mod").length > 1;

  let confidence = primaryEcosystem === "unknown" ? 0.5 : 0.85;
  if (packageRoots.length > 0) confidence += 0.05;
  if (testRoots.length > 0) confidence += 0.05;
  if (entryPoints.length > 0) confidence += 0.05;

  const uniqueEcosystems = sortedUnique(ecosystems) as SupportedEcosystem[];
  const summary = uniqueEcosystems.length > 1
    ? `Multi-ecosystem (${uniqueEcosystems.join(" + ")}, primary: ${primaryEcosystem})`
    : primaryEcosystem !== "unknown"
    ? `${primaryEcosystem.charAt(0).toUpperCase() + primaryEcosystem.slice(1)} project`
    : "Unidentified ecosystem";

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
      go: configFiles.go,
    },
    confidence: Math.min(1, confidence),
    summary,
  };
}
