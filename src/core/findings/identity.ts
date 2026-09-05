import { createHash } from "node:crypto";
import { Finding } from "../types.js";

function normalize(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function compareEvidence(a: Finding["evidence"][number], b: Finding["evidence"][number]): number {
  return a.file.localeCompare(b.file) ||
    (a.line || 0) - (b.line || 0) ||
    (a.endLine || 0) - (b.endLine || 0) ||
    normalize(a.snippet || "").localeCompare(normalize(b.snippet || "")) ||
    normalize(a.source || "").localeCompare(normalize(b.source || ""));
}

/**
 * Build a stable finding identity. Line numbers are intentionally excluded so
 * adding text above an instruction does not turn an existing issue into a
 * regression.
 */
export function createFindingFingerprint(finding: Finding): string {
  const evidence = [...finding.evidence]
    .sort(compareEvidence)
    .slice(0, 3)
    .map((item) => `${normalize(item.file)}|${normalize(item.snippet || "")}`)
    .join("||");

  const fallback = `${normalize(finding.title)}|${normalize(finding.groupKey || "")}`;

  return `v1:${digest(`${finding.category}|${finding.ruleId}|${evidence || fallback}`)}`;
}

export function createGroupFingerprint(ruleId: string, groupKey: string): string {
  return `group:v1:${digest(`${ruleId}|${normalize(groupKey)}`)}`;
}

export function ensureFindingFingerprints(findings: Finding[]): Finding[] {
  return findings.map((finding) => {
    if (finding.children && finding.children.length > 0) {
      finding.children = ensureFindingFingerprints(finding.children).sort((a, b) =>
        (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id) || a.id.localeCompare(b.id)
      );
    }

    finding.evidence = [...finding.evidence].sort(compareEvidence);

    // Low-confidence findings are intentionally visible, but must be marked
    // for manual review everywhere (not only in individual analyzers).
    if (finding.confidence < 0.8) finding.needsReview = true;

    if (!finding.fingerprint) {
      finding.fingerprint = createFindingFingerprint(finding);
    }

    return finding;
  });
}

export function flattenFindings(findings: Finding[]): Finding[] {
  const flat: Finding[] = [];

  for (const finding of findings) {
    if (finding.children && finding.children.length > 0) {
      flat.push(...flattenFindings(finding.children));
    } else {
      flat.push(finding);
    }
  }

  return flat;
}
