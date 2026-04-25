/** Truncate `s` to at most `max` chars (including the trailing ellipsis).
 * Used everywhere we need to fit a label/question into Discord's various
 * length caps (100 for select-option labels, 256 for embed titles, etc.). */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Keep room for "…" — using the single-char ellipsis to maximize content,
  // but stick with "..." since the rest of the codebase already does.
  return `${s.slice(0, max - 3)}...`;
}
