import { Finding } from "../../core/types.js";
import { findGeneratedDirectories, findSecurityScanFiles } from "./files.js";
import {
  detectDangerousShell,
  detectExternalNetwork,
  detectGeneratedEdits,
  detectHiddenUnicode,
  detectInstructionSecrets,
  detectMcpAndHookPermissions,
  detectPromptInjection,
  detectUntrustedInput,
} from "./detectors.js";

export async function analyzeSecurity(repoRoot: string): Promise<{
  findings: Finding[];
  scannedFiles: string[];
}> {
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
    ...detectUntrustedInput(files),
  ].sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));

  return {
    findings,
    scannedFiles: files.map((file) => file.relativePath),
  };
}
