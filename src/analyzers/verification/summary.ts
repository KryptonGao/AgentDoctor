const INTERESTING =
  /fail(?:ed|ure)?|error|fatal|panic:|assertion|✗|×|not found|timed? ?out|cannot |can't |unable |denied|traceback|e\d{4}\b/i;

const MAX_SUMMARY_CHARS = 1_500;
const MAX_LINES = 20;

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function summarizeFailure(stdout: string, stderr: string, fallback?: string): string | undefined {
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  if (!combined.trim() && fallback) return clip(fallback);

  const lines = normalizeLines(combined);
  const interesting = lines.filter((line) => INTERESTING.test(line));
  const chosen = (interesting.length > 0 ? interesting : lines).slice(-MAX_LINES);
  if (chosen.length === 0) return fallback ? clip(fallback) : undefined;
  return clip(chosen.join("\n"));
}

function clip(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}
