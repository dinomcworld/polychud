export interface OutcomeLabels {
  yes: string;
  no: string;
}

export function resolveOutcomeLabels(
  yes: string | null | undefined,
  no: string | null | undefined,
): OutcomeLabels {
  return { yes: yes ?? "Yes", no: no ?? "No" };
}

export function outcomeLabel(
  side: "yes" | "no",
  labels: OutcomeLabels,
): string {
  return side === "yes" ? labels.yes : labels.no;
}
