import type { TemplateFieldConfig, TemplateSectionConfig } from "../types/template";
import type { TemplateFieldContext } from "./template-field-state-service";
import { normalizeSourceTextForTemplate } from "../utils/template-source-normalization";

export interface PrepareSourceForExtractionInput {
  sourceText: string;
  sectionConfig: TemplateSectionConfig[];
  templateFields: TemplateFieldContext | TemplateFieldConfig[];
  getSectionLabels: (section: TemplateSectionConfig) => string[];
}

export interface PreparedSourceForExtraction {
  rawSourceText: string;
  normalizedSourceText: string;
  labelSets: {
    structuralLabels: string[];
    sectionLabels: string[];
    fieldLabels: string[];
  };
  normalizationVersion: 1;
}

export class SourcePreparationService {
  prepareForExtraction(input: PrepareSourceForExtractionInput): PreparedSourceForExtraction {
    const normalized = normalizeSourceTextForTemplate(
      input.sourceText,
      input.sectionConfig,
      input.templateFields,
      input.getSectionLabels
    );
    return {
      rawSourceText: input.sourceText,
      normalizedSourceText: normalized.normalizedSourceText,
      labelSets: normalized.labelSets,
      normalizationVersion: 1
    };
  }
}
