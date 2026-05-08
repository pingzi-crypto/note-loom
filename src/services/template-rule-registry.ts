import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import type { ScannedTemplateField, TemplateFieldConfig, TemplateRulePackConfig } from "../types/template";
import type { TemplateFieldRule } from "../types/rules";
import { buildGenericTemplateFieldRules } from "./template-generic-field-rule-service";

export type { TemplateFieldRule } from "../types/rules";

export function completeBuiltInTemplateScan(fields: ScannedTemplateField[]): ScannedTemplateField[] {
  return fields;
}

export function applyBuiltInTemplateRules(
  fields: TemplateFieldContext | TemplateFieldConfig[],
  rulePackConfig?: TemplateRulePackConfig
): TemplateFieldConfig[] {
  const currentFields = resolveTemplateFieldContextFields(fields);
  const genericRules = buildGenericTemplateFieldRules(currentFields, rulePackConfig);

  return currentFields.map((field) => {
    const rule = genericRules[field.name] satisfies TemplateFieldRule | undefined;
    const hasRule =
      (rule?.aliases?.length ?? 0) > 0 ||
      (rule?.semanticTriggers?.length ?? 0) > 0 ||
      Boolean(rule?.normalizerKey) ||
      (rule?.checkboxOptions?.length ?? 0) > 0 ||
      Boolean(rule?.kind);
    if (!hasRule || !rule) {
      return field;
    }

    return {
      ...field,
      aliases: Array.from(new Set([...(field.aliases ?? []), ...(rule.aliases ?? [])])),
      kind:
        field.kind === "text" && rule.kind === "checkbox_group"
          ? rule.kind
          : field.kind ?? rule.kind,
      normalizerKey: field.normalizerKey ?? rule.normalizerKey,
      semanticTriggers:
        field.semanticTriggers && field.semanticTriggers.length > 0
          ? Array.from(new Set([...field.semanticTriggers, ...(rule.semanticTriggers ?? [])]))
          : rule.semanticTriggers,
      checkboxOptions:
        field.checkboxOptions && field.checkboxOptions.length > 0
          ? Array.from(new Set(field.checkboxOptions))
          : rule.checkboxOptions ?? []
    };
  });
}
