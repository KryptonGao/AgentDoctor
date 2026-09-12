import { Fix, ScanResult } from "../types.js";
import { VerifyCheckName, VerifyResult } from "../verify/types.js";
import { runVerify } from "../verify/verify.js";
import { scanRepository } from "../scan/scanner.js";
import { detectProjectProfile } from "../project/profile.js";
import { analyzeVerification } from "../../analyzers/verification/verificationAnalyzer.js";
import { getGitRoot } from "../../shared/git.js";
import { applyFixes } from "./fixEngine.js";
import {
  buildAgentShimFix,
  buildMissingAgentsFix,
  buildRegenerateAgentsFix,
} from "./bootstrap.js";
import { rollbackFixJournal } from "./journal.js";
import { createFixPullRequest, CreateFixPullRequestResult, ProcessRunner } from "./pullRequest.js";
import { toRepoRelative } from "./paths.js";

export interface FixLoopOptions {
  cwd?: string;
  safe?: boolean;
  generateAgents?: boolean;
  shims?: boolean;
  verify?: boolean;
  verifyAll?: boolean;
  createPullRequest?: boolean;
  pushPullRequest?: boolean;
  processRunner?: ProcessRunner;
  verifyFn?: (options: { cwd: string; only?: VerifyCheckName[] }) => Promise<Pick<VerifyResult, "passed" | "failures">>;
  selectFixes?: (fixes: Fix[]) => Fix[] | Promise<Fix[]>;
}

export interface FixLoopResult {
  initial: ScanResult;
  final?: ScanResult;
  applied: Fix[];
  failed: { fix: Fix; error: string }[];
  rolledBack: boolean;
  rollbackReason?: string;
  journalId?: string;
  verify?: Pick<VerifyResult, "passed" | "failures">;
  pullRequest?: CreateFixPullRequestResult;
  generatedAgents: boolean;
  generatedShims: string[];
}

function extraFixes(
  repoRoot: string,
  scan: ScanResult,
  options: FixLoopOptions
): Fix[] {
  const extras: Fix[] = [];
  if (options.generateAgents) {
    extras.push(buildRegenerateAgentsFix(repoRoot, scan.projectProfile, scan.verificationStatus));
  } else {
    const missing = buildMissingAgentsFix(repoRoot, scan.projectProfile, scan.verificationStatus);
    if (missing) extras.push(missing);
  }
  if (options.shims) {
    const shims = buildAgentShimFix(repoRoot);
    if (shims) extras.push(shims);
  }
  return extras;
}

function mergeFixes(primary: Fix[], extra: Fix[]): Fix[] {
  return [...new Map([...extra, ...primary].map((fix) => [fix.id, fix])).values()];
}

export async function runFixLoop(options: FixLoopOptions = {}): Promise<FixLoopResult> {
  const cwd = options.cwd || process.cwd();
  const repoRoot = getGitRoot(cwd);
  const initial = await scanRepository({ cwd: repoRoot, includeRuntime: false });
  const planned = mergeFixes(initial.availableFixes, extraFixes(repoRoot, initial, options));
  const selected = options.safe
    ? planned.filter((fix) => fix.isSafe || (options.generateAgents && fix.id === "fix-regenerate-agents-md"))
    : (await options.selectFixes?.(planned)) || planned;

  if (selected.length === 0) {
    return {
      initial,
      applied: [],
      failed: [],
      rolledBack: false,
      generatedAgents: false,
      generatedShims: [],
    };
  }

  const { applied, failed, journalId } = applyFixes(selected, { repoRoot, journal: true });
  const generatedAgents = applied.some((fix) => fix.id.includes("agents-md"));
  const generatedShims = applied
    .filter((fix) => fix.id === "fix-generate-agent-shims")
    .flatMap((fix) => (fix.changes || []).map((change) => toRepoRelative(repoRoot, change.path)));

  if (applied.length === 0) {
    return {
      initial,
      applied,
      failed,
      rolledBack: false,
      journalId,
      generatedAgents,
      generatedShims,
    };
  }

  if (options.verify || options.verifyAll) {
    const only: VerifyCheckName[] = options.verifyAll ? ["lint", "typecheck", "test", "build"] : ["lint", "typecheck"];
    const verify = await (options.verifyFn || runVerify)({ cwd: repoRoot, only });
    if (!verify.passed) {
      const rollback = rollbackFixJournal(repoRoot);
      return {
        initial,
        applied,
        failed,
        rolledBack: true,
        rollbackReason: rollback.error
          || verify.failures.join("; ")
          || "Post-fix verification failed",
        journalId,
        verify,
        generatedAgents,
        generatedShims,
        final: await scanRepository({ cwd: repoRoot, includeRuntime: false }),
      };
    }

    const final = await scanRepository({ cwd: repoRoot, includeRuntime: false });
    let pullRequest: CreateFixPullRequestResult | undefined;
    if (options.createPullRequest) {
      const files = [...new Set(applied.flatMap((fix) => (fix.changes || [{ path: fix.file }]).map((change) => toRepoRelative(repoRoot, change.path))))];
      pullRequest = createFixPullRequest({
        repoRoot,
        title: "chore: apply AgentDoctor instruction fixes",
        body: [
          "This pull request was created by `agentdoctor fix`.",
          "",
          `Score: ${initial.overallScore} → ${final.overallScore}`,
          "",
          ...applied.map((fix) => `- ${fix.title}`),
        ].join("\n"),
        files,
        runner: options.processRunner,
        push: options.pushPullRequest,
      });
    }

    return {
      initial,
      final,
      applied,
      failed,
      rolledBack: false,
      journalId,
      verify,
      pullRequest,
      generatedAgents,
      generatedShims,
    };
  }

  const final = await scanRepository({ cwd: repoRoot, includeRuntime: false });
  let pullRequest: CreateFixPullRequestResult | undefined;
  if (options.createPullRequest) {
    const files = [...new Set(applied.flatMap((fix) => (fix.changes || [{ path: fix.file }]).map((change) => toRepoRelative(repoRoot, change.path))))];
    pullRequest = createFixPullRequest({
      repoRoot,
      title: "chore: apply AgentDoctor instruction fixes",
      body: [
        "This pull request was created by `agentdoctor fix`.",
        "",
        `Score: ${initial.overallScore} → ${final.overallScore}`,
        "",
        ...applied.map((fix) => `- ${fix.title}`),
      ].join("\n"),
      files,
      runner: options.processRunner,
      push: options.pushPullRequest,
    });
  }

  return {
    initial,
    final,
    applied,
    failed,
    rolledBack: false,
    journalId,
    pullRequest,
    generatedAgents,
    generatedShims,
  };
}

export async function prepareGeneratedFixes(repoRoot: string, options: { generateAgents?: boolean; shims?: boolean }): Promise<Fix[]> {
  const profile = detectProjectProfile(repoRoot);
  const verification = await analyzeVerification(repoRoot, profile);
  const fixes: Fix[] = [];
  if (options.generateAgents) {
    fixes.push(buildRegenerateAgentsFix(repoRoot, profile, verification.verificationStatus));
  }
  if (options.shims) {
    const shims = buildAgentShimFix(repoRoot);
    if (shims) fixes.push(shims);
  }
  return fixes;
}
