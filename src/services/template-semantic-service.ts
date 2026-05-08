import type {
  EnumOptionConfig,
  RenderTargetRef,
  StructuralMappingConfig,
  StructuralMappingFieldConfig,
  StructuralMappingValueType,
  TemplateFieldConfig,
} from "../types/template";
import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import {
  shouldCreateStructuralRuleForField,
  shouldCreateStructuralRuleForFieldDescriptor
} from "./template-structural-rule-service";
import { resolveConceptDisplayLabel } from "../utils/concept-label";
import type { TemplateSectionConfig } from "../types/template";
import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import {
  fieldStructureDescriptorToConfig,
  templateStructureDescriptorFieldsToConfigs
} from "./template-structure-descriptor-service";

type SemanticFieldInput = TemplateFieldContext | TemplateFieldConfig[] | TemplateStructureDescriptor;

function normalizeCompareValue(value: string): string {
  return value.replace(/[_\-\s]/g, "").replace(/[：:]/g, "").trim().toLocaleLowerCase();
}

function createConceptId(label: string, index: number): string {
  return `${normalizeCompareValue(label) || "concept"}-${index + 1}`;
}

function mergeUniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function mergeRenderTargets(targets: RenderTargetRef[]): RenderTargetRef[] {
  const targetMap = new Map<string, RenderTargetRef>();
  targets.forEach((target) => {
    const key = `${target.fieldName.trim()}::${target.kind}`;
    const existing = targetMap.get(key);
    if (!existing) {
      targetMap.set(key, { ...target });
      return;
    }

    targetMap.set(key, {
      ...existing,
      id: existing.id || target.id,
      required: existing.required || target.required
    });
  });
  return Array.from(targetMap.values());
}

function mergeEnumOptions(options: EnumOptionConfig[]): EnumOptionConfig[] {
  const optionMap = new Map<string, EnumOptionConfig>();
  options.forEach((option) => {
    const key = normalizeCompareValue(option.normalizedValue || option.label);
    const existing = optionMap.get(key);
    if (!existing) {
      optionMap.set(key, {
        ...option,
        aliases: mergeUniqueStrings(option.aliases)
      });
      return;
    }

    optionMap.set(key, {
      ...existing,
      label: existing.label || option.label,
      normalizedValue: existing.normalizedValue || option.normalizedValue,
      aliases: mergeUniqueStrings([...existing.aliases, ...option.aliases])
    });
  });
  return Array.from(optionMap.values());
}

function cloneEnumOption(option: EnumOptionConfig): EnumOptionConfig {
  return {
    ...option,
    aliases: [...option.aliases]
  };
}

function findMatchingExistingEnumOption(
  targetLabel: string,
  existingOptions: EnumOptionConfig[]
): EnumOptionConfig | null {
  const normalizedTarget = normalizeCompareValue(targetLabel);
  if (!normalizedTarget) {
    return null;
  }

  return (
    existingOptions.find((option) =>
      [option.label, option.normalizedValue]
        .map((value) => normalizeCompareValue(value))
        .includes(normalizedTarget)
    ) ?? null
  );
}

function resolveAuthoritativeEnumOptions(
  concept: StructuralMappingFieldConfig,
  renderTargets: RenderTargetRef[],
  fieldMap: Map<string, TemplateFieldConfig>
): EnumOptionConfig[] {
  const authoritativeLabels = mergeUniqueStrings(
    renderTargets.flatMap((target) => {
      const field = fieldMap.get(target.fieldName);
      if (!field || !field.checkboxOptions?.length) {
        return [];
      }

      return field.checkboxOptions;
    })
  );

  if (authoritativeLabels.length === 0) {
    return concept.enumOptions.map((option) => cloneEnumOption(option));
  }

  return authoritativeLabels.map((label) => {
    const existing = findMatchingExistingEnumOption(label, concept.enumOptions);
    return {
      label,
      normalizedValue: existing?.normalizedValue?.trim() || label,
      aliases: []
    };
  });
}

function mergeConceptValueType(
  left: StructuralMappingValueType,
  right: StructuralMappingValueType
): StructuralMappingValueType {
  if (left === right) {
    return left;
  }

  if (left === "enum" || right === "enum") {
    return "enum";
  }

  if (left === "date" || right === "date") {
    return "date";
  }

  return left !== "text" ? left : right;
}

function mergeConceptFields(
  left: StructuralMappingFieldConfig,
  right: StructuralMappingFieldConfig
): StructuralMappingFieldConfig {
  const mergedTargets = mergeRenderTargets([...left.renderTargets, ...right.renderTargets]);
  const merged = {
    ...left,
    aliases: mergeUniqueStrings([...left.aliases, ...right.aliases]),
    valueType: mergeConceptValueType(left.valueType, right.valueType),
    required: left.required || right.required,
    enumOptions: mergeEnumOptions([...left.enumOptions, ...right.enumOptions]),
    sourceHints: mergeUniqueStrings([...left.sourceHints, ...right.sourceHints]),
    renderTargets: mergedTargets
  };
  const displayLabel = left.label.trim() || right.label.trim() || resolveConceptDisplayLabel(merged);

  return {
    ...merged,
    label: displayLabel
  };
}

function dedupeConceptFields(conceptFields: StructuralMappingFieldConfig[]): StructuralMappingFieldConfig[] {
  const mergedConcepts: StructuralMappingFieldConfig[] = [];

  conceptFields.forEach((concept) => {
    const renderTargetNames = new Set(
      concept.renderTargets.map((target) => target.fieldName.trim()).filter(Boolean)
    );
    const duplicateIndex = mergedConcepts.findIndex((existing) =>
      existing.renderTargets.some((target) => renderTargetNames.has(target.fieldName.trim()))
    );

    if (duplicateIndex < 0) {
      mergedConcepts.push({
        ...concept,
        aliases: [...concept.aliases],
        enumOptions: concept.enumOptions.map((option) => ({ ...option, aliases: [...option.aliases] })),
        sourceHints: [...concept.sourceHints],
        renderTargets: concept.renderTargets.map((target) => ({ ...target }))
      });
      return;
    }

    mergedConcepts[duplicateIndex] = mergeConceptFields(mergedConcepts[duplicateIndex]!, concept);
  });

  return mergedConcepts.map((concept, index) => ({
    ...concept,
    id: concept.id || createConceptId(concept.label, index)
  }));
}

function parseValueType(field: TemplateFieldConfig): StructuralMappingValueType {
  if (field.normalizerKey === "date") {
    return "date";
  }

  if (field.kind === "checkbox_group" || field.kind === "inline_field") {
    return "enum";
  }

  return "text";
}

function buildEnumOptions(field: TemplateFieldConfig): EnumOptionConfig[] {
  if (!field.checkboxOptions || field.checkboxOptions.length === 0) {
    return [];
  }

  return field.checkboxOptions.map((option) => ({
    label: option,
    normalizedValue: option,
    aliases: []
  }));
}

function buildRenderTarget(field: TemplateFieldConfig): RenderTargetRef {
  return {
    id: field.name,
    fieldName: field.name,
    kind: field.kind ?? "text",
    required: true
  };
}

function isTemplateStructureDescriptor(value: SemanticFieldInput): value is TemplateStructureDescriptor {
  return !Array.isArray(value) && "version" in value && "fields" in value && "sections" in value;
}

function collectFieldAliasHints(
  fields: TemplateFieldContext | TemplateFieldConfig[],
  renderTargets: RenderTargetRef[]
): string[] {
  const currentFields = resolveTemplateFieldContextFields(fields);
  const fieldMap = new Map(currentFields.map((field) => [field.name, field] as const));
  return mergeUniqueStrings(
    renderTargets.flatMap((target) => fieldMap.get(target.fieldName)?.aliases ?? [])
  );
}

function hasExplicitConceptInputs(concept: StructuralMappingFieldConfig): boolean {
  return mergeUniqueStrings([
    ...concept.aliases,
    ...concept.sourceHints
  ]).length > 0;
}

function areAliasLinkedFields(left: TemplateFieldConfig | undefined, right: TemplateFieldConfig | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  const leftName = normalizeCompareValue(left.name);
  const rightName = normalizeCompareValue(right.name);
  if (!leftName || !rightName) {
    return false;
  }

  const leftAliases = new Set(left.aliases.map((alias) => normalizeCompareValue(alias)).filter(Boolean));
  const rightAliases = new Set(right.aliases.map((alias) => normalizeCompareValue(alias)).filter(Boolean));
  return leftAliases.has(rightName) || rightAliases.has(leftName);
}

function resolvePrimaryRenderTarget(
  concept: StructuralMappingFieldConfig,
  renderTargets: RenderTargetRef[],
  fieldMap: Map<string, TemplateFieldConfig>
): RenderTargetRef | null {
  const normalizedLabels = new Set(
    [concept.label, resolveConceptDisplayLabel(concept), ...concept.aliases]
      .map((value) => normalizeCompareValue(value))
      .filter(Boolean)
  );

  return (
    renderTargets.find((target) => normalizedLabels.has(normalizeCompareValue(target.fieldName))) ??
    renderTargets.find((target) => Boolean(fieldMap.get(target.fieldName))) ??
    renderTargets[0] ??
    null
  );
}

function sanitizeExistingSemanticConfig(
  fields: TemplateFieldContext | TemplateFieldConfig[],
  semanticConfig: StructuralMappingConfig,
  _sectionConfig?: TemplateSectionConfig[]
): StructuralMappingConfig {
  const currentFields = resolveTemplateFieldContextFields(fields);
  const validFieldNames = new Set(currentFields.map((field) => field.name));
  const fieldMap = new Map(currentFields.map((field) => [field.name, field] as const));

  return {
    version: semanticConfig.version || 1,
    lastConfirmedAt: semanticConfig.lastConfirmedAt,
    conceptFields: dedupeConceptFields(semanticConfig.conceptFields.map((concept, index) => {
      const validRenderTargets = concept.renderTargets.filter((target) => validFieldNames.has(target.fieldName));
      const primaryTarget = resolvePrimaryRenderTarget(concept, validRenderTargets, fieldMap);
      const renderTargets = primaryTarget
        ? validRenderTargets.filter((target) => {
            if (target.fieldName === primaryTarget.fieldName) {
              return true;
            }

            return !areAliasLinkedFields(
              fieldMap.get(primaryTarget.fieldName),
              fieldMap.get(target.fieldName)
            );
          })
        : validRenderTargets;
      const normalizedRenderTargets =
        primaryTarget && renderTargets.length > 1 && !hasExplicitConceptInputs(concept)
          ? [primaryTarget]
          : renderTargets;
      const sourceHints = collectFieldAliasHints(
        currentFields,
        primaryTarget ? [primaryTarget] : normalizedRenderTargets
      );
      const normalizedConcept = {
        ...concept,
        aliases: mergeUniqueStrings(concept.aliases),
        enumOptions: resolveAuthoritativeEnumOptions(concept, normalizedRenderTargets, fieldMap),
        sourceHints,
        renderTargets: normalizedRenderTargets
      };
      const displayLabel = concept.label.trim() || resolveConceptDisplayLabel(normalizedConcept);

      return {
        ...normalizedConcept,
        label: displayLabel,
        id: concept.id || createConceptId(displayLabel, index)
      };
    }))
  };
}

export function buildSemanticConfigFromFields(
  fields: SemanticFieldInput,
  existing?: StructuralMappingConfig,
  sectionConfig?: TemplateSectionConfig[]
): StructuralMappingConfig {
  const isDescriptorInput = isTemplateStructureDescriptor(fields);
  const currentFields = isDescriptorInput
    ? templateStructureDescriptorFieldsToConfigs(fields)
    : resolveTemplateFieldContextFields(fields);
  const base = existing
    ? sanitizeExistingSemanticConfig(currentFields, existing, sectionConfig)
    : {
        version: 1,
        conceptFields: [],
        lastConfirmedAt: undefined
      };

  const mappingFields = [...base.conceptFields];
  const representedFieldNames = new Set(
    mappingFields.flatMap((mappingField) => mappingField.renderTargets.map((target) => target.fieldName))
  );

  const structuralRuleFields = isDescriptorInput
    ? fields.fields.filter(shouldCreateStructuralRuleForFieldDescriptor).map(fieldStructureDescriptorToConfig)
    : currentFields.filter(shouldCreateStructuralRuleForField);

  structuralRuleFields.forEach((field) => {
    if (representedFieldNames.has(field.name)) {
      return;
    }

    const mappingLabel = field.aliases[0] || field.name;
    mappingFields.push({
      id: createConceptId(mappingLabel, mappingFields.length),
      label: mappingLabel,
      aliases: [],
      valueType: parseValueType(field),
      required: true,
      enumOptions: buildEnumOptions(field),
      sourceHints: mergeUniqueStrings(field.aliases),
      renderTargets: [buildRenderTarget(field)]
    });
    representedFieldNames.add(field.name);
  });

  return {
    version: Math.max(1, base.version || 1),
    lastConfirmedAt: base.lastConfirmedAt,
    conceptFields: dedupeConceptFields(mappingFields)
  };
}

export function buildStructuralMappingConfigFromFields(
  fields: SemanticFieldInput,
  existing?: StructuralMappingConfig,
  sectionConfig?: TemplateSectionConfig[]
): StructuralMappingConfig {
  return buildSemanticConfigFromFields(fields, existing, sectionConfig);
}

export function removeStructuralMappingFieldAliases(
  structuralMapping: StructuralMappingConfig | undefined,
  fieldName: string,
  aliasesToRemove: string[]
): StructuralMappingConfig | undefined {
  if (!structuralMapping || aliasesToRemove.length === 0) {
    return structuralMapping;
  }

  const removalSet = new Set(aliasesToRemove.map((alias) => alias.trim()).filter(Boolean));
  if (removalSet.size === 0) {
    return structuralMapping;
  }

  return {
    ...structuralMapping,
    conceptFields: structuralMapping.conceptFields.map((concept) => {
      const targetsField = concept.renderTargets.some((target) => target.fieldName === fieldName);
      if (!targetsField) {
        return concept;
      }

      return {
        ...concept,
        aliases: concept.aliases.filter((alias) => !removalSet.has(alias.trim()))
      };
    })
  };
}
