import type { StructuralMappingFieldConfig } from "../types/template";

function cloneConceptField(concept: StructuralMappingFieldConfig): StructuralMappingFieldConfig {
  return {
    ...concept,
    aliases: [...concept.aliases],
    enumOptions: concept.enumOptions.map((option) => ({
      ...option,
      aliases: [...option.aliases]
    })),
    sourceHints: [...concept.sourceHints],
    renderTargets: concept.renderTargets.map((target) => ({ ...target }))
  };
}

export function replaceConceptFieldById(
  concepts: StructuralMappingFieldConfig[],
  conceptId: string,
  nextConcept: StructuralMappingFieldConfig,
  fallbackIndex = -1
): StructuralMappingFieldConfig[] {
  const actualIndex = concepts.findIndex((concept) => concept.id === conceptId);
  const targetIndex = actualIndex >= 0 ? actualIndex : fallbackIndex;

  if (targetIndex < 0 || targetIndex >= concepts.length) {
    return concepts.map((concept) => cloneConceptField(concept));
  }

  return concepts.map((concept, index) =>
    index === targetIndex ? cloneConceptField(nextConcept) : cloneConceptField(concept)
  );
}
