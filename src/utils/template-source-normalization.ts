import type { TemplateFieldConfig, TemplateSectionConfig } from "../types/template";
import type { TemplateFieldContext } from "../services/template-field-state-service";
import { resolveTemplateFieldContextFields } from "../services/template-field-state-service";
import { normalizeCompactSourceLabelFlow } from "./source-label-flow";

function collectStructuralLabels(
  sectionConfig: TemplateSectionConfig[],
  getSectionLabels: (section: TemplateSectionConfig) => string[]
): { structuralLabels: string[]; sectionLabels: string[] } {
  const sectionLabels = sectionConfig.flatMap((section) => getSectionLabels(section));
  const structuralLabels = Array.from(
    new Set(
      sectionConfig.flatMap((section) => {
        const labels = [...getSectionLabels(section)];
        const behavior = section.behavior;
        if (!behavior) {
          return labels;
        }

        if (behavior.kind === "field_block") {
          return [
            ...labels,
            ...behavior.fields.flatMap((field) => [field.label, ...(field.aliases ?? [])])
          ];
        }

        if (behavior.kind === "grouped_field_block") {
          return [
            ...labels,
            ...behavior.groups.flatMap((group) => [group.label, ...(group.aliases ?? [])]),
            ...behavior.fields.flatMap((field) => [field.label, ...(field.aliases ?? [])])
          ];
        }

        if (behavior.kind === "table_block") {
          const firstColumn = behavior.columns[0];
          return firstColumn
            ? [...labels, firstColumn.label, ...(firstColumn.aliases ?? [])]
            : labels;
        }

        if (behavior.kind === "mixed_field_block") {
          return [
            ...labels,
            ...behavior.items.flatMap((item) => {
              if (item.kind === "static_note") {
                return [];
              }

              if (item.kind === "inline_field_group") {
                return [
                  item.label,
                  ...(item.aliases ?? []),
                  ...item.fields.flatMap((field) => [field.label, ...(field.aliases ?? [])])
                ];
              }

              return [item.label, ...(item.aliases ?? [])];
            })
          ];
        }

        return labels;
      })
    )
  );

  return { structuralLabels, sectionLabels };
}

export function normalizeSourceTextForTemplate(
  sourceText: string,
  sectionConfig: TemplateSectionConfig[],
  templateFields: TemplateFieldContext | TemplateFieldConfig[],
  getSectionLabels: (section: TemplateSectionConfig) => string[]
): {
  normalizedSourceText: string;
  labelSets: {
    structuralLabels: string[];
    sectionLabels: string[];
    fieldLabels: string[];
  };
} {
  const { structuralLabels, sectionLabels } = collectStructuralLabels(sectionConfig, getSectionLabels);
  const fieldLabels = resolveTemplateFieldContextFields(templateFields).flatMap((field) => [
    field.name,
    ...(field.aliases ?? [])
  ]);

  return {
    normalizedSourceText: normalizeCompactSourceLabelFlow(
      sourceText,
      [...structuralLabels, ...fieldLabels],
      [...structuralLabels, ...fieldLabels],
      sectionLabels
    ),
    labelSets: {
      structuralLabels,
      sectionLabels,
      fieldLabels
    }
  };
}
