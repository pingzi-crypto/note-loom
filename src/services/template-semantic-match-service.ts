import type { StructuralMappingConfig, TemplateFieldConfig } from "../types/template";
import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import { templateStructureDescriptorFieldsToConfigs } from "./template-structure-descriptor-service";

type TemplateSemanticMatchFieldInput = TemplateFieldContext | TemplateFieldConfig[] | TemplateStructureDescriptor;

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isTemplateStructureDescriptor(value: TemplateSemanticMatchFieldInput): value is TemplateStructureDescriptor {
  return !Array.isArray(value) && "version" in value && "fields" in value && "sections" in value;
}

export class TemplateSemanticMatchService {
  enrichFields(
    fields: TemplateSemanticMatchFieldInput,
    structuralMapping: StructuralMappingConfig | undefined
  ): TemplateFieldConfig[] {
    const currentFields = isTemplateStructureDescriptor(fields)
      ? templateStructureDescriptorFieldsToConfigs(fields)
      : resolveTemplateFieldContextFields(fields);
    if (!structuralMapping || structuralMapping.conceptFields.length === 0) {
      return currentFields.map((field) => ({ ...field }));
    }

    return currentFields.map((field) => {
      const triggers = new Set(field.semanticTriggers ?? []);

      structuralMapping.conceptFields.forEach((mappingField) => {
        const isTarget = mappingField.renderTargets.some((target) => target.fieldName === field.name);
        if (!isTarget) {
          return;
        }

        uniqueNonEmpty([
          ...mappingField.aliases,
          ...mappingField.sourceHints
        ])
          .filter((value) => value !== field.name)
          .forEach((value) => triggers.add(value));
      });

      return {
        ...field,
        semanticTriggers: Array.from(triggers)
      };
    });
  }
}

export class TemplateStructuralMappingMatchService extends TemplateSemanticMatchService {}
