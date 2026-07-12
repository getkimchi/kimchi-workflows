/**
 * Tolerantly extract a JSON value from an LLM's free-form text (spec §2.2 agent output). Models
 * often wrap JSON in ``` fences or surrounding prose; this tries, in order: the whole text, any
 * fenced code block, and the widest `{...}` / `[...]` slice. Pure — no deps.
 */
export type JsonExtraction = { ok: true; value: unknown } | { ok: false };

export function extractJson(text: string): JsonExtraction {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }

  pushWidestSlice(candidates, trimmed, "{", "}");
  pushWidestSlice(candidates, trimmed, "[", "]");

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false };
}

function pushWidestSlice(candidates: string[], text: string, open: string, close: string): void {
  const first = text.indexOf(open);
  const last = text.lastIndexOf(close);
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }
}
