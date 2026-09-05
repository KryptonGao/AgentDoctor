import { ContextSignalDensity } from "../../core/types.js";

export function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  // Match word/number runs or individual punctuation/CJK characters
  const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
  return matches ? matches.length : 0;
}

export interface TokenBreakdownInput {
  totalContent: string;
  duplicateSnippets: string[];
  inferableSnippets: string[];
  staleSnippets: string[];
  lowValueSnippets: string[];
  /** Optional line/file identities used to prevent overlapping penalties. */
  wastefulSnippets?: Array<{ key: string; text: string }>;
}

function sumTokens(snippets: string[]): number {
  return snippets.reduce((sum, snippet) => sum + estimateTokens(snippet), 0);
}

export function calculateSignalDensity(input: TokenBreakdownInput): ContextSignalDensity {
  const totalTokens = estimateTokens(input.totalContent);

  const duplicateTokens = sumTokens(input.duplicateSnippets);
  const inferableTokens = sumTokens(input.inferableSnippets);
  const staleTokens = sumTokens(input.staleSnippets);
  const lowValueTokens = sumTokens(input.lowValueSnippets);

  const uniqueWastefulSnippets = new Map<string, string>();
  if (input.wastefulSnippets) {
    for (const snippet of input.wastefulSnippets) {
      if (!uniqueWastefulSnippets.has(snippet.key)) {
        uniqueWastefulSnippets.set(snippet.key, snippet.text);
      }
    }
  } else {
    const categories: Array<[string, string[]]> = [
      ["duplicate", input.duplicateSnippets],
      ["inferable", input.inferableSnippets],
      ["stale", input.staleSnippets],
      ["low-value", input.lowValueSnippets],
    ];
    for (const [category, snippets] of categories) {
      snippets.forEach((snippet, index) => {
        uniqueWastefulSnippets.set(`${category}:${index}:${snippet}`, snippet);
      });
    }
  }

  const wastefulTokens = [...uniqueWastefulSnippets.values()].reduce(
    (sum, snippet) => sum + estimateTokens(snippet),
    0
  );
  const usefulTokens = Math.max(0, totalTokens - wastefulTokens);

  const densityPercent =
    totalTokens > 0
      ? Number(((usefulTokens / totalTokens) * 100).toFixed(1))
      : 100.0;

  return {
    totalTokens,
    usefulTokens,
    wastefulTokens,
    duplicateTokens,
    inferableTokens,
    staleTokens,
    lowValueTokens,
    densityPercent,
  };
}
