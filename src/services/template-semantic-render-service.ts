import { FieldNormalizer } from "./field-normalizer";
import type { FieldMatchResult } from "../types/match";
import type {
  EnumOptionConfig,
  RenderTargetRef,
  StructuralMappingConfig,
  StructuralMappingFieldConfig,
  TemplateFieldConfig,
} from "../types/template";
import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import { collectBestSourceLabelMatch } from "./field-matcher";
import { templateStructureDescriptorFieldsToConfigs } from "./template-structure-descriptor-service";

type TemplateSemanticRenderFieldInput = TemplateFieldContext | TemplateFieldConfig[] | TemplateStructureDescriptor;

interface ConceptValueResolution {
  sourceFieldName: string | null;
  rawValue: string;
  displayValue: string;
  normalizedValue: string;
}

function normalizeCompareValue(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·]/g, "");
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

function buildRank(result: FieldMatchResult): number {
  if (result.edited && result.finalValue.trim()) {
    return 4;
  }

  if (result.finalValue.trim()) {
    return 3;
  }

  if (result.matched) {
    return 2;
  }

  if (result.enabled) {
    return 1;
  }

  return 0;
}

function hasExplicitSemanticInputs(
  mappingField: StructuralMappingFieldConfig,
  field: TemplateFieldConfig | undefined
): boolean {
  return Boolean(
    field?.aliases.some((alias) => alias.trim().length > 0) ||
      field?.semanticTriggers?.some((trigger) => trigger.trim().length > 0) ||
      mappingField.aliases.some((alias) => alias.trim().length > 0) ||
      mappingField.sourceHints.some((hint) => hint.trim().length > 0)
  );
}

function isTemplateStructureDescriptor(value: TemplateSemanticRenderFieldInput): value is TemplateStructureDescriptor {
  return !Array.isArray(value) && "version" in value && "fields" in value && "sections" in value;
}

function uniqueLabels(field: TemplateFieldConfig | undefined): string[] {
  if (!field) {
    return [];
  }

  return [field.name, ...field.aliases]
    .map((value) => value.trim())
    .filter(Boolean);
}

function isMeaningfulCompanionLabel(label: string): boolean {
  return normalizeCompareValue(label).length >= 2;
}

function areCompanionFields(
  sourceField: TemplateFieldConfig | undefined,
  targetField: TemplateFieldConfig | undefined
): boolean {
  if (!sourceField || !targetField || sourceField.name === targetField.name) {
    return false;
  }

  const sourceLabels = uniqueLabels(sourceField);
  const targetLabels = uniqueLabels(targetField);
  const normalizedSourceLabels = sourceLabels.map((label) => normalizeCompareValue(label)).filter(Boolean);
  const normalizedTargetLabels = targetLabels.map((label) => normalizeCompareValue(label)).filter(Boolean);

  return normalizedSourceLabels.some((sourceLabel) =>
    normalizedTargetLabels.some((targetLabel) => {
      if (!sourceLabel || !targetLabel) {
        return false;
      }

      if (sourceLabel === targetLabel) {
        return true;
      }

      if (!isMeaningfulCompanionLabel(sourceLabel) || !isMeaningfulCompanionLabel(targetLabel)) {
        return false;
      }

      return sourceLabel.includes(targetLabel) || targetLabel.includes(sourceLabel);
    })
  );
}

function hasUsableValue(result: FieldMatchResult | undefined): result is FieldMatchResult {
  return Boolean(result?.enabled && result.finalValue.trim().length > 0);
}

export class TemplateSemanticRenderService {
  private readonly fieldNormalizer = new FieldNormalizer();

  apply(
    structuralMapping: StructuralMappingConfig | undefined,
    currentFields: TemplateSemanticRenderFieldInput,
    fieldResults: FieldMatchResult[],
    sourceText = ""
  ): FieldMatchResult[] {
    const currentFieldList = isTemplateStructureDescriptor(currentFields)
      ? templateStructureDescriptorFieldsToConfigs(currentFields)
      : resolveTemplateFieldContextFields(currentFields);
    const resolvedResults = fieldResults.map(cloneResult);
    const resultMap = new Map(resolvedResults.map((result) => [result.fieldName, result] as const));
    const fieldMap = new Map(currentFieldList.map((field) => [field.name, field] as const));
    if (!structuralMapping || structuralMapping.conceptFields.length === 0) {
      this.applyCompanionFieldValues(resolvedResults, fieldMap);
      return resolvedResults;
    }

    const allLabels = Array.from(
      new Set(
        currentFieldList.flatMap((field) =>
          [field.name, ...field.aliases]
            .map((value) => value.trim())
            .filter(Boolean)
        )
      )
    ).sort((left, right) => right.length - left.length);

    structuralMapping.conceptFields.forEach((mappingField) => {
      const value = this.resolveConceptValue(mappingField, resultMap, fieldMap, sourceText, allLabels);
      if (!value) {
        return;
      }

      mappingField.renderTargets.forEach((target) => {
        const targetResult = resultMap.get(target.fieldName);
        if (!targetResult) {
          return;
        }

        if (!targetResult.enabled) {
          return;
        }

        if (targetResult.edited && target.fieldName !== value.sourceFieldName) {
          return;
        }

        const targetField = fieldMap.get(target.fieldName);
        if (
          !targetResult.matched &&
          targetResult.finalValue.trim().length === 0 &&
          target.fieldName !== value.sourceFieldName &&
          !hasExplicitSemanticInputs(mappingField, targetField)
        ) {
          return;
        }

        const nextValue = this.renderValueForTarget(mappingField, target, fieldMap, value);
        if (!nextValue) {
          return;
        }

        targetResult.matched = true;
        targetResult.candidateValue = nextValue;
        targetResult.finalValue = nextValue;
        targetResult.matchedLabel ??= value.sourceFieldName ?? undefined;
      });
    });

    this.applyCompanionFieldValues(resolvedResults, fieldMap);

    return resolvedResults;
  }

  private applyCompanionFieldValues(
    results: FieldMatchResult[],
    fieldMap: Map<string, TemplateFieldConfig>
  ): void {
    const resultMap = new Map(results.map((result) => [result.fieldName, result] as const));

    results.forEach((targetResult) => {
      const targetField = fieldMap.get(targetResult.fieldName);
      if (!targetField || !targetResult.enabled || targetResult.edited) {
        return;
      }

      const currentValue = targetResult.finalValue.trim();
      if (currentValue && this.isValidValueForField(targetField, currentValue)) {
        return;
      }

      const sourceResult = results
        .filter((candidate) => candidate.fieldName !== targetResult.fieldName)
        .filter(hasUsableValue)
        .map((candidate) => ({
          result: candidate,
          field: fieldMap.get(candidate.fieldName)
        }))
        .filter((candidate): candidate is { result: FieldMatchResult; field: TemplateFieldConfig } =>
          Boolean(candidate.field && areCompanionFields(candidate.field, targetField))
        )
        .sort((left, right) => this.buildCompanionRank(right.field, targetField) - this.buildCompanionRank(left.field, targetField))[0];

      if (!sourceResult) {
        return;
      }

      const nextValue = this.renderCompanionValue(sourceResult.field, targetField, sourceResult.result.finalValue);
      if (!nextValue) {
        return;
      }

      targetResult.matched = true;
      targetResult.candidateValue = nextValue;
      targetResult.finalValue = nextValue;
      targetResult.matchedLabel ??= sourceResult.result.fieldName;
      resultMap.set(targetResult.fieldName, targetResult);
    });
  }

  private buildCompanionRank(sourceField: TemplateFieldConfig, targetField: TemplateFieldConfig): number {
    let rank = 0;
    const normalizedTargetName = normalizeCompareValue(targetField.name);
    const normalizedSourceName = normalizeCompareValue(sourceField.name);
    const sourceAliases = sourceField.aliases.map((alias) => normalizeCompareValue(alias));
    const targetAliases = targetField.aliases.map((alias) => normalizeCompareValue(alias));

    if (sourceAliases.includes(normalizedTargetName) || targetAliases.includes(normalizedSourceName)) {
      rank += 4;
    }

    if (sourceField.kind === "checkbox_group" || targetField.kind === "checkbox_group") {
      rank += 2;
    }

    return rank;
  }

  private isValidValueForField(field: TemplateFieldConfig, value: string): boolean {
    if (!value.trim()) {
      return false;
    }

    if (field.checkboxOptions?.length) {
      return Boolean(this.resolveOptionValue(field, value));
    }

    return true;
  }

  private renderCompanionValue(
    sourceField: TemplateFieldConfig,
    targetField: TemplateFieldConfig,
    rawValue: string
  ): string {
    if (targetField.checkboxOptions?.length) {
      const optionValue = this.resolveOptionValue(targetField, rawValue);
      if (optionValue) {
        return targetField.normalizerKey
          ? this.fieldNormalizer.normalize(targetField, optionValue)
          : optionValue;
      }

      if (targetField.normalizerKey) {
        const normalizedValue = this.fieldNormalizer.normalize(targetField, rawValue);
        return this.resolveOptionValue(targetField, normalizedValue) ? normalizedValue : "";
      }

      return "";
    }

    if (!targetField.normalizerKey) {
      return rawValue.trim();
    }

    return this.fieldNormalizer.normalize(targetField, rawValue);
  }

  private resolveOptionValue(field: TemplateFieldConfig, rawValue: string): string | null {
    const options = field.checkboxOptions ?? [];
    const normalizedRawValue = normalizeCompareValue(rawValue);
    if (!normalizedRawValue || options.length === 0) {
      return null;
    }

    return (
      options.find((option) => normalizeCompareValue(option) === normalizedRawValue) ??
      options.find((option) => {
        const normalizedOption = normalizeCompareValue(option);
        return normalizedOption && normalizedRawValue.includes(normalizedOption);
      }) ??
      null
    );
  }

  private resolveConceptValue(
    mappingField: StructuralMappingFieldConfig,
    resultMap: Map<string, FieldMatchResult>,
    fieldMap: Map<string, TemplateFieldConfig>,
    sourceText: string,
    allLabels: string[]
  ): ConceptValueResolution | null {
    const explicitInputValue = this.resolveConceptInputValue(
      mappingField,
      fieldMap,
      sourceText,
      allLabels
    );
    if (explicitInputValue) {
      return explicitInputValue;
    }

    const candidates = mappingField.renderTargets
      .map((target) => ({
        target,
        result: resultMap.get(target.fieldName)
      }))
      .filter(
        (item): item is { target: RenderTargetRef; result: FieldMatchResult } =>
          Boolean(item.result && buildRank(item.result) > 0)
      )
      .sort((left, right) => buildRank(right.result) - buildRank(left.result));

    for (const candidate of candidates) {
      const rawValue = candidate.result.finalValue.trim();
      if (!rawValue) {
        continue;
      }

      if (mappingField.valueType === "enum") {
        const enumOption = this.resolveEnumOption(mappingField, rawValue, fieldMap);
        if (enumOption) {
          return {
            sourceFieldName: candidate.target.fieldName,
            rawValue,
            displayValue: enumOption.label,
            normalizedValue: enumOption.normalizedValue
          };
        }

        continue;
      }

      return {
        sourceFieldName: candidate.target.fieldName,
        rawValue,
        displayValue: rawValue,
        normalizedValue: rawValue
      };
    }

    return null;
  }

  private resolveConceptInputValue(
    mappingField: StructuralMappingFieldConfig,
    fieldMap: Map<string, TemplateFieldConfig>,
    sourceText: string,
    allLabels: string[]
  ): ConceptValueResolution | null {
    if (!sourceText.trim()) {
      return null;
    }

    const inputLabels = Array.from(
      new Set(
        [...mappingField.aliases, ...mappingField.sourceHints]
          .map((value) => value.trim())
          .filter(Boolean)
      )
    );
    if (inputLabels.length === 0) {
      return null;
    }

    const bestMatch = collectBestSourceLabelMatch(sourceText, inputLabels, allLabels);
    if (!bestMatch) {
      return null;
    }

    const rawValue = bestMatch.value.trim();
    if (!rawValue) {
      return null;
    }

    if (mappingField.valueType === "enum") {
      const enumOption = this.resolveEnumOption(mappingField, rawValue, fieldMap);
      if (enumOption) {
        return {
          sourceFieldName: bestMatch.label,
          rawValue,
          displayValue: enumOption.label,
          normalizedValue: enumOption.normalizedValue
        };
      }
    }

    return {
      sourceFieldName: bestMatch.label,
      rawValue,
      displayValue: rawValue,
      normalizedValue: rawValue
    };
  }

  private resolveEnumOption(
    mappingField: StructuralMappingFieldConfig,
    rawValue: string,
    fieldMap: Map<string, TemplateFieldConfig>
  ): EnumOptionConfig | null {
    const normalizedRawValue = normalizeCompareValue(rawValue);
    const optionKeys = (option: EnumOptionConfig): string[] =>
      [option.label, option.normalizedValue, ...option.aliases]
        .map((value) => normalizeCompareValue(value))
        .filter(Boolean);
    const directMatch =
      mappingField.enumOptions.find((option) => optionKeys(option).includes(normalizedRawValue)) ?? null;
    if (directMatch) {
      return directMatch;
    }

    const containedMatch =
      mappingField.enumOptions.find((option) =>
        optionKeys(option).some((key) => key.length > 0 && normalizedRawValue.includes(key))
      ) ?? null;
    if (containedMatch) {
      return containedMatch;
    }

    for (const option of mappingField.enumOptions) {
      for (const target of mappingField.renderTargets) {
        const field = fieldMap.get(target.fieldName);
        if (!field?.normalizerKey) {
          continue;
        }

        const normalizedLabel = normalizeCompareValue(this.fieldNormalizer.normalize(field, option.label));
        if (normalizedLabel && normalizedLabel === normalizedRawValue) {
          return option;
        }
      }
    }

    return null;
  }

  private renderValueForTarget(
    mappingField: StructuralMappingFieldConfig,
    target: RenderTargetRef,
    fieldMap: Map<string, TemplateFieldConfig>,
    value: ConceptValueResolution
  ): string {
    const field = fieldMap.get(target.fieldName);

    if (mappingField.valueType === "enum") {
      const baseValue = target.kind === "checkbox_group" || target.kind === "text"
        ? value.displayValue
        : value.normalizedValue || value.displayValue;

      if (!field?.normalizerKey) {
        return baseValue;
      }

      return this.fieldNormalizer.normalize(field, baseValue);
    }

    if (!field?.normalizerKey) {
      return value.rawValue;
    }

    return this.fieldNormalizer.normalize(field, value.rawValue);
  }
}

export class TemplateStructuralMappingRenderService extends TemplateSemanticRenderService {}
