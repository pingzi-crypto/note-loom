import type { FieldMatchResult } from "../types/match";
import type { TemplateFieldConfig, TemplateSectionConfig } from "../types/template";
import { TemplateSectionConfigService } from "./template-section-config-service";
import {
  resolveTemplateFieldContextSnapshot,
  type TemplateFieldContext
} from "./template-field-state-service";

export interface GenerateFieldActivity {
  activeFieldNames: Set<string>;
  knownFieldNames: Set<string>;
}

function cloneResult(result: FieldMatchResult): FieldMatchResult {
  return {
    fieldName: result.fieldName,
    enabled: result.enabled,
    matched: result.matched,
    candidateValue: result.candidateValue,
    finalValue: result.finalValue,
    edited: result.edited,
    matchReason: result.matchReason,
    matchedLabel: result.matchedLabel
  };
}

export function resolveGenerateActiveFields(
  fields: TemplateFieldContext | TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionConfigService: TemplateSectionConfigService
): TemplateFieldConfig[] {
  const snapshot = resolveTemplateFieldContextSnapshot(fields, sectionConfig, sectionConfigService);
  return snapshot.matcherFields
    .map((field) => ({
      name: field.name,
      aliases: [...field.aliases],
      enabledByDefault: field.enabledByDefault,
      kind: field.kind,
      normalizerKey: field.normalizerKey,
      semanticTriggers: [...(field.semanticTriggers ?? [])],
      checkboxOptions: [...(field.checkboxOptions ?? [])]
    }));
}

export function resolveGenerateFieldActivity(
  fields: TemplateFieldContext | TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionConfigService: TemplateSectionConfigService
): GenerateFieldActivity {
  const snapshot = resolveTemplateFieldContextSnapshot(fields, sectionConfig, sectionConfigService);
  return {
    activeFieldNames: snapshot.reviewVisibleFieldNames,
    knownFieldNames: snapshot.knownFieldNames
  };
}

export function shouldIncludeGenerateFieldByName(
  fieldName: string,
  fields: TemplateFieldContext | TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionConfigService: TemplateSectionConfigService
): boolean {
  const trimmedFieldName = fieldName.trim();
  if (!trimmedFieldName) {
    return false;
  }

  const activity = resolveGenerateFieldActivity(fields, sectionConfig, sectionConfigService);
  if (!activity.knownFieldNames.has(trimmedFieldName)) {
    return true;
  }

  return activity.activeFieldNames.has(trimmedFieldName);
}

export function resolveGenerateDisplayResult(
  rawResult: FieldMatchResult,
  resolvedResult: FieldMatchResult
): FieldMatchResult {
  if (rawResult.edited) {
    return cloneResult(rawResult);
  }

  if (
    resolvedResult.finalValue.trim().length > 0 &&
    resolvedResult.finalValue.trim() !== rawResult.finalValue.trim()
  ) {
    return cloneResult(resolvedResult);
  }

  return cloneResult(rawResult);
}

export function shouldSkipDisplayOnlyFieldWrite(
  rawResult: FieldMatchResult,
  resolvedResult: FieldMatchResult,
  nextValue: string
): boolean {
  const rawValue = rawResult.finalValue.trim();
  const displayValue = resolveGenerateDisplayResult(rawResult, resolvedResult).finalValue.trim();

  return !rawResult.edited && rawValue !== displayValue && nextValue.trim() === displayValue;
}
