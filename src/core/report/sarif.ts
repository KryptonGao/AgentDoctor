import { Finding, FindingSeverity, ScanResult } from "../types.js";
import { flattenFindings } from "../findings/identity.js";
import { toRepoRelative } from "../fix/paths.js";

export type SarifLevel = "error" | "warning" | "note";

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version?: string;
        informationUri?: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
          helpUri?: string;
        }>;
      };
    };
    originalUriBaseIds?: {
      SRCROOT: { uri: string };
    };
    results: Array<{
      ruleId: string;
      ruleIndex?: number;
      level: SarifLevel;
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string; uriBaseId?: string };
          region?: { startLine: number; endLine?: number };
        };
      }>;
    }>;
  }>;
}

function sarifLevel(severity: FindingSeverity): SarifLevel {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function findingUri(repoRoot: string, finding: Finding): { uri: string; startLine?: number; endLine?: number } {
  const evidence = finding.evidence[0];
  const file = evidence?.file || ".";
  return {
    uri: toRepoRelative(repoRoot, file),
    startLine: evidence?.line,
    endLine: evidence?.endLine,
  };
}

export function scanResultToSarif(result: ScanResult, options: { version?: string } = {}): SarifLog {
  const findings = flattenFindings(result.findings);
  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))].sort((a, b) => a.localeCompare(b));
  const ruleIndex = new Map(ruleIds.map((id, index) => [id, index]));
  const rules = ruleIds.map((id) => {
    const sample = findings.find((finding) => finding.ruleId === id);
    return {
      id,
      name: id,
      shortDescription: { text: sample?.title || id },
      helpUri: "https://github.com/search?q=agentdoctor",
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
            rules,
          },
        },
        originalUriBaseIds: {
          SRCROOT: { uri: `${result.repositoryRoot.replace(/\\/g, "/")}/` },
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
                  region: loc.startLine
                    ? { startLine: loc.startLine, endLine: loc.endLine && loc.endLine >= loc.startLine ? loc.endLine : loc.startLine }
                    : undefined,
                },
              },
            ],
          };
        }),
      },
    ],
  };
}
