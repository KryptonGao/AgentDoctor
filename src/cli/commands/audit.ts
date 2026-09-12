import * as path from "node:path";
import { AUDIT_SCHEMA_VERSION, FindingSeverity } from "../../core/types.js";
import { getGitBranch, getGitRoot } from "../../shared/git.js";
import { analyzeSecurity } from "../../analyzers/security/securityAnalyzer.js";
import { aggregateFindings } from "../../core/findings/aggregator.js";
import { generateFixPrompt } from "../../core/prompt/promptGenerator.js";
import { calculateCategoryScore } from "../../core/score/calculator.js";
import { auditFailures } from "../../core/audit/audit.js";
import { formatAuditResult } from "../formatters/audit.js";

export interface AuditCommandOptions {
  cwd?: string;
  json?: boolean;
  failOn?: string;
}

const SEVERITIES: FindingSeverity[] = ["critical", "high", "medium", "low"];

export async function runAuditCommand(options: AuditCommandOptions = {}) {
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const failOn = options.failOn && SEVERITIES.includes(options.failOn as FindingSeverity)
    ? options.failOn as FindingSeverity
    : options.failOn
      ? undefined
      : "high";

  if (options.failOn && !failOn) {
    console.error(`Invalid --fail-on severity: ${options.failOn}`);
    process.exitCode = 2;
    return;
  }

  const raw = await analyzeSecurity(repoRoot);
  const findings = aggregateFindings(raw.findings);
  for (const finding of findings) {
    finding.fixPrompt = generateFixPrompt(finding);
    if (finding.children) {
      for (const child of finding.children) {
        child.fixPrompt = generateFixPrompt(child);
      }
    }
  }

  const failures = auditFailures(findings, failOn);
  const result = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    repositoryName: path.basename(repoRoot),
    repositoryRoot: repoRoot,
    branch: getGitBranch(repoRoot),
    timestamp: new Date().toISOString(),
    score: calculateCategoryScore("security", findings),
    findings,
    passed: failures.length === 0,
    failures,
    exitCode: (failures.length === 0 ? 0 : 1) as 0 | 1,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAuditResult(result));
  }
  process.exitCode = result.exitCode;
}
