import { Finding, Evidence } from "../types.js";
import {
  createGroupFingerprint,
  ensureFindingFingerprints,
} from "./identity.js";

export function aggregateFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();

  for (const f of ensureFindingFingerprints(findings)) {
    const key = f.groupKey || f.ruleId;
    const list = groups.get(key) || [];
    list.push(f);
    groups.set(key, list);
  }

  const aggregated: Finding[] = [];

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [key, unsortedItems] of sortedGroups) {
    const items = [...unsortedItems].sort((a, b) =>
      (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id) || a.id.localeCompare(b.id)
    );

    if (items.length === 1) {
      aggregated.push(items[0]);
      continue;
    }

    // Determine highest severity
    const severities = items.map((i) => i.severity);
    const severity = severities.includes("critical")
      ? "critical"
      : severities.includes("high")
      ? "high"
      : severities.includes("medium")
      ? "medium"
      : "low";

    // Average confidence
    const avgConfidence = Number(
      (items.reduce((sum, i) => sum + i.confidence, 0) / items.length).toFixed(2)
    );

    // Sum token impact if present
    const totalTokenImpact = items.reduce(
      (sum, i) => sum + (i.impact?.tokens || 0),
      0
    );

    // Build specific title & description based on rule
    let title = `${items.length} ${items[0].title}`;
    let description = items[0].description;

    if (key.includes("large-file") || key.includes("oversized-source-file")) {
      title = `${items.length} oversized source files may increase agent retrieval cost`;
      const topItems = [...items]
        .sort((a, b) => (b.impact?.tokens || 0) - (a.impact?.tokens || 0))
        .slice(0, 3);

      const topSummary = topItems
        .map((t) => `${t.evidence[0]?.file || t.title} (${t.evidence[0]?.snippet || ""})`)
        .join("; ");

      description = `Found ${items.length} large source files. Large files increase token expenditure and edit ambiguity for AI agents. Largest: ${topSummary}`;
    } else if (key.includes("stale-path")) {
      title = `${items.length} unresolved or stale path references in instructions`;
      const topItems = items.slice(0, 3).map((t) => t.evidence[0]?.snippet || t.title).join(", ");
      description = `Instructions reference ${items.length} paths that could not be resolved in the repository: ${topItems}`;
    } else if (key.includes("duplicate-instruction")) {
      title = `${items.length} duplicate instruction rules detected across context files`;
      description = `Detected ${items.length} redundant or repetitive instruction blocks that dilute agent context signal density.`;
    }

    const aggregatedEvidence: Evidence[] = items
      .slice(0, 5)
      .flatMap((i) => i.evidence)
      .filter((evidence, index, all) => {
        const key = `${evidence.file}|${evidence.line || ""}|${evidence.snippet || ""}`;
        return all.findIndex((candidate) =>
          `${candidate.file}|${candidate.line || ""}|${candidate.snippet || ""}` === key
        ) === index;
      })
      .sort((a, b) => {
        const fileCompare = a.file.localeCompare(b.file);
        if (fileCompare !== 0) return fileCompare;
        return (a.line || 0) - (b.line || 0) ||
          (a.endLine || 0) - (b.endLine || 0) ||
          (a.snippet || "").localeCompare(b.snippet || "") ||
          (a.source || "").localeCompare(b.source || "");
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
        tokens: totalTokenImpact || undefined,
      },
      recommendation: items[0].recommendation,
      groupKey: key,
      children: items,
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
