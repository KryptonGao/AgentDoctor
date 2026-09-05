import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanRepository } from "../src/core/scan/scanner.js";
import { createFindingFingerprint, flattenFindings } from "../src/core/findings/identity.js";
import { Finding, FindingSeverity, ScanResult } from "../src/core/types.js";

interface BenchmarkEntry {
  id: string;
  repository: string;
  url: string;
  commit: string;
  ecosystem: string;
  kind: string;
}

interface GoldenFinding {
  ruleId: string;
  fingerprint?: string;
}

interface GoldenRepository {
  reviewedRules: string[];
  expected: GoldenFinding[];
}

interface BenchmarkManifest {
  version: number;
  repositories: BenchmarkEntry[];
}

interface BenchmarkOptions {
  cacheDir: string;
  outputPath: string;
  markdownPath: string;
  runs: number;
  repoIds?: Set<string>;
  offline: boolean;
  strict: boolean;
}

interface RepositoryMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  unreviewed: number;
  reviewedActual: number;
  precision: number | null;
  recall: number | null;
  highCriticalFalsePositives: number;
  highCriticalUnreviewed: number;
  falsePositiveFindings: Array<{ ruleId: string; severity: FindingSeverity; title: string }>;
}

interface BenchmarkRepositoryResult {
  id: string;
  repository: string;
  commit: string;
  expectedEcosystem: string;
  detectedEcosystem: string;
  ecosystemMatch: boolean;
  kind: string;
  score: number;
  scannedFiles: number;
  findingCount: number;
  durationsMs: number[];
  medianScanMs: number;
  metrics: RepositoryMetrics;
}

interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  runsPerRepository: number;
  repositories: BenchmarkRepositoryResult[];
  totals: {
    repositories: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    unreviewed: number;
    precision: number | null;
    recall: number | null;
    highCriticalFalsePositives: number;
    highCriticalUnreviewed: number;
    medianScanMs: number;
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function executeGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = new Map<string, string>();
  const repoIds = new Set<string>();
  let offline = false;
  let strict = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--offline") offline = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--repo") repoIds.add(argv[++index]);
    else if (arg.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) args.set(arg.slice(2), argv[++index]);
  }

  return {
    cacheDir: path.resolve(args.get("cache-dir") || path.join(os.tmpdir(), "agentdoctor-benchmark-cache")),
    outputPath: path.resolve(args.get("output") || path.join(root, "benchmarks", "results", "latest.json")),
    markdownPath: path.resolve(args.get("markdown") || path.join(root, "benchmarks", "BENCHMARK.md")),
    runs: Math.max(1, Number(args.get("runs") || 3)),
    repoIds: repoIds.size > 0 ? repoIds : undefined,
    offline,
    strict,
  };
}

function ensureCheckout(entry: BenchmarkEntry, options: BenchmarkOptions): string {
  fs.mkdirSync(options.cacheDir, { recursive: true });
  const target = path.join(options.cacheDir, entry.id);
  const gitDirectory = path.join(target, ".git");

  if (!fs.existsSync(gitDirectory)) {
    if (options.offline) throw new Error(`${entry.id} is not cached and --offline was requested.`);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    try {
      executeGit(["clone", "--filter=blob:none", "--no-checkout", entry.url, target]);
    } catch {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      executeGit(["clone", "--no-checkout", entry.url, target]);
    }
  }

  if (!options.offline) {
    try {
      executeGit(["fetch", "--depth", "1", "origin", entry.commit], target);
    } catch {
      executeGit(["fetch", "origin", entry.commit], target);
    }
  }

  try {
    executeGit(["cat-file", "-e", `${entry.commit}^{commit}`], target);
  } catch {
    throw new Error(`Pinned commit ${entry.commit} for ${entry.id} is unavailable.`);
  }
  executeGit(["checkout", "--detach", "--force", entry.commit], target);
  return target;
}

function matchesExpected(finding: Finding, expected: GoldenFinding): boolean {
  if (finding.ruleId !== expected.ruleId) return false;
  return !expected.fingerprint || (finding.fingerprint || createFindingFingerprint(finding)) === expected.fingerprint;
}

function measureMetrics(result: ScanResult, golden: GoldenRepository): RepositoryMetrics {
  const findings = flattenFindings(result.findings).filter((finding) => finding.category !== "runtime");
  const reviewedRules = new Set(golden.reviewedRules || []);
  const expected = golden.expected || [];
  const reviewedFindings = findings.filter((finding) => reviewedRules.has(finding.ruleId));
  const truePositives = expected.filter((item) => findings.some((finding) => matchesExpected(finding, item))).length;
  const falsePositives = reviewedFindings.filter((finding) => !expected.some((item) => matchesExpected(finding, item)));
  const falseNegatives = expected.filter((item) => !findings.some((finding) => matchesExpected(finding, item))).length;
  const precision = truePositives + falsePositives.length > 0
    ? truePositives / (truePositives + falsePositives.length)
    : null;
  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : null;
  const highCriticalFalsePositives = falsePositives.filter((finding) => finding.severity === "high" || finding.severity === "critical").length;
  const highCriticalUnreviewed = findings.filter(
    (finding) => !reviewedRules.has(finding.ruleId) && (finding.severity === "high" || finding.severity === "critical")
  ).length;

  return {
    truePositives,
    falsePositives: falsePositives.length,
    falseNegatives,
    unreviewed: findings.filter((finding) => !reviewedRules.has(finding.ruleId)).length,
    reviewedActual: reviewedFindings.length,
    precision,
    recall,
    highCriticalFalsePositives,
    highCriticalUnreviewed,
    falsePositiveFindings: falsePositives.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: finding.title,
    })),
  };
}

function formatPercent(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function formatMarkdown(report: BenchmarkReport): string {
  const lines = [
    "# AgentDoctor Benchmark",
    "",
    `Pinned corpus: ${report.repositories.length} repositories · ${report.runsPerRepository} scans/repository · generated ${report.generatedAt}`,
    "",
    "| Repository | Ecosystem | Score | Findings | Median scan | TP | FP | FN | Unreviewed | Precision | Recall |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const repository of report.repositories) {
    const metrics = repository.metrics;
    lines.push(`| ${repository.repository} | ${repository.detectedEcosystem} | ${repository.score} | ${repository.findingCount} | ${repository.medianScanMs} ms | ${metrics.truePositives} | ${metrics.falsePositives} | ${metrics.falseNegatives} | ${metrics.unreviewed} | ${formatPercent(metrics.precision)} | ${formatPercent(metrics.recall)} |`);
  }

  lines.push(
    "",
    `Totals: ${report.totals.repositories} repositories · TP ${report.totals.truePositives} · FP ${report.totals.falsePositives} · FN ${report.totals.falseNegatives} · unreviewed ${report.totals.unreviewed} · precision ${formatPercent(report.totals.precision)} · recall ${formatPercent(report.totals.recall)} · median scan ${report.totals.medianScanMs} ms`,
    "",
    "Clone and checkout time are excluded from scan timings. The scanner runs without dependency installation, target-repository tests, or LLM access.",
  );
  return lines.join("\n") + "\n";
}

function validateReport(report: BenchmarkReport): string[] {
  const failures: string[] = [];
  if (report.repositories.length < 15) failures.push("benchmark corpus contains fewer than 15 repositories");
  if (report.totals.highCriticalFalsePositives > 0) failures.push("high/critical false positives detected");
  if (report.totals.precision !== null && report.totals.precision < 0.95) failures.push("reviewed precision is below 95%");
  for (const repository of report.repositories) {
    if (repository.metrics.highCriticalUnreviewed > 0) failures.push(`${repository.id} has unreviewed high/critical findings`);
    if (!repository.ecosystemMatch && repository.expectedEcosystem !== "mixed") failures.push(`${repository.id} ecosystem detection mismatch`);
  }
  return failures;
}

async function run(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseArgs(process.argv.slice(2));
  const manifest = readJson<BenchmarkManifest>(path.join(root, "benchmarks", "manifest.json"));
  const golden = readJson<{ version: number; repositories: Record<string, GoldenRepository> }>(path.join(root, "benchmarks", "golden.json"));
  const entries = manifest.repositories.filter((entry) => !options.repoIds || options.repoIds.has(entry.id));
  if (entries.length === 0) throw new Error("No benchmark repositories selected.");

  const repositories: BenchmarkRepositoryResult[] = [];
  for (const entry of entries) {
    process.stdout.write(`Benchmarking ${entry.repository}...\n`);
    const checkout = ensureCheckout(entry, options);
    const scans: ScanResult[] = [];
    for (let index = 0; index < options.runs; index++) {
      scans.push(await scanRepository({ cwd: checkout, enableAi: false, includeRuntime: false }));
    }
    const last = scans[scans.length - 1];
    const durationsMs = scans.map((scan) => scan.metadata.scanDurationMs);
    const metrics = measureMetrics(last, golden.repositories[entry.id] || { reviewedRules: [], expected: [] });
    const detectedEcosystem = last.projectProfile.ecosystems.length > 1
      ? "mixed"
      : last.projectProfile.primaryEcosystem;
    repositories.push({
      id: entry.id,
      repository: entry.repository,
      commit: entry.commit,
      expectedEcosystem: entry.ecosystem,
      detectedEcosystem,
      ecosystemMatch: entry.ecosystem === "mixed"
        ? last.projectProfile.ecosystems.length > 1
        : last.projectProfile.ecosystems.includes(entry.ecosystem as any),
      kind: entry.kind,
      score: last.overallScore,
      scannedFiles: last.metadata.scannedFilesCount,
      findingCount: flattenFindings(last.findings).filter((finding) => finding.category !== "runtime").length,
      durationsMs,
      medianScanMs: median(durationsMs),
      metrics,
    });
  }

  repositories.sort((a, b) => a.id.localeCompare(b.id));
  const aggregate = repositories.reduce((total, repository) => {
    total.truePositives += repository.metrics.truePositives;
    total.falsePositives += repository.metrics.falsePositives;
    total.falseNegatives += repository.metrics.falseNegatives;
    total.unreviewed += repository.metrics.unreviewed;
    total.highCriticalFalsePositives += repository.metrics.highCriticalFalsePositives;
    total.highCriticalUnreviewed += repository.metrics.highCriticalUnreviewed;
    total.medianScanValues.push(repository.medianScanMs);
    return total;
  }, {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    unreviewed: 0,
    highCriticalFalsePositives: 0,
    highCriticalUnreviewed: 0,
    medianScanValues: [] as number[],
  });
  const report: BenchmarkReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runsPerRepository: options.runs,
    repositories,
    totals: {
      repositories: repositories.length,
      truePositives: aggregate.truePositives,
      falsePositives: aggregate.falsePositives,
      falseNegatives: aggregate.falseNegatives,
      unreviewed: aggregate.unreviewed,
      precision: aggregate.truePositives + aggregate.falsePositives > 0
        ? aggregate.truePositives / (aggregate.truePositives + aggregate.falsePositives)
        : null,
      recall: aggregate.truePositives + aggregate.falseNegatives > 0
        ? aggregate.truePositives / (aggregate.truePositives + aggregate.falseNegatives)
        : null,
      highCriticalFalsePositives: aggregate.highCriticalFalsePositives,
      highCriticalUnreviewed: aggregate.highCriticalUnreviewed,
      medianScanMs: median(aggregate.medianScanValues),
    },
  };

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  fs.writeFileSync(options.markdownPath, formatMarkdown(report), "utf-8");
  process.stdout.write(`\n${formatMarkdown(report)}`);

  if (options.strict) {
    const failures = validateReport(report);
    if (failures.length > 0) {
      throw new Error(`Benchmark quality gate failed: ${failures.join("; ")}`);
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
