import * as path from "node:path";
import { ProjectProfile, VerificationItem } from "../../core/types.js";
import { VerifyCheckName } from "../../core/verify/types.js";
import {
  detectNodePackageManager,
  packageManagerRunArgv,
  readNodePackageScripts,
} from "./nodeScripts.js";
import { isAllowedBinary } from "./sandbox.js";

export const VERIFY_CHECK_NAMES: VerifyCheckName[] = ["test", "lint", "typecheck", "build"];

export interface RunnableCheck {
  name: VerifyCheckName;
  displayCommand: string;
  argv: string[];
  cwdRelative: string;
  skipped: boolean;
  skipReason?: string;
}

const SAFE_TOKEN = /^[A-Za-z0-9_./:@+=-]+$/;

function splitSafeArgv(command: string): string[] | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (!tokens.every((token) => SAFE_TOKEN.test(token))) return undefined;
  if (!isAllowedBinary(tokens[0])) return undefined;
  return tokens;
}

function findScriptName(
  scripts: Record<string, string>,
  command: string | undefined,
  checkName: VerifyCheckName
): string | undefined {
  if (!command) return undefined;
  if (scripts[checkName] === command) return checkName;
  if (checkName === "typecheck") {
    for (const alias of ["type-check", "tsc", "compile"]) {
      if (scripts[alias] === command) return alias;
    }
  }
  const matches = Object.entries(scripts)
    .filter(([, value]) => value === command)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  return matches[0];
}

function nodeCheck(
  repoRoot: string,
  profile: ProjectProfile,
  item: VerificationItem
): RunnableCheck {
  const name = item.name as VerifyCheckName;
  if (!item.command || item.status === "not_applicable") {
    return {
      name,
      displayCommand: item.command || "",
      argv: [],
      cwdRelative: ".",
      skipped: true,
      skipReason: item.detail || "No executable command discovered",
    };
  }

  const packageScripts = readNodePackageScripts(repoRoot, profile);
  const scriptName = findScriptName(packageScripts.scripts, item.command, name);
  const source = (scriptName && packageScripts.sources[scriptName]) || "package.json";
  const cwdRelative = path.dirname(source) === "." ? "." : path.dirname(source);
  const packageRoot = cwdRelative === "." ? repoRoot : path.join(repoRoot, cwdRelative);
  const manager = detectNodePackageManager(packageRoot);

  if (scriptName) {
    const argv = packageManagerRunArgv(manager, scriptName);
    return {
      name,
      displayCommand: argv.join(" "),
      argv,
      cwdRelative,
      skipped: false,
    };
  }

  const argv = splitSafeArgv(item.command);
  if (!argv) {
    return {
      name,
      displayCommand: item.command,
      argv: [],
      cwdRelative,
      skipped: true,
      skipReason: "Command is not a package script and contains unsafe shell syntax",
    };
  }
  return { name, displayCommand: argv.join(" "), argv, cwdRelative, skipped: false };
}

function genericCheck(item: VerificationItem): RunnableCheck {
  const name = item.name as VerifyCheckName;
  if (!item.command || item.status === "not_applicable") {
    return {
      name,
      displayCommand: item.command || "",
      argv: [],
      cwdRelative: ".",
      skipped: true,
      skipReason: item.detail || "No executable command discovered",
    };
  }
  const argv = splitSafeArgv(item.command);
  if (!argv) {
    return {
      name,
      displayCommand: item.command,
      argv: [],
      cwdRelative: ".",
      skipped: true,
      skipReason: "Command contains unsafe shell syntax and will not be executed",
    };
  }
  return { name, displayCommand: argv.join(" "), argv, cwdRelative: ".", skipped: false };
}

export function resolveRunnableChecks(
  repoRoot: string,
  profile: ProjectProfile,
  items: VerificationItem[],
  only?: VerifyCheckName[]
): RunnableCheck[] {
  const selected = only && only.length > 0 ? new Set(only) : new Set(VERIFY_CHECK_NAMES);
  const useNode = profile.primaryEcosystem === "node" || profile.ecosystems.includes("node");

  return items
    .filter((item): item is VerificationItem & { name: VerifyCheckName } =>
      (VERIFY_CHECK_NAMES as string[]).includes(item.name)
    )
    .filter((item) => selected.has(item.name))
    .map((item) => (useNode ? nodeCheck(repoRoot, profile, item) : genericCheck(item)));
}

export function parseOnlyOption(value: string | undefined): VerifyCheckName[] | undefined {
  if (!value || !value.trim()) return undefined;
  const names = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const invalid = names.filter((name) => !(VERIFY_CHECK_NAMES as string[]).includes(name));
  if (invalid.length > 0) {
    throw new Error(`Unknown verify target "${invalid[0]}". Use test, lint, typecheck, and/or build.`);
  }
  return names as VerifyCheckName[];
}
