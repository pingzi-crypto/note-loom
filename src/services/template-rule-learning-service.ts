import { buildSemanticConfigFromFields } from "./template-semantic-service";
import {
  resolveTemplateFieldContextFields,
  resolveTemplateFieldsFromScan,
  setTemplateFieldEnabled,
  type TemplateFieldContext
} from "./template-field-state-service";
import type { FieldMatchResult } from "../types/match";
import type { EnumOptionConfig, TemplateConfig, TemplateFieldConfig } from "../types/template";

function normalizeCompareValue(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·]/g, "");
}

function cloneTemplate(template: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(template)) as TemplateConfig;
}

function cloneField(field: TemplateFieldConfig): TemplateFieldConfig {
  return {
    ...field,
    aliases: [...field.aliases],
    semanticTriggers: field.semanticTriggers ? [...field.semanticTriggers] : [],
    checkboxOptions: field.checkboxOptions ? [...field.checkboxOptions] : []
  };
}

function isSameAliasCandidate(candidate: string, option: EnumOptionConfig): boolean {
  const normalized = normalizeCompareValue(candidate);
  if (!normalized) {
    return true;
  }

  return [option.label, option.normalizedValue, ...option.aliases]
    .map((value) => normalizeCompareValue(value))
    .includes(normalized);
}

function findMatchingEnumOption(
  finalValue: string,
  options: EnumOptionConfig[]
): EnumOptionConfig | null {
  const normalizedFinalValue = normalizeCompareValue(finalValue);
  if (!normalizedFinalValue) {
    return null;
  }

  return (
    options.find((option) =>
      [option.label, option.normalizedValue, ...option.aliases]
        .map((value) => normalizeCompareValue(value))
        .includes(normalizedFinalValue)
    ) ?? null
  );
}

export interface RuleLearningPreview {
  learnableFixCount: number;
  details: RuleLearningDetail[];
}

export type RuleLearningDetailKind = "enum_alias" | "field_default";

export interface RuleLearningDetail {
  kind: RuleLearningDetailKind;
  title: string;
  summary: string;
}

export interface RuleLearningResult {
  changed: boolean;
  learnedEnumAliasCount: number;
  learnedFieldDefaultCount: number;
  learnedFixCount: number;
  details: RuleLearningDetail[];
  template: TemplateConfig;
}

interface LearnableEnumAliasFix {
  conceptId: string;
  optionNormalizedValue: string;
  candidateAlias: string;
  result: FieldMatchResult;
}

export class TemplateRuleLearningService {
  preview(
    template: TemplateConfig,
    currentFields: TemplateFieldContext | TemplateFieldConfig[],
    fieldResults: FieldMatchResult[]
  ): RuleLearningPreview {
    const currentFieldList = resolveTemplateFieldContextFields(currentFields);
    const enumFixes = this.collectLearnableEnumAliasFixes(template, currentFieldList, fieldResults);
    const fieldDefaultFixes = this.collectLearnableFieldDefaultFixes(currentFieldList, fieldResults);
    return {
      learnableFixCount: enumFixes.length + fieldDefaultFixes.length,
      details: [
        ...enumFixes.map((fix) => ({
          kind: "enum_alias" as const,
          title: fix.result.fieldName,
          summary: `${fix.candidateAlias.trim()} -> ${fix.optionNormalizedValue}`
        })),
        ...fieldDefaultFixes.map((fix) => ({
          kind: "field_default" as const,
          title: fix.fieldName,
          summary: fix.enabled ? "enabled by default" : "disabled by default"
        }))
      ]
    };
  }

  apply(
    template: TemplateConfig,
    currentFields: TemplateFieldContext | TemplateFieldConfig[],
    fieldResults: FieldMatchResult[]
  ): RuleLearningResult {
    const currentFieldList = resolveTemplateFieldContextFields(currentFields);
    const nextTemplate = cloneTemplate(template);
    const existingFieldNames = new Set(nextTemplate.fields.map((field) => field.name));
    nextTemplate.fields = resolveTemplateFieldsFromScan(
      currentFieldList.map((field, order) => ({
        name: field.name,
        order,
        kind: field.kind,
        checkboxOptions: field.checkboxOptions
      })),
      [
        ...nextTemplate.fields.map(cloneField),
        ...currentFieldList
          .filter((field) => !existingFieldNames.has(field.name))
          .map(cloneField)
      ],
      nextTemplate.sectionConfig,
      nextTemplate.semanticConfig,
      nextTemplate.rulePackConfig
    );
    nextTemplate.semanticConfig = buildSemanticConfigFromFields(
      currentFieldList,
      nextTemplate.semanticConfig,
      nextTemplate.sectionConfig
    );

    const fieldDefaultFixes = this.collectLearnableFieldDefaultFixes(currentFieldList, fieldResults);

    let learnedEnumAliasCount = 0;

    let learnedFieldDefaultCount = 0;
    fieldDefaultFixes.forEach(({ fieldName, enabled }) => {
      const field = nextTemplate.fields.find((item) => item.name === fieldName);
      if (!field || field.enabledByDefault === enabled) {
        return;
      }

      nextTemplate.fields = setTemplateFieldEnabled(
        nextTemplate.fields,
        fieldName,
        enabled,
        nextTemplate.sectionConfig
      );
      learnedFieldDefaultCount += 1;
    });

    return {
      changed: learnedEnumAliasCount > 0 || learnedFieldDefaultCount > 0,
      learnedEnumAliasCount,
      learnedFieldDefaultCount,
      learnedFixCount: learnedEnumAliasCount + learnedFieldDefaultCount,
      details: [
        ...fieldDefaultFixes
          .filter(({ fieldName, enabled }) => {
            const field = nextTemplate.fields.find((item) => item.name === fieldName);
            return field ? field.enabledByDefault === enabled : false;
          })
          .map((fix) => ({
            kind: "field_default" as const,
            title: fix.fieldName,
            summary: fix.enabled ? "enabled by default" : "disabled by default"
          }))
      ],
      template: nextTemplate
    };
  }

  private collectLearnableEnumAliasFixes(
    template: TemplateConfig,
    currentFields: TemplateFieldConfig[],
    fieldResults: FieldMatchResult[]
  ): LearnableEnumAliasFix[] {
    const semanticConfig = buildSemanticConfigFromFields(
      currentFields,
      template.semanticConfig,
      template.sectionConfig
    );
    const fixes: LearnableEnumAliasFix[] = [];

    fieldResults.forEach((result) => {
      const candidateAlias = result.candidateValue.trim();
      const finalValue = result.finalValue.trim();
      if (!result.edited || !candidateAlias || !finalValue) {
        return;
      }

      const concept = semanticConfig.conceptFields.find(
        (item) =>
          item.valueType === "enum" &&
          item.renderTargets.some((target) => target.fieldName === result.fieldName)
      );
      if (!concept || concept.enumOptions.length === 0) {
        return;
      }

      const option = findMatchingEnumOption(finalValue, concept.enumOptions);
      if (!option) {
        return;
      }

      fixes.push({
        conceptId: concept.id,
        optionNormalizedValue: option.normalizedValue,
        candidateAlias,
        result
      });
    });

    return fixes;
  }

  private collectLearnableFieldDefaultFixes(
    currentFields: TemplateFieldConfig[],
    fieldResults: FieldMatchResult[]
  ): Array<{ fieldName: string; enabled: boolean }> {
    const fieldMap = new Map(currentFields.map((field) => [field.name, field] as const));

    return fieldResults
      .filter((result) => {
        const field = fieldMap.get(result.fieldName);
        return Boolean(field && field.enabledByDefault !== result.enabled);
      })
      .map((result) => ({
        fieldName: result.fieldName,
        enabled: result.enabled
      }));
  }
}
