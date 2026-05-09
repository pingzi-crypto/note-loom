import type {
  EnumOptionConfig,
  StructuralMappingFieldConfig,
  StructuralMappingValueType,
  TemplateFieldConfig,
} from "../types/template";
import type { FieldStructureDescriptor, TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import { templateStructureDescriptorFieldsToConfigs } from "./template-structure-descriptor-service";

export type StructuralRuleStatus = "unconfigured" | "partial" | "complete";
export interface StructuralRuleSummary {
  key: string;
  vars?: Record<string, string | number>;
}

type TemplateStructuralRuleFieldInput = TemplateFieldContext | TemplateFieldConfig[] | TemplateStructureDescriptor;

function normalizeStructuralRuleLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·]/g, "");
}

function resolvePrimaryStructuralRuleFieldName(concept: StructuralMappingFieldConfig): string {
  return concept.renderTargets.map((target) => target.fieldName.trim()).find(Boolean) || "";
}

function resolveStructuralRuleInputs(concept: StructuralMappingFieldConfig): string[] {
  return Array.from(
    new Set(
      [...concept.aliases, ...concept.sourceHints]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
}

function hasMeaningfulTriggers(field: TemplateFieldConfig | undefined): boolean {
  return Boolean(field?.semanticTriggers?.some((trigger) => trigger.trim().length > 0));
}

function hasMeaningfulNormalizer(field: TemplateFieldConfig | undefined): boolean {
  return Boolean(field?.normalizerKey?.trim());
}

function isDateLikeField(field: TemplateFieldConfig | undefined): boolean {
  if (!field) {
    return false;
  }

  return field.normalizerKey === "date";
}

export function shouldCreateStructuralRuleForField(field: TemplateFieldConfig): boolean {
  return (
    field.kind === "checkbox_group" ||
    isDateLikeField(field) ||
    hasMeaningfulNormalizer(field) ||
    hasMeaningfulTriggers(field) ||
    Boolean(field.checkboxOptions?.length)
  );
}

export function shouldCreateStructuralRuleForFieldDescriptor(field: FieldStructureDescriptor): boolean {
  return (
    field.features.includes("checkbox_group") ||
    field.features.includes("boolean_like_options") ||
    field.features.includes("enum_options") ||
    field.features.includes("explicit_normalizer") ||
    field.features.includes("explicit_semantic_triggers") ||
    field.features.includes("semantic_render_targets") ||
    Boolean(field.checkboxOptions.length) ||
    Boolean(field.normalizerKey?.trim())
  );
}

function isTemplateStructureDescriptor(value: TemplateStructuralRuleFieldInput): value is TemplateStructureDescriptor {
  return !Array.isArray(value) && "version" in value && "fields" in value && "sections" in value;
}

function resolveStructuralRuleFieldConfigs(
  fields: TemplateStructuralRuleFieldInput
): TemplateFieldConfig[] {
  return isTemplateStructureDescriptor(fields)
    ? templateStructureDescriptorFieldsToConfigs(fields)
    : resolveTemplateFieldContextFields(fields);
}

function hasSupplementalRuleInputs(concept: StructuralMappingFieldConfig): boolean {
  return (
    resolveStructuralRuleInputs(concept).length > 0 ||
    concept.enumOptions.some((option) => option.aliases.some((alias) => alias.trim().length > 0))
  );
}

export function isStructuralRuleCandidate(
  concept: StructuralMappingFieldConfig,
  fields: TemplateStructuralRuleFieldInput
): boolean {
  const descriptorInput = isTemplateStructureDescriptor(fields) ? fields : undefined;
  const currentFields = resolveStructuralRuleFieldConfigs(fields);
  const fieldMap = new Map(currentFields.map((field) => [field.name, field] as const));
  const descriptorFieldMap = new Map(
    (descriptorInput?.fields ?? []).map((field) => [field.fieldName, field] as const)
  );
  const targetFields = concept.renderTargets
    .map((target) => fieldMap.get(target.fieldName))
    .filter((field): field is TemplateFieldConfig => Boolean(field));
  const targetDescriptors = concept.renderTargets
    .map((target) => descriptorFieldMap.get(target.fieldName))
    .filter((field): field is FieldStructureDescriptor => Boolean(field));

  if (hasSupplementalRuleInputs(concept)) {
    return true;
  }

  if (concept.renderTargets.length > 1) {
    return true;
  }

  if (
    targetDescriptors.some((field) => field.features.includes("explicit_semantic_triggers")) ||
    targetFields.some((field) => hasMeaningfulTriggers(field))
  ) {
    return true;
  }

  return false;
}

export function resolveStructuralRuleStatusRank(status: StructuralRuleStatus): number {
  switch (status) {
    case "unconfigured":
      return 0;
    case "partial":
      return 1;
    case "complete":
    default:
      return 2;
  }
}

export function resolveStructuralRuleTitle(concept: StructuralMappingFieldConfig): string {
  return (
    resolvePrimaryStructuralRuleFieldName(concept) ||
    concept.label.trim()
  );
}

export function resolveStructuralRuleSystemTopic(concept: StructuralMappingFieldConfig): string {
  return resolvePrimaryStructuralRuleFieldName(concept) || concept.label.trim();
}

export function shouldShowStructuralRuleSystemTopic(
  title: string,
  systemTopic: string
): boolean {
  const normalizedTitle = normalizeStructuralRuleLabel(title);
  const normalizedSystemTopic = normalizeStructuralRuleLabel(systemTopic);

  if (!normalizedSystemTopic) {
    return false;
  }

  return normalizedTitle !== normalizedSystemTopic;
}

export function resolveStructuralRuleTargetNames(
  concept: StructuralMappingFieldConfig
): string[] {
  return concept.renderTargets
    .map((target) => target.fieldName.trim())
    .filter((fieldName) => fieldName.length > 0);
}

export function hasStructuralRuleAliases(concept: StructuralMappingFieldConfig): boolean {
  return resolveStructuralRuleInputs(concept).length > 0;
}

export function hasStructuralRuleTargets(concept: StructuralMappingFieldConfig): boolean {
  return concept.renderTargets.some((target) => target.fieldName.trim().length > 0);
}

export function countStructuralRuleAliases(concept: StructuralMappingFieldConfig): number {
  return resolveStructuralRuleInputs(concept).length;
}

export function countStructuralRuleTargets(concept: StructuralMappingFieldConfig): number {
  return concept.renderTargets.filter((target) => target.fieldName.trim().length > 0).length;
}

export function countCompleteEnumOptions(concept: StructuralMappingFieldConfig): number {
  return concept.enumOptions.filter(isEnumOptionComplete).length;
}

export function isEnumMappingEnabled(concept: StructuralMappingFieldConfig): boolean {
  return concept.valueType === "enum" || concept.enumOptions.length > 0;
}

export function isEnumOptionComplete(option: EnumOptionConfig): boolean {
  return option.label.trim().length > 0 && option.normalizedValue.trim().length > 0;
}

export function isEnumMappingComplete(concept: StructuralMappingFieldConfig): boolean {
  if (!isEnumMappingEnabled(concept)) {
    return true;
  }

  if (concept.enumOptions.length === 0) {
    return false;
  }

  return concept.enumOptions.every(isEnumOptionComplete);
}

export function resolveStructuralRuleStatus(
  concept: StructuralMappingFieldConfig
): StructuralRuleStatus {
  const hasAliases = hasStructuralRuleAliases(concept);
  const hasTargets = hasStructuralRuleTargets(concept);

  if (!hasAliases && !hasTargets) {
    return "unconfigured";
  }

  if (!hasAliases || !hasTargets || !isEnumMappingComplete(concept)) {
    return "partial";
  }

  return "complete";
}

export function resolveStructuralRuleSummary(
  concept: StructuralMappingFieldConfig
): StructuralRuleSummary {
  const hasAliases = hasStructuralRuleAliases(concept);
  const hasTargets = hasStructuralRuleTargets(concept);
  const aliasCount = countStructuralRuleAliases(concept);
  const targetCount = countStructuralRuleTargets(concept);
  const enumCount = countCompleteEnumOptions(concept);

  if (!hasAliases && !hasTargets) {
    return { key: "structural_rule_summary_empty" };
  }

  if (hasAliases && !hasTargets) {
    return {
      key: "structural_rule_summary_aliases_only",
      vars: { count: aliasCount }
    };
  }

  if (!hasAliases && hasTargets) {
    return {
      key: "structural_rule_summary_targets_only",
      vars: { count: targetCount }
    };
  }

  if (!isEnumMappingComplete(concept)) {
    return {
      key: "structural_rule_summary_enum_incomplete",
      vars: { aliases: aliasCount, targets: targetCount, count: enumCount }
    };
  }

  if (isEnumMappingEnabled(concept)) {
    return {
      key: "structural_rule_summary_complete",
      vars: { aliases: aliasCount, targets: targetCount, count: enumCount }
    };
  }

  return {
    key: "structural_rule_summary_basic_complete",
    vars: { aliases: aliasCount, targets: targetCount }
  };
}

export function resolveNonEnumValueType(
  concept: StructuralMappingFieldConfig,
  fields: TemplateStructuralRuleFieldInput
): StructuralMappingValueType {
  if (concept.valueType === "date") {
    return "date";
  }

  const currentFields = resolveStructuralRuleFieldConfigs(fields);
  const fieldMap = new Map(currentFields.map((field) => [field.name, field] as const));
  const isDateTarget = concept.renderTargets.some((target) => {
    const field = fieldMap.get(target.fieldName);
    if (!field) {
      return false;
    }

    return field.normalizerKey === "date";
  });

  return isDateTarget ? "date" : "text";
}
