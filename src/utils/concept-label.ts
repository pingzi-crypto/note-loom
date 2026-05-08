import type { ConceptFieldConfig } from "../types/template";

function getFirstNonEmptyValue(values: string[]): string {
  return values.map((value) => value.trim()).find((value) => value.length > 0) ?? "";
}

export function resolveConceptDisplayLabel(concept: Pick<ConceptFieldConfig, "aliases" | "renderTargets">): string {
  return getFirstNonEmptyValue([
    ...concept.aliases,
    ...concept.renderTargets.map((target) => target.fieldName)
  ]);
}
