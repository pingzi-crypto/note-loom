import type { TemplateFieldConfig, TemplateRulePackConfig } from "../types/template";
import type { TemplateFieldRule } from "../types/rules";
import type { FieldStructureDescriptor } from "../types/template-structure-descriptor";
import { isBooleanLikeOptionSet } from "../utils/boolean-like-field";
import {
  isTemplateFieldContext,
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import { buildFieldStructureDescriptor } from "./template-structure-descriptor-service";
import {
  resolveBuiltInFieldAliasPackEntry,
  resolveBuiltInFieldOptionPackEntry
} from "./template-rule-pack-service";

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

export type TemplateGenericFieldRuleInput =
  | TemplateFieldContext
  | TemplateFieldConfig[]
  | FieldStructureDescriptor[];

function isFieldStructureDescriptor(value: TemplateFieldConfig | FieldStructureDescriptor): value is FieldStructureDescriptor {
  return "fieldName" in value && "features" in value && "evidence" in value;
}

function resolveFieldDescriptors(fields: TemplateGenericFieldRuleInput): FieldStructureDescriptor[] {
  if (Array.isArray(fields) && fields.every(isFieldStructureDescriptor)) {
    return fields;
  }

  const templateFields = isTemplateFieldContext(fields) ? resolveTemplateFieldContextFields(fields) : fields;
  return templateFields
    .map((field) => buildFieldStructureDescriptor(field, undefined));
}

function inferGenericRule(
  field: FieldStructureDescriptor,
  rulePackConfig?: TemplateRulePackConfig
): TemplateFieldRule | null {
  const aliases: string[] = [];
  const semanticTriggers: string[] = [];
  let normalizerKey = field.normalizerKey;
  let kind = field.checkboxOptions && field.checkboxOptions.length > 0 ? field.kind : undefined;

  const builtInAliasPackEntry = resolveBuiltInFieldAliasPackEntry(field.fieldName, rulePackConfig);
  if (builtInAliasPackEntry) {
    aliases.push(...(builtInAliasPackEntry.aliases ?? []));
    semanticTriggers.push(...(builtInAliasPackEntry.semanticTriggers ?? []));
  }

  const optionPackEntry = resolveBuiltInFieldOptionPackEntry(field.fieldName, rulePackConfig);
  const checkboxOptions = optionPackEntry?.options ?? field.checkboxOptions;
  kind = optionPackEntry?.fieldKind ?? kind;
  normalizerKey = optionPackEntry?.normalizerKey ?? normalizerKey;
  if (
    !normalizerKey &&
    (field.features.includes("boolean_like_options") ||
      (optionPackEntry?.options ? isBooleanLikeOptionSet(optionPackEntry.options) : false))
  ) {
    normalizerKey = "yes_no";
  }
  if (
    aliases.length === 0 &&
    semanticTriggers.length === 0 &&
    !normalizerKey &&
    !kind &&
    (!checkboxOptions || checkboxOptions.length === 0)
  ) {
    return null;
  }

  return {
    aliases: uniqueNonEmpty([...field.aliases, ...aliases]),
    semanticTriggers: uniqueNonEmpty([...(field.semanticTriggers ?? []), ...semanticTriggers]),
    normalizerKey,
    checkboxOptions,
    kind
  };
}

export function buildGenericTemplateFieldRules(
  fields: TemplateGenericFieldRuleInput,
  rulePackConfig?: TemplateRulePackConfig
): Record<string, TemplateFieldRule> {
  const fieldDescriptors = resolveFieldDescriptors(fields);
  return fieldDescriptors.reduce<Record<string, TemplateFieldRule>>((rules, field) => {
    const rule = inferGenericRule(field, rulePackConfig);
    if (!rule) {
      return rules;
    }

    rules[field.fieldName] = rule;
    return rules;
  }, {});
}
