import type { FieldMatchResult } from "../types/match";
import type {
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
import {
  shouldCreateStructuralRuleForField,
  shouldCreateStructuralRuleForFieldDescriptor
} from "./template-structural-rule-service";
import { templateStructureDescriptorFieldsToConfigs } from "./template-structure-descriptor-service";
import { resolveConceptDisplayLabel } from "../utils/concept-label";

export type StructuralMappingIntegrityStatus = "complete" | "partial" | "missing";
export type ConceptIntegrityStatus = StructuralMappingIntegrityStatus;

export interface RenderTargetIntegrity {
  fieldName: string;
  kind: RenderTargetRef["kind"];
  required: boolean;
  exists: boolean;
  enabled: boolean;
  matched: boolean;
  filled: boolean;
  value: string;
}

export interface StructuralMappingIntegrityResult {
  conceptId: string;
  label: string;
  required: boolean;
  valueType: StructuralMappingFieldConfig["valueType"];
  status: StructuralMappingIntegrityStatus;
  filledTargetCount: number;
  matchedTargetCount: number;
  targetCount: number;
  missingTargetNames: string[];
  targets: RenderTargetIntegrity[];
  previewValue: string;
}
export type ConceptIntegrityResult = StructuralMappingIntegrityResult;

export interface StructuralMappingIntegrityReport {
  hasSemanticLayer: boolean;
  hasBlockingIssues: boolean;
  conceptCount: number;
  completeCount: number;
  partialCount: number;
  missingCount: number;
  requiredBlockingCount: number;
  unmappedComplexFieldCount: number;
  unmappedComplexFields: string[];
  concepts: StructuralMappingIntegrityResult[];
}
export type TemplateIntegrityReport = StructuralMappingIntegrityReport;

type TemplateIntegrityFieldInput = TemplateFieldContext | TemplateFieldConfig[] | TemplateStructureDescriptor;

function isFilled(result: FieldMatchResult | undefined): boolean {
  return Boolean(result?.enabled && result.finalValue.trim().length > 0);
}

function isOverrideFilled(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function buildTargetIntegrity(
  target: RenderTargetRef,
  result: FieldMatchResult | undefined,
  existingFieldNames: Set<string>,
  valueOverrideMap: Map<string, string>
): RenderTargetIntegrity {
  const overrideValue = valueOverrideMap.get(target.fieldName)?.trim() ?? "";
  const resolvedValue = result?.finalValue?.trim().length ? result.finalValue : overrideValue;
  const filled = isFilled(result) || isOverrideFilled(overrideValue);
  return {
    fieldName: target.fieldName,
    kind: target.kind,
    required: target.required,
    exists: existingFieldNames.has(target.fieldName),
    enabled: result?.enabled ?? isOverrideFilled(overrideValue),
    matched: result?.matched ?? isOverrideFilled(overrideValue),
    filled,
    value: resolvedValue
  };
}

function summarizeMappingField(
  mappingField: StructuralMappingFieldConfig,
  fieldResultMap: Map<string, FieldMatchResult>,
  existingFieldNames: Set<string>,
  valueOverrideMap: Map<string, string>
): StructuralMappingIntegrityResult | null {
  const targets = mappingField.renderTargets
    .filter((target) => existingFieldNames.has(target.fieldName))
    .map((target) =>
    buildTargetIntegrity(target, fieldResultMap.get(target.fieldName), existingFieldNames, valueOverrideMap)
  );
  if (targets.length === 0) {
    return null;
  }
  const filledTargetCount = targets.filter((target) => target.filled).length;
  const matchedTargetCount = targets.filter((target) => target.matched).length;
  const requiredTargets = targets.filter((target) => target.required);
  const requiredTargetCount = requiredTargets.length;
  const allRequiredFilled =
    requiredTargetCount === 0 ? filledTargetCount === targets.length : requiredTargets.every((target) => target.filled);

  let status: StructuralMappingIntegrityStatus = "missing";
  if (allRequiredFilled && filledTargetCount > 0) {
    status = "complete";
  } else if (filledTargetCount > 0 || matchedTargetCount > 0) {
    status = "partial";
  }

  return {
    conceptId: mappingField.id,
    label: resolveConceptDisplayLabel(mappingField),
    required: mappingField.required,
    valueType: mappingField.valueType,
    status,
    filledTargetCount,
    matchedTargetCount,
    targetCount: targets.length,
    missingTargetNames: targets.filter((target) => target.required && !target.filled).map((target) => target.fieldName),
    previewValue:
      targets.find((target) => target.filled)?.value ??
      targets.find((target) => target.matched)?.value ??
      "",
    targets
  };
}

function isTemplateStructureDescriptor(value: TemplateIntegrityFieldInput): value is TemplateStructureDescriptor {
  return !Array.isArray(value) && "version" in value && "fields" in value && "sections" in value;
}

export class TemplateIntegrityService {
  buildReport(
    structuralMapping: StructuralMappingConfig | undefined,
    currentFields: TemplateIntegrityFieldInput,
    fieldResults: FieldMatchResult[],
    fieldValueOverrides: Map<string, string> = new Map()
  ): StructuralMappingIntegrityReport {
    const currentFieldList = isTemplateStructureDescriptor(currentFields)
      ? templateStructureDescriptorFieldsToConfigs(currentFields)
      : resolveTemplateFieldContextFields(currentFields);
    const activeFieldNames =
      !isTemplateStructureDescriptor(currentFields) && "snapshot" in currentFields
        ? new Set(currentFields.snapshot.reviewVisibleFieldNames)
        : new Set(
            currentFieldList
              .filter((field) => field.enabledByDefault)
              .map((field) => field.name.trim())
              .filter(Boolean)
          );
    const activeFieldList = currentFieldList.filter((field) => activeFieldNames.has(field.name.trim()));
    const fieldResultMap = new Map(fieldResults.map((result) => [result.fieldName, result] as const));
    const existingFieldNames = new Set(activeFieldList.map((field) => field.name));
    const concepts = (structuralMapping?.conceptFields ?? [])
      .map((mappingField) =>
        summarizeMappingField(mappingField, fieldResultMap, existingFieldNames, fieldValueOverrides)
      )
      .filter((concept): concept is StructuralMappingIntegrityResult => Boolean(concept));
    const mappedFieldNames = new Set(
      (structuralMapping?.conceptFields ?? []).flatMap((mappingField) =>
        mappingField.renderTargets.map((target) => target.fieldName)
      )
    );
    const unmappedComplexFields = isTemplateStructureDescriptor(currentFields)
      ? currentFields.fields
          .filter((field) => field.enabledByDefault)
          .filter((field) => shouldCreateStructuralRuleForFieldDescriptor(field) && !mappedFieldNames.has(field.fieldName))
          .map((field) => field.fieldName)
      : activeFieldList
          .filter((field) => shouldCreateStructuralRuleForField(field) && !mappedFieldNames.has(field.name))
          .map((field) => field.name);
    const completeCount = concepts.filter((concept) => concept.status === "complete").length;
    const partialCount = concepts.filter((concept) => concept.status === "partial").length;
    const missingCount = concepts.filter((concept) => concept.status === "missing").length;
    const requiredBlockingCount = concepts.filter(
      (concept) => concept.required && concept.status !== "complete"
    ).length;

    return {
      hasSemanticLayer: concepts.length > 0 || unmappedComplexFields.length > 0,
      hasBlockingIssues: requiredBlockingCount > 0 || unmappedComplexFields.length > 0,
      conceptCount: concepts.length,
      completeCount,
      partialCount,
      missingCount,
      requiredBlockingCount,
      unmappedComplexFieldCount: unmappedComplexFields.length,
      unmappedComplexFields,
      concepts
    };
  }
}
