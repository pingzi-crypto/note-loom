import type { FieldMatchResult, MatchReason } from "../types/match";
import type {
  ScannedTemplateField,
  StructuralMappingConfig,
  TemplateFieldConfig,
  TemplateSectionBehaviorGroupConfig,
  TemplateRulePackConfig,
  TemplateSectionConfig
} from "../types/template";
import type { RunFieldDecision } from "./template-run-diff-service";
import type { RunDecisionSummary, RunFieldDecisionKind } from "./template-run-diff-service";
import { applyBuiltInTemplateRules } from "./template-rule-registry";
import { getRuntimeSectionRawContent, TemplateSectionConfigService } from "./template-section-config-service";
import { applyLinkedFieldConfig } from "./template-field-link-service";
import type { TemplateSectionDraftExtraction, TemplateSectionDraftTrace } from "./template-section-draft-service";
import { TemplateSectionDraftService } from "./template-section-draft-service";
import type {
  FieldStructureDescriptor,
  SectionStructureDescriptor,
  TemplateStructureDescriptor
} from "../types/template-structure-descriptor";
import { fieldStructureDescriptorToConfig } from "./template-structure-descriptor-service";

export interface TemplateFieldBinding {
  sectionId: string;
  sectionTitle: string;
  sectionMode: TemplateSectionConfig["mode"];
  sectionKind: TemplateSectionConfig["kind"];
  bindingKind:
    | "section_field"
    | "section_reference"
    | "repeatable_entry"
    | "group_presence"
    | "mixed_item_target"
    | "mixed_inline_field";
  label: string;
}

export interface TemplateFieldStateRecord extends TemplateFieldConfig {
  bindings: TemplateFieldBinding[];
  sectionManaged: boolean;
  repeatableEntryField: boolean;
  matcherEligible: boolean;
  reviewVisible: boolean;
}

export interface TemplateFieldStateSnapshot {
  fields: TemplateFieldStateRecord[];
  fieldMap: Map<string, TemplateFieldStateRecord>;
  matcherFields: TemplateFieldConfig[];
  matcherFieldNames: Set<string>;
  reviewVisibleFieldNames: Set<string>;
  knownFieldNames: Set<string>;
  repeatableFieldNames: Set<string>;
  structuralBoundaryLabels: Set<string>;
}

export interface TemplateFieldContext {
  fields: TemplateFieldConfig[];
  snapshot: TemplateFieldStateSnapshot;
}

export interface TemplateFieldAutoState {
  matched: boolean;
  matchReason: MatchReason;
  matchedLabel?: string;
}

export type TemplateFieldReviewStatus = "matched" | "needs_review" | "unmatched" | "edited";
export type TemplateFieldViewMode = "review" | "all";
export type TemplateFieldRowLayout = "primary" | "actions" | "toggle-primary" | "full";

export interface SectionPendingFieldBinding {
  id: string;
  sectionId: string;
  sectionTitle: string;
  fieldKey: string;
  label: string;
  inputKind?: "text" | "textarea";
}

export interface SectionPendingFieldItem {
  kind: "section_field";
  binding: SectionPendingFieldBinding;
  value: string;
  reviewStatus: TemplateFieldReviewStatus;
}

export interface MatchedFieldReviewItem {
  kind: "matched_field";
  rawResult: FieldMatchResult;
  resolvedResult: FieldMatchResult;
  runDecision: RunFieldDecision;
  reviewStatus: TemplateFieldReviewStatus;
}

export type TemplateReviewItem = MatchedFieldReviewItem | SectionPendingFieldItem;

export type TemplateRunFieldStateSource = "matched_field" | "section_draft";

export interface TemplateRunFieldStateRecord {
  id: string;
  fieldName: string;
  source: TemplateRunFieldStateSource;
  finalValue: string;
  reviewStatus: TemplateFieldReviewStatus;
  reviewItem: TemplateReviewItem;
  renderOwner: boolean;
}

export interface TemplateRunFieldStateSnapshot {
  records: TemplateRunFieldStateRecord[];
  allItems: TemplateReviewItem[];
  pendingItems: TemplateReviewItem[];
}

export interface TemplateRunFieldStateStats {
  runFieldCount: number;
  pendingFieldCount: number;
  matchedFieldCount: number;
  sectionDraftFieldCount: number;
}

export interface TemplateRunResolvedValueMapParams {
  snapshot: TemplateRunFieldStateSnapshot;
  enabledFieldNames: Set<string>;
  sectionConfig?: TemplateSectionConfig[];
  fieldBlockSectionDrafts?: Map<string, Record<string, string>>;
  groupedFieldBlockSectionDrafts?: Map<string, Record<string, Record<string, string>>>;
  tableBlockSectionDrafts?: Map<string, Array<Record<string, string>>>;
  mixedFieldBlockSectionDrafts?: Map<string, Record<string, string>>;
}

export interface FieldReviewGroup {
  title: string;
  items: TemplateReviewItem[];
}

export interface PendingFieldReviewViewModel {
  allItems: TemplateReviewItem[];
  pendingItems: TemplateReviewItem[];
  visibleItems: TemplateReviewItem[];
  hasPendingFields: boolean;
  fieldGroups: FieldReviewGroup[];
}

export interface MatchedFieldRowState {
  pendingReviewMode: boolean;
  showToggle: boolean;
  showSecondaryAction: boolean;
  layout: TemplateFieldRowLayout;
  secondaryActionKey: "reset";
}

export interface SectionPendingFieldRowState {
  canReset: boolean;
  layout: TemplateFieldRowLayout;
}

export interface TemplateFieldTraceState {
  text: string;
  visible: boolean;
}

export interface TemplateSectionDraftCollections {
  currentSectionDraftExtraction: TemplateSectionDraftExtraction | null;
  fieldBlockSectionDrafts: Map<string, Record<string, string>>;
  groupedFieldBlockSectionDrafts: Map<string, Record<string, Record<string, string>>>;
  mixedFieldBlockSectionDrafts: Map<string, Record<string, string>>;
  currentTemplateContent: string;
}

interface FinalizeTemplateFieldOptions {
  mergeAliases?: boolean;
  mergeSemanticTriggers?: boolean;
  syncEnabledState?: boolean;
}

const EDITABLE_FIELD_FINALIZE_OPTIONS: FinalizeTemplateFieldOptions = {
  mergeAliases: false,
  mergeSemanticTriggers: false,
  syncEnabledState: false
};

const RUNTIME_FIELD_FINALIZE_OPTIONS: FinalizeTemplateFieldOptions = {
  mergeAliases: false,
  mergeSemanticTriggers: false,
  syncEnabledState: false
};

function cloneField(field: TemplateFieldConfig): TemplateFieldConfig {
  return {
    ...field,
    aliases: [...field.aliases],
    semanticTriggers: field.semanticTriggers ? [...field.semanticTriggers] : [],
    checkboxOptions: field.checkboxOptions ? [...field.checkboxOptions] : [],
    ...(field.frontmatterTargets ? { frontmatterTargets: [...field.frontmatterTargets] } : {})
  };
}

export function resetFieldRecognitionConfig(fields: TemplateFieldConfig[]): TemplateFieldConfig[] {
  return fields.map((field) => {
    const clonedField = cloneField(field);
    delete clonedField.normalizerKey;
    return {
      ...clonedField,
      aliases: [],
      semanticTriggers: []
    };
  });
}

function isDerivedBehaviorFieldId(field: { id?: string; label?: string }): boolean {
  const id = field.id?.trim() ?? "";
  const label = field.label?.trim() ?? "";
  if (!id || !label) {
    return false;
  }

  return id === label
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function isTemplateStructureDescriptorInput(
  value: TemplateFieldConfig[] | TemplateStructureDescriptor
): value is TemplateStructureDescriptor {
  return !Array.isArray(value);
}

function buildDescriptorFieldBindingMap(
  sections: SectionStructureDescriptor[] | undefined
): Map<string, TemplateFieldBinding[]> {
  const bindingMap = new Map<string, TemplateFieldBinding[]>();
  const pushBinding = (fieldName: string, binding: TemplateFieldBinding): void => {
    const normalizedFieldName = fieldName.trim();
    if (!normalizedFieldName) {
      return;
    }

    const bindings = bindingMap.get(normalizedFieldName) ?? [];
    bindings.push(binding);
    bindingMap.set(normalizedFieldName, bindings);
  };

  (sections ?? []).forEach((section) => {
    Array.from(new Set([...section.fieldNames, ...section.behaviorFieldNames].map((fieldName) => fieldName.trim())))
      .filter((fieldName) => fieldName.length > 0)
      .forEach((fieldName) => {
      pushBinding(fieldName, {
        sectionId: section.id,
        sectionTitle: section.title,
        sectionMode: section.mode,
        sectionKind: section.kind,
        bindingKind: section.kind === "repeatable_entries" ? "repeatable_entry" : "section_reference",
        label: fieldName
      });
      });
  });

  return bindingMap;
}

function buildFieldBindingMap(sectionConfig: TemplateSectionConfig[] | undefined): Map<string, TemplateFieldBinding[]> {
  const bindingMap = new Map<string, TemplateFieldBinding[]>();

  const pushBinding = (fieldName: string | undefined, binding: TemplateFieldBinding): void => {
    const normalizedFieldName = fieldName?.trim() ?? "";
    if (!normalizedFieldName) {
      return;
    }

    const bindings = bindingMap.get(normalizedFieldName) ?? [];
    bindings.push(binding);
    bindingMap.set(normalizedFieldName, bindings);
  };

  (sectionConfig ?? []).forEach((section) => {
    (section.fieldNames ?? []).forEach((fieldName) => {
      pushBinding(fieldName, {
        sectionId: section.id,
        sectionTitle: section.title,
        sectionMode: section.mode,
        sectionKind: section.kind,
        bindingKind: section.kind === "repeatable_entries" ? "repeatable_entry" : "section_reference",
        label: fieldName
      });
    });

    const behavior = section.behavior;
    if (!behavior) {
      return;
    }

    if (behavior.kind === "field_block") {
      behavior.fields.forEach((field) => {
        const fieldNames = isDerivedBehaviorFieldId(field) ? [field.label] : [field.id, field.label];
        fieldNames.forEach((fieldName) => pushBinding(fieldName, {
          sectionId: section.id,
          sectionTitle: section.title,
          sectionMode: section.mode,
          sectionKind: section.kind,
          bindingKind: "section_field",
          label: field.label
        }));
      });
      return;
    }

    if (behavior.kind === "table_block") {
      behavior.columns.forEach((field) => {
        const fieldNames = isDerivedBehaviorFieldId(field) ? [field.label] : [field.id, field.label];
        fieldNames.forEach((fieldName) => pushBinding(fieldName, {
          sectionId: section.id,
          sectionTitle: section.title,
          sectionMode: section.mode,
          sectionKind: section.kind,
          bindingKind: "section_field",
          label: field.label
        }));
      });
      return;
    }

    if (behavior.kind === "grouped_field_block") {
      behavior.fields.forEach((field) => {
        const fieldNames = isDerivedBehaviorFieldId(field) ? [field.label] : [field.id, field.label];
        fieldNames.forEach((fieldName) => pushBinding(fieldName, {
          sectionId: section.id,
          sectionTitle: section.title,
          sectionMode: section.mode,
          sectionKind: section.kind,
          bindingKind: "section_field",
          label: field.label
        }));
      });
      behavior.groups.forEach((group) => {
        pushBinding(group.presenceFieldName, {
          sectionId: section.id,
          sectionTitle: section.title,
          sectionMode: section.mode,
          sectionKind: section.kind,
          bindingKind: "group_presence",
          label: group.label
        });
      });
      return;
    }

    if (behavior.kind !== "mixed_field_block") {
      return;
    }

    behavior.items.forEach((item) => {
      if (item.kind === "text_field" || item.kind === "checkbox_enum" || item.kind === "task_list") {
        pushBinding(item.targetFieldName ?? item.label, {
          sectionId: section.id,
          sectionTitle: section.title,
          sectionMode: section.mode,
          sectionKind: section.kind,
          bindingKind: "mixed_item_target",
          label: item.label
        });
        return;
      }

      if (item.kind === "inline_field_group") {
        item.fields.forEach((field) => {
          pushBinding(field.fieldName, {
            sectionId: section.id,
            sectionTitle: section.title,
            sectionMode: section.mode,
            sectionKind: section.kind,
            bindingKind: "mixed_inline_field",
            label: field.label
          });
        });
      }
    });
  });

  return bindingMap;
}

function collectStructuralBoundaryLabels(sectionConfig: TemplateSectionConfig[] | undefined): Set<string> {
  const labels = new Set<string>();
  const addLabel = (value: string | undefined): void => {
    const normalized = value?.trim() ?? "";
    if (normalized) {
      labels.add(normalized);
    }
  };
  const addBehaviorField = (field: { id?: string; label?: string; aliases?: string[] }): void => {
    addLabel(field.id);
    addLabel(field.label);
    field.aliases?.forEach(addLabel);
  };

  (sectionConfig ?? []).forEach((section) => {
    addLabel(section.title);
    section.fieldNames?.forEach(addLabel);
    if (section.behavior?.kind === "repeatable_text") {
      addLabel(section.behavior.entryLabel);
    }
    section.behavior?.sourceAliases?.forEach(addLabel);
    if (section.behavior?.kind === "field_block" || section.behavior?.kind === "grouped_field_block") {
      section.behavior.fields.forEach(addBehaviorField);
    }
    if (section.behavior?.kind === "grouped_field_block") {
      section.behavior.groups.forEach((group) => {
        addLabel(group.label);
        group.aliases?.forEach(addLabel);
      });
    }
    if (section.behavior?.kind === "table_block") {
      section.behavior.columns.forEach(addBehaviorField);
    }
    if (section.behavior?.kind === "mixed_field_block") {
      section.behavior.items.forEach((item) => {
        if (item.kind === "static_note") {
          return;
        }

        addLabel(item.id);
        addLabel(item.label);
        item.aliases?.forEach(addLabel);
        if (item.kind === "text_field" || item.kind === "checkbox_enum" || item.kind === "task_list") {
          addLabel(item.targetFieldName);
        }
        if (item.kind === "inline_field_group") {
          item.fields.forEach((field) => {
            addLabel(field.id);
            addLabel(field.label);
            addLabel(field.fieldName);
            field.aliases?.forEach(addLabel);
          });
        }
      });
    }
  });

  return labels;
}

function getSectionById(
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionId: string
): TemplateSectionConfig | undefined {
  return (sectionConfig ?? []).find((section) => section.id === sectionId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels
    .map((label) => label.trim())
    .filter((label) => {
      if (!label || seen.has(label)) {
        return false;
      }

      seen.add(label);
      return true;
    });
}

function stripLeadingOrdinalLabelPrefix(label: string): string {
  return label.trim().replace(/^(?:第?\s*[一二三四五六七八九十百千万\d]+[、.．\-\s]+)\s*/u, "").trim();
}

function buildGroupedBehaviorGroupLabels(group: TemplateSectionBehaviorGroupConfig): string[] {
  return uniqueLabels([
    group.label,
    stripLeadingOrdinalLabelPrefix(group.label),
    ...(group.aliases ?? []),
    ...(group.aliases ?? []).map(stripLeadingOrdinalLabelPrefix)
  ]);
}

function resolveGroupedBinding(
  binding: SectionPendingFieldBinding,
  section: TemplateSectionConfig | undefined
):
  | {
      groupId: string;
      fieldId: string;
    }
  | null {
  const groupedKeySeparator = "::";
  if (!binding.fieldKey.includes(groupedKeySeparator)) {
    return null;
  }

  const [groupLabel = "", fieldLabel = ""] = binding.fieldKey.split(groupedKeySeparator);
  const behavior = section?.behavior?.kind === "grouped_field_block" ? section.behavior : null;
  const group = behavior?.groups.find((entry) => buildGroupedBehaviorGroupLabels(entry).includes(groupLabel));
  const field = behavior?.fields.find((entry) => entry.label === fieldLabel);

  return group && field
    ? {
        groupId: group.id,
        fieldId: field.id
      }
    : null;
}

export function finalizeTemplateFieldConfigs(
  fields: TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  options?: FinalizeTemplateFieldOptions
): TemplateFieldConfig[] {
  return applyLinkedFieldConfig(fields.map(cloneField), sectionConfig, {
    ...RUNTIME_FIELD_FINALIZE_OPTIONS,
    ...(options ?? {})
  });
}

export function finalizeEditableTemplateFieldConfigs(
  fields: TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined
): TemplateFieldConfig[] {
  return finalizeTemplateFieldConfigs(fields, sectionConfig, EDITABLE_FIELD_FINALIZE_OPTIONS);
}

export function resolveTemplateFieldsFromScan(
  scannedFields: ScannedTemplateField[],
  existingFields: TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  structuralMapping?: StructuralMappingConfig,
  rulePackConfig?: TemplateRulePackConfig
): TemplateFieldConfig[] {
  const existingFieldMap = new Map(existingFields.map((field) => [field.name, field] as const));
  const repeatableEntryFieldNames = new TemplateSectionConfigService().getInternalRepeatableEntryFieldNames(sectionConfig);
  const baseFields = scannedFields.map((field) => {
    const existingField = existingFieldMap.get(field.name);
    const aliases = repeatableEntryFieldNames.has(field.name)
      ? field.aliases ?? []
      : Array.from(new Set([...(existingField?.aliases ?? []), ...(field.aliases ?? [])]));
    const frontmatterTargets = Array.from(
      new Set([...(existingField?.frontmatterTargets ?? []), ...(field.frontmatterTargets ?? [])])
    );
    return {
      name: field.name,
      aliases,
      enabledByDefault: existingField?.enabledByDefault ?? true,
      kind: field.kind ?? existingField?.kind ?? "text",
      normalizerKey: existingField?.normalizerKey,
      semanticTriggers: existingField?.semanticTriggers ?? [],
      checkboxOptions:
        field.checkboxOptions && field.checkboxOptions.length > 0
          ? field.checkboxOptions
          : existingField?.checkboxOptions ?? [],
      ...(frontmatterTargets.length > 0 ? { frontmatterTargets } : {})
    } satisfies TemplateFieldConfig;
  });
  const resolvedScannedFields = applyBuiltInTemplateRules(baseFields, rulePackConfig);
  const preservedFieldNames = collectReferencedFieldNames(
    sectionConfig,
    structuralMapping
  );
  const mergedFields: TemplateFieldConfig[] = [
    ...resolvedScannedFields,
    ...Array.from(preservedFieldNames)
      .filter((fieldName) => !resolvedScannedFields.some((field) => field.name === fieldName))
      .map((fieldName) => {
        const existingField = existingFieldMap.get(fieldName);
        return {
          name: fieldName,
          aliases: [...(existingField?.aliases ?? [])],
          enabledByDefault: existingField?.enabledByDefault ?? true,
          kind: existingField?.kind ?? "text",
          normalizerKey: existingField?.normalizerKey,
          semanticTriggers: [...(existingField?.semanticTriggers ?? [])],
          checkboxOptions: [...(existingField?.checkboxOptions ?? [])],
          ...((existingField?.frontmatterTargets?.length ?? 0) > 0
            ? { frontmatterTargets: [...(existingField?.frontmatterTargets ?? [])] }
            : {})
        } satisfies TemplateFieldConfig;
      })
  ];

  return finalizeTemplateFieldConfigs(
    mergedFields.map((field) => ({
      ...field,
      aliases: [...field.aliases],
      semanticTriggers: field.semanticTriggers ? [...field.semanticTriggers] : [],
      checkboxOptions: field.checkboxOptions ? [...field.checkboxOptions] : [],
      ...(field.frontmatterTargets ? { frontmatterTargets: [...field.frontmatterTargets] } : {})
    })),
    sectionConfig
  );
}

function collectReferencedFieldNames(
  sectionConfig: TemplateSectionConfig[] | undefined,
  structuralMapping: StructuralMappingConfig | undefined
): Set<string> {
  const referencedFieldNames = new Set<string>();
  const addFieldName = (fieldName: string | undefined): void => {
    const normalizedFieldName = fieldName?.trim() ?? "";
    if (!normalizedFieldName) {
      return;
    }

    referencedFieldNames.add(normalizedFieldName);
  };

  (sectionConfig ?? []).forEach((section) => {
    (section.fieldNames ?? []).forEach((fieldName) => addFieldName(fieldName));

    const behavior = section.behavior;
    if (!behavior) {
      return;
    }

    if (behavior.kind === "field_block") {
      behavior.fields.forEach((field) => {
        addFieldName(isDerivedBehaviorFieldId(field) ? field.label : field.id);
      });
      return;
    }

    if (behavior.kind === "grouped_field_block") {
      behavior.fields.forEach((field) => {
        addFieldName(isDerivedBehaviorFieldId(field) ? field.label : field.id);
      });
      behavior.groups.forEach((group) => addFieldName(group.presenceFieldName));
      return;
    }

    if (behavior.kind === "table_block") {
      behavior.columns.forEach((column) => {
        addFieldName(isDerivedBehaviorFieldId(column) ? column.label : column.id);
      });
      return;
    }

    if (behavior.kind !== "mixed_field_block") {
      return;
    }

    behavior.items.forEach((item) => {
      if (item.kind === "static_note") {
        return;
      }

      if (item.kind === "inline_field_group") {
        item.fields.forEach((field) => addFieldName(field.fieldName));
        return;
      }

      addFieldName(item.targetFieldName ?? item.label);
    });
  });

  (structuralMapping?.conceptFields ?? []).forEach((concept) => {
    concept.renderTargets.forEach((target) => addFieldName(target.fieldName));
  });

  return referencedFieldNames;
}

export function setTemplateFieldAliases(
  fields: TemplateFieldConfig[],
  fieldName: string,
  aliases: string[],
  sectionConfig?: TemplateSectionConfig[]
): TemplateFieldConfig[] {
  const nextFields = fields.map((field) =>
    field.name === fieldName
      ? {
          ...field,
          aliases: [...aliases]
        }
      : cloneField(field)
  );

  return sectionConfig ? finalizeEditableTemplateFieldConfigs(nextFields, sectionConfig) : nextFields;
}

export function setTemplateFieldEnabled(
  fields: TemplateFieldConfig[],
  fieldName: string,
  enabledByDefault: boolean,
  sectionConfig?: TemplateSectionConfig[]
): TemplateFieldConfig[] {
  const nextFields = fields.map((field) =>
    field.name === fieldName
      ? {
          ...field,
          enabledByDefault
        }
      : cloneField(field)
  );

  return sectionConfig ? finalizeEditableTemplateFieldConfigs(nextFields, sectionConfig) : nextFields;
}

export function buildTemplateFieldStateSnapshot(
  fields: TemplateFieldConfig[] | TemplateStructureDescriptor,
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionConfigService: TemplateSectionConfigService
): TemplateFieldStateSnapshot {
  const descriptorInput = isTemplateStructureDescriptorInput(fields);
  const descriptor: TemplateStructureDescriptor | undefined = descriptorInput ? fields : undefined;
  const fieldConfigs: TemplateFieldConfig[] = descriptorInput ? [] : fields;
  const clonedFields: TemplateFieldConfig[] = descriptor
    ? descriptor.fields.map(fieldStructureDescriptorToConfig)
    : fieldConfigs.map(cloneField);
  const repeatableFieldNames: Set<string> = descriptor
    ? new Set(
        descriptor.sections
          .filter((section) => section.kind === "repeatable_entries")
          .flatMap((section) => section.fieldNames)
          .map((fieldName) => fieldName.trim())
          .filter(Boolean)
    )
    : sectionConfigService.getInternalRepeatableEntryFieldNames(sectionConfig);
  const runtimeOwnedFieldNames: Set<string> = descriptor
    ? new Set(
        descriptor.fields
          .filter((field) => field.features.includes("runtime_owned"))
          .map((field) => field.fieldName.trim())
          .filter(Boolean)
      )
    : new Set();
  const sectionFilteredFields = descriptor ? clonedFields : sectionConfigService.filterFields(clonedFields, sectionConfig);
  const matcherFields = sectionFilteredFields.filter(
    (field) => field.enabledByDefault && !repeatableFieldNames.has(field.name) && !runtimeOwnedFieldNames.has(field.name.trim())
  );
  const matcherFieldNames = new Set(matcherFields.map((field) => field.name.trim()).filter(Boolean));
  const reviewVisibleFieldNames = new Set(
    clonedFields
      .filter((field) =>
        field.enabledByDefault &&
        !repeatableFieldNames.has(field.name) &&
        !runtimeOwnedFieldNames.has(field.name.trim())
      )
      .map((field) => field.name.trim())
      .filter(Boolean)
  );
  const knownFieldNames = new Set(clonedFields.map((field) => field.name.trim()).filter(Boolean));
  const bindingMap = descriptor ? buildDescriptorFieldBindingMap(descriptor.sections) : buildFieldBindingMap(sectionConfig);
  const structuralBoundaryLabels = descriptor
    ? new Set(descriptor.sections.map((section) => section.title.trim()).filter(Boolean))
    : collectStructuralBoundaryLabels(sectionConfig);

  const records = clonedFields.map<TemplateFieldStateRecord>((field) => {
    const bindings = bindingMap.get(field.name.trim()) ?? [];
    const repeatableEntryField = repeatableFieldNames.has(field.name);
    const matcherEligible = matcherFieldNames.has(field.name.trim());
    const reviewVisible = reviewVisibleFieldNames.has(field.name.trim());
    const sectionManaged = bindings.some(
      (binding) => binding.sectionMode === "generate" && binding.bindingKind !== "repeatable_entry"
    );

    return {
      ...field,
      bindings: bindings.map((binding) => ({ ...binding })),
      sectionManaged,
      repeatableEntryField,
      matcherEligible,
      reviewVisible
    };
  });

  return {
    fields: records,
    fieldMap: new Map(records.map((field) => [field.name, field] as const)),
    matcherFields,
    matcherFieldNames,
    reviewVisibleFieldNames,
    knownFieldNames,
    repeatableFieldNames,
    structuralBoundaryLabels
  };
}

export function buildTemplateFieldContext(
  fields: TemplateFieldConfig[] | TemplateStructureDescriptor,
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionConfigService: TemplateSectionConfigService
): TemplateFieldContext {
  const snapshot = buildTemplateFieldStateSnapshot(fields, sectionConfig, sectionConfigService);
  return {
    fields: snapshot.fields.map((field) => cloneField(field)),
    snapshot
  };
}

export function isTemplateFieldContext(
  value: TemplateFieldContext | TemplateFieldConfig[]
): value is TemplateFieldContext {
  return !Array.isArray(value);
}

export function resolveTemplateFieldContextFields(
  value: TemplateFieldContext | TemplateFieldConfig[]
): TemplateFieldConfig[] {
  return isTemplateFieldContext(value) ? value.fields.map((field) => cloneField(field)) : value.map(cloneField);
}

export function resolveTemplateFieldContextSnapshot(
  value: TemplateFieldContext | TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  sectionConfigService: TemplateSectionConfigService
): TemplateFieldStateSnapshot {
  return isTemplateFieldContext(value)
    ? value.snapshot
    : buildTemplateFieldStateSnapshot(value, sectionConfig, sectionConfigService);
}

export function getInitialSectionPendingFieldValue(
  binding: SectionPendingFieldBinding,
  sectionConfig: TemplateSectionConfig[] | undefined,
  draftCollections: TemplateSectionDraftCollections,
  sectionDraftService: TemplateSectionDraftService
): string {
  const section = getSectionById(sectionConfig, binding.sectionId);
  if (!section) {
    return "";
  }

  const groupedBinding = resolveGroupedBinding(binding, section);
  if (groupedBinding) {
    const initialDraft = sectionDraftService.createGroupedFieldBlockDraft(
      section,
      draftCollections.currentSectionDraftExtraction?.groupedFieldBlockDrafts.get(binding.sectionId),
      undefined
    );
    return initialDraft[groupedBinding.groupId]?.[groupedBinding.fieldId] ?? "";
  }

  const fieldBehavior = section.behavior?.kind === "field_block" ? section.behavior : null;
  const field = fieldBehavior?.fields.find((entry) => entry.label === binding.fieldKey);
  if (field) {
    const initialDraft = sectionDraftService.createFieldBlockDraft(
      section,
      draftCollections.currentSectionDraftExtraction?.fieldBlockDrafts.get(binding.sectionId),
      undefined
    );
    return initialDraft[field.id] ?? "";
  }

  const initialDraft = sectionDraftService.createMixedFieldBlockDraft(
    section,
    draftCollections.currentSectionDraftExtraction?.mixedFieldBlockDrafts.get(binding.sectionId),
    undefined,
    draftCollections.currentTemplateContent
  );
  return initialDraft[binding.fieldKey] ?? "";
}

export function readSectionPendingFieldValue(
  binding: SectionPendingFieldBinding,
  sectionConfig: TemplateSectionConfig[] | undefined,
  draftCollections: TemplateSectionDraftCollections
): string {
  const section = getSectionById(sectionConfig, binding.sectionId);
  const groupedBinding = resolveGroupedBinding(binding, section);
  if (groupedBinding) {
    return (
      draftCollections.groupedFieldBlockSectionDrafts.get(binding.sectionId)?.[groupedBinding.groupId]?.[
        groupedBinding.fieldId
      ] ?? ""
    );
  }

  const fieldBlockDraft = draftCollections.fieldBlockSectionDrafts.get(binding.sectionId);
  const fieldBehavior = section?.behavior?.kind === "field_block" ? section.behavior : null;
  const field = fieldBehavior?.fields.find((entry) => entry.label === binding.fieldKey);
  if (field && fieldBlockDraft) {
    return fieldBlockDraft[field.id] ?? "";
  }

  return draftCollections.mixedFieldBlockSectionDrafts.get(binding.sectionId)?.[binding.fieldKey] ?? "";
}

export function getSectionPendingReviewStatus(
  binding: SectionPendingFieldBinding,
  value: string,
  sectionConfig: TemplateSectionConfig[] | undefined,
  draftCollections: TemplateSectionDraftCollections,
  sectionDraftService: TemplateSectionDraftService
): TemplateFieldReviewStatus {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "unmatched";
  }

  const initialValue = getInitialSectionPendingFieldValue(
    binding,
    sectionConfig,
    draftCollections,
    sectionDraftService
  ).trim();
  if (!initialValue) {
    return "edited";
  }

  return trimmedValue === initialValue ? "matched" : "edited";
}

export function writeSectionPendingFieldValue(
  binding: SectionPendingFieldBinding,
  value: string,
  sectionConfig: TemplateSectionConfig[] | undefined,
  draftCollections: TemplateSectionDraftCollections
): TemplateSectionDraftCollections {
  const section = getSectionById(sectionConfig, binding.sectionId);
  const groupedBinding = resolveGroupedBinding(binding, section);
  if (groupedBinding) {
    const nextDrafts = new Map(draftCollections.groupedFieldBlockSectionDrafts);
    const currentDraft = nextDrafts.get(binding.sectionId) ?? {};
    nextDrafts.set(binding.sectionId, {
      ...currentDraft,
      [groupedBinding.groupId]: {
        ...(currentDraft[groupedBinding.groupId] ?? {}),
        [groupedBinding.fieldId]: value
      }
    });
    return {
      ...draftCollections,
      groupedFieldBlockSectionDrafts: nextDrafts
    };
  }

  const fieldBehavior = section?.behavior?.kind === "field_block" ? section.behavior : null;
  const field = fieldBehavior?.fields.find((entry) => entry.label === binding.fieldKey);
  if (field) {
    const nextDrafts = new Map(draftCollections.fieldBlockSectionDrafts);
    const currentDraft = nextDrafts.get(binding.sectionId) ?? {};
    nextDrafts.set(binding.sectionId, {
      ...currentDraft,
      [field.id]: value
    });
    return {
      ...draftCollections,
      fieldBlockSectionDrafts: nextDrafts
    };
  }

  const nextDrafts = new Map(draftCollections.mixedFieldBlockSectionDrafts);
  const currentDraft = nextDrafts.get(binding.sectionId) ?? {};
  nextDrafts.set(binding.sectionId, {
    ...currentDraft,
    [binding.fieldKey]: value
  });
  return {
    ...draftCollections,
    mixedFieldBlockSectionDrafts: nextDrafts
  };
}

export function buildSectionPendingFieldItems(
  fields: TemplateFieldContext | TemplateFieldConfig[],
  ordinaryFieldNames: Set<string>,
  sectionConfig: TemplateSectionConfig[] | undefined,
  draftCollections: TemplateSectionDraftCollections,
  sectionConfigService: TemplateSectionConfigService,
  sectionDraftService: TemplateSectionDraftService
): SectionPendingFieldItem[] {
  const snapshot = resolveTemplateFieldContextSnapshot(fields, sectionConfig, sectionConfigService);
  const shouldIncludeField = (fieldName: string): boolean =>
    !snapshot.knownFieldNames.has(fieldName.trim()) || snapshot.reviewVisibleFieldNames.has(fieldName.trim());
  const items: SectionPendingFieldItem[] = [];

  const getGroupedTemplateFieldIds = (
    section: TemplateSectionConfig,
    behavior: Extract<TemplateSectionConfig["behavior"], { kind: "grouped_field_block" }>,
    group: TemplateSectionBehaviorGroupConfig
  ): Set<string> => {
    const rawContent = getRuntimeSectionRawContent(section).split(/\r?\n/);
    const groupLabels = buildGroupedBehaviorGroupLabels(group);
    const headingPattern = new RegExp(
      `^\\s*>?\\s*#{2,6}\\s+(?:第?\\s*[一二三四五六七八九十百千万\\d]+[、.．\\-\\s]+\\s*)?(?:${groupLabels.map(escapeRegExp).join("|")})\\s*$`,
      "i"
    );
    const anyHeadingPattern = /^\s*>?\s*#{2,6}\s+.+$/;
    const startIndex = rawContent.findIndex((line) => headingPattern.test(line ?? ""));
    if (startIndex < 0) {
      return new Set(behavior.fields.map((field) => field.id));
    }

    let endIndex = rawContent.length;
    for (let index = startIndex + 1; index < rawContent.length; index += 1) {
      const line = rawContent[index] ?? "";
      if (anyHeadingPattern.test(line)) {
        endIndex = index;
        break;
      }
    }

    const block = rawContent.slice(startIndex + 1, endIndex);
    const ids = new Set<string>();
    behavior.fields.forEach((field) => {
      const escapedLabel = escapeRegExp(field.label);
      const pattern = new RegExp(`^\\s*>?\\s*[-*+]\\s+${escapedLabel}\\s*[：:]`);
      if (block.some((line) => pattern.test(line ?? ""))) {
        ids.add(field.id);
      }
    });
    return ids;
  };

  (sectionConfig ?? [])
    .filter((section) => section.mode === "generate")
    .forEach((section) => {
      if (sectionDraftService.isFieldBlockSection(section)) {
        const behavior = section.behavior?.kind === "field_block" ? section.behavior : null;
        const draft = draftCollections.fieldBlockSectionDrafts.get(section.id) ?? {};
        behavior?.fields.forEach((field) => {
          const fieldKey = field.label;
          if (ordinaryFieldNames.has(fieldKey) || !shouldIncludeField(fieldKey)) {
            return;
          }

          const binding: SectionPendingFieldBinding = {
            id: `section-field:${section.id}:${field.id}`,
            sectionId: section.id,
            sectionTitle: section.title,
            fieldKey,
            label: field.label,
            inputKind: field.inputKind
          };
          const value = draft[field.id] ?? "";
          items.push({
            kind: "section_field",
            binding,
            value,
            reviewStatus: getSectionPendingReviewStatus(
              binding,
              value,
              sectionConfig,
              draftCollections,
              sectionDraftService
            )
          });
        });
        return;
      }

      if (sectionDraftService.isGroupedFieldBlockSection(section)) {
        const behavior = section.behavior?.kind === "grouped_field_block" ? section.behavior : null;
        const draft = draftCollections.groupedFieldBlockSectionDrafts.get(section.id) ?? {};
        behavior?.groups.forEach((group) => {
          const groupFieldIds = getGroupedTemplateFieldIds(section, behavior, group);
          behavior.fields.forEach((field) => {
            if (!groupFieldIds.has(field.id)) {
              return;
            }

            if (!shouldIncludeField(field.label)) {
              return;
            }

            const binding: SectionPendingFieldBinding = {
              id: `section-group-field:${section.id}:${group.id}:${field.id}`,
              sectionId: section.id,
              sectionTitle: section.title,
              fieldKey: `${group.label}::${field.label}`,
              label: field.label,
              inputKind: field.inputKind
            };
            const value = draft[group.id]?.[field.id] ?? "";
            items.push({
              kind: "section_field",
              binding,
              value,
              reviewStatus: getSectionPendingReviewStatus(
                binding,
                value,
                sectionConfig,
                draftCollections,
                sectionDraftService
              )
            });
          });
        });
        return;
      }

      if (!sectionDraftService.isMixedFieldBlockSection(section)) {
        return;
      }

      const behavior = section.behavior?.kind === "mixed_field_block" ? section.behavior : null;
      const draft = draftCollections.mixedFieldBlockSectionDrafts.get(section.id) ?? {};
      behavior?.items.forEach((item) => {
        if (item.kind === "text_field" || item.kind === "checkbox_enum") {
          const fieldKey = item.targetFieldName ?? item.label;
          if (ordinaryFieldNames.has(fieldKey) || !shouldIncludeField(fieldKey)) {
            return;
          }

          const binding: SectionPendingFieldBinding = {
            id:
              item.kind === "checkbox_enum"
                ? `section-mixed-checkbox:${section.id}:${item.id}`
                : `section-mixed-field:${section.id}:${item.id}`,
            sectionId: section.id,
            sectionTitle: section.title,
            fieldKey,
            label: item.label,
            inputKind: item.kind === "checkbox_enum" ? "text" : item.inputKind
          };
          const value = draft[fieldKey] ?? "";
          items.push({
            kind: "section_field",
            binding,
            value,
            reviewStatus: getSectionPendingReviewStatus(
              binding,
              value,
              sectionConfig,
              draftCollections,
              sectionDraftService
            )
          });
          return;
        }

        if (item.kind === "inline_field_group") {
          item.fields.forEach((field) => {
            if (ordinaryFieldNames.has(field.fieldName) || !shouldIncludeField(field.fieldName)) {
              return;
            }

            const binding: SectionPendingFieldBinding = {
              id: `section-mixed-inline:${section.id}:${field.id}`,
              sectionId: section.id,
              sectionTitle: section.title,
              fieldKey: field.fieldName,
              label: field.label || field.fieldName,
              inputKind: "text"
            };
            const value = draft[field.fieldName] ?? "";
            items.push({
              kind: "section_field",
              binding,
              value,
              reviewStatus: getSectionPendingReviewStatus(
                binding,
                value,
                sectionConfig,
                draftCollections,
                sectionDraftService
              )
            });
          });
          return;
        }

        if (item.kind === "task_list") {
          const fieldKey = item.targetFieldName ?? item.label;
          if (ordinaryFieldNames.has(fieldKey) || !shouldIncludeField(fieldKey)) {
            return;
          }

          const binding: SectionPendingFieldBinding = {
            id: `section-mixed-task:${section.id}:${item.id}`,
            sectionId: section.id,
            sectionTitle: section.title,
            fieldKey,
            label: item.label,
            inputKind: "textarea"
          };
          const value = draft[fieldKey] ?? "";
          items.push({
            kind: "section_field",
            binding,
            value,
            reviewStatus: getSectionPendingReviewStatus(
              binding,
              value,
              sectionConfig,
              draftCollections,
              sectionDraftService
            )
          });
        }
      });
    });

  return items;
}

export function buildSectionRunDecisions(items: SectionPendingFieldItem[]): RunFieldDecision[] {
  return items
    .filter((item) => item.reviewStatus !== "matched")
    .map((item) => ({
      fieldName: item.binding.label,
      kind: item.reviewStatus === "edited" ? "manual" : "unmatched",
      rawValue: "",
      resolvedValue: item.value.trim(),
      changed: item.reviewStatus === "edited"
    }));
}

export function getMatchedFieldReviewStatus(
  rawResult: FieldMatchResult,
  resolvedResult: FieldMatchResult,
  runDecision: RunFieldDecision
): TemplateFieldReviewStatus {
  if (rawResult.edited || resolvedResult.edited || runDecision.kind === "manual") {
    return "edited";
  }

  if (!resolvedResult.finalValue.trim()) {
    return "unmatched";
  }

  if (runDecision.kind === "semantic") {
    return "needs_review";
  }

  return "matched";
}

export function buildMatchedFieldReviewItems(
  rawResults: FieldMatchResult[],
  resolvedResults: FieldMatchResult[],
  runDecisions: RunFieldDecision[]
): MatchedFieldReviewItem[] {
  const resolvedResultMap = new Map(resolvedResults.map((result) => [result.fieldName, result] as const));
  const runDecisionMap = new Map(runDecisions.map((field) => [field.fieldName, field] as const));

  return rawResults
    .map((rawResult) => {
      const resolvedResult = resolvedResultMap.get(rawResult.fieldName) ?? rawResult;
      const runDecision =
        runDecisionMap.get(rawResult.fieldName) ??
        ({
          fieldName: rawResult.fieldName,
          kind: "unmatched",
          rawValue: rawResult.finalValue.trim(),
          resolvedValue: resolvedResult.finalValue.trim(),
          changed: false
        } satisfies RunFieldDecision);

      return {
        kind: "matched_field" as const,
        rawResult,
        resolvedResult,
        runDecision,
        reviewStatus: getMatchedFieldReviewStatus(rawResult, resolvedResult, runDecision)
      };
    })
    .sort((left, right) => {
      const statusWeight: Record<TemplateFieldReviewStatus, number> = {
        unmatched: 0,
        needs_review: 1,
        edited: 2,
        matched: 3
      };
      const statusDelta = statusWeight[left.reviewStatus] - statusWeight[right.reviewStatus];
      if (statusDelta !== 0) {
        return statusDelta;
      }

      return left.rawResult.fieldName.localeCompare(right.rawResult.fieldName, undefined, {
        sensitivity: "base"
      });
    });
}

export function buildFieldReviewGroups(items: TemplateReviewItem[]): FieldReviewGroup[] {
  return [
    {
      title: "",
      items
    }
  ];
}

function getSectionPendingFieldName(item: SectionPendingFieldItem): string {
  return item.binding.fieldKey.split("::").pop()?.trim() || item.binding.label.trim();
}

export function buildTemplateRunFieldStateSnapshot(
  matchedItems: MatchedFieldReviewItem[],
  sectionItems: SectionPendingFieldItem[]
): TemplateRunFieldStateSnapshot {
  const sectionOwnerFieldNames = new Set(
    sectionItems
      .filter((item) => item.reviewStatus !== "unmatched")
      .map(getSectionPendingFieldName)
      .filter(Boolean)
  );
  const matchedRecords: TemplateRunFieldStateRecord[] = matchedItems
    .filter(
      (item) =>
        item.reviewStatus !== "unmatched" ||
        !sectionOwnerFieldNames.has(item.rawResult.fieldName.trim())
    )
    .map((item) => ({
      id: `field:${item.rawResult.fieldName}`,
      fieldName: item.rawResult.fieldName,
      source: "matched_field",
      finalValue: item.resolvedResult.finalValue,
      reviewStatus: item.reviewStatus,
      reviewItem: item,
      renderOwner: !sectionOwnerFieldNames.has(item.rawResult.fieldName.trim())
    }));
  const sectionRecords: TemplateRunFieldStateRecord[] = sectionItems.map((item) => ({
    id: item.binding.id,
    fieldName: getSectionPendingFieldName(item),
    source: "section_draft",
    finalValue: item.value,
    reviewStatus: item.reviewStatus,
    reviewItem: item,
    renderOwner: item.value.trim().length > 0
  }));
  const records = [...matchedRecords, ...sectionRecords];
  const pendingItems = records
    .filter((record) => record.reviewStatus === "unmatched")
    .map((record) => record.reviewItem);

  return {
    records,
    allItems: records.map((record) => record.reviewItem),
    pendingItems
  };
}

function getRunDecisionKindFromReviewStatus(status: TemplateFieldReviewStatus): RunFieldDecisionKind {
  switch (status) {
    case "edited":
      return "manual";
    case "needs_review":
      return "semantic";
    case "matched":
      return "matched";
    default:
      return "unmatched";
  }
}

export function buildRunDecisionSummaryFromFieldStateSnapshot(
  snapshot: TemplateRunFieldStateSnapshot
): RunDecisionSummary {
  const fields: RunFieldDecision[] = snapshot.records.map((record) => {
    const matchedItem = record.reviewItem.kind === "matched_field" ? record.reviewItem : null;
    const rawValue = matchedItem?.runDecision.rawValue ?? "";
    const resolvedValue = matchedItem?.runDecision.resolvedValue ?? record.finalValue.trim();
    const changed = matchedItem?.runDecision.changed ?? record.reviewStatus === "edited";
    return {
      fieldName: record.fieldName,
      kind: getRunDecisionKindFromReviewStatus(record.reviewStatus),
      rawValue,
      resolvedValue,
      changed
    };
  });

  return {
    manualCount: fields.filter((field) => field.kind === "manual").length,
    semanticCount: fields.filter((field) => field.kind === "semantic").length,
    matchedCount: fields.filter((field) => field.kind === "matched").length,
    unmatchedCount: fields.filter((field) => field.kind === "unmatched").length,
    changedCount: fields.filter((field) => field.changed).length,
    fields
  };
}

export function buildTemplateRunFieldStateStats(
  snapshot: TemplateRunFieldStateSnapshot
): TemplateRunFieldStateStats {
  return {
    runFieldCount: snapshot.records.length,
    pendingFieldCount: snapshot.pendingItems.length,
    matchedFieldCount: snapshot.records.filter((record) => record.reviewStatus !== "unmatched").length,
    sectionDraftFieldCount: snapshot.records.filter((record) => record.source === "section_draft").length
  };
}

function readSectionCellValue(row: Record<string, string>, field: { id: string; label: string }): string {
  return row[field.id] ?? row[field.label] ?? "";
}

function assignTemplateRunValueIfActive(
  valueMap: Record<string, string>,
  enabledFieldNames: Set<string>,
  fieldName: string | undefined,
  value: string | undefined
): void {
  const normalizedFieldName = fieldName?.trim() ?? "";
  const normalizedValue = value?.trim() ?? "";
  if (!normalizedFieldName || !normalizedValue || !enabledFieldNames.has(normalizedFieldName)) {
    return;
  }

  valueMap[normalizedFieldName] = normalizedValue;
}

export function buildResolvedValueMapFromRunFieldState(
  params: TemplateRunResolvedValueMapParams
): Record<string, string> {
  const valueMap: Record<string, string> = {};
  params.snapshot.records
    .filter((record) => {
      if (!record.renderOwner) {
        return false;
      }

      return record.reviewItem.kind !== "matched_field" || record.reviewItem.resolvedResult.enabled;
    })
    .forEach((record) => {
      assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, record.fieldName, record.finalValue);
    });

  params.sectionConfig?.forEach((section) => {
    const behavior = section.behavior;
    if (!behavior) {
      return;
    }

    if (behavior.kind === "field_block") {
      const draft = params.fieldBlockSectionDrafts?.get(section.id);
      behavior.fields.forEach((field) => {
        const value = draft ? readSectionCellValue(draft, field) : "";
        assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, field.label, value);
        assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, field.id, value);
      });
      return;
    }

    if (behavior.kind === "grouped_field_block") {
      const draft = params.groupedFieldBlockSectionDrafts?.get(section.id);
      behavior.groups.forEach((group) => {
        behavior.fields.forEach((field) => {
          const groupDraft = draft?.[group.id];
          const value = groupDraft ? readSectionCellValue(groupDraft, field) : "";
          assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, field.label, value);
          assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, field.id, value);
        });
      });
      return;
    }

    if (behavior.kind === "table_block") {
      const rows = params.tableBlockSectionDrafts?.get(section.id) ?? [];
      rows.forEach((row) => {
        behavior.columns.forEach((column) => {
          const value = readSectionCellValue(row, column);
          assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, column.label, value);
          assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, column.id, value);
        });
      });
    }
  });

  params.mixedFieldBlockSectionDrafts?.forEach((draft) => {
    Object.entries(draft).forEach(([fieldName, value]) => {
      assignTemplateRunValueIfActive(valueMap, params.enabledFieldNames, fieldName, value);
    });
  });

  return valueMap;
}

export function buildPendingFieldReviewViewModel(
  matchedItems: MatchedFieldReviewItem[],
  sectionItems: SectionPendingFieldItem[],
  fieldViewMode: TemplateFieldViewMode
): PendingFieldReviewViewModel {
  const snapshot = buildTemplateRunFieldStateSnapshot(matchedItems, sectionItems);
  const allItems = snapshot.allItems;
  const pendingItems = snapshot.pendingItems;
  const hasPendingFields = pendingItems.length > 0;
  const visibleItems = fieldViewMode === "review" ? pendingItems : allItems;

  return {
    allItems,
    pendingItems,
    visibleItems,
    hasPendingFields,
    fieldGroups: buildFieldReviewGroups(visibleItems)
  };
}

export function resolveMatchedFieldRowState(
  fieldViewMode: TemplateFieldViewMode,
  reviewStatus: TemplateFieldReviewStatus,
  result: FieldMatchResult,
  autoState: TemplateFieldAutoState | undefined
): MatchedFieldRowState {
  const pendingReviewMode = reviewStatus === "unmatched";
  const showSecondaryAction = !pendingReviewMode && shouldShowTemplateFieldResetAction(result, autoState);
  const showToggle = !pendingReviewMode;

  return {
    pendingReviewMode,
    showToggle,
    showSecondaryAction,
    layout:
      showToggle && showSecondaryAction
        ? "full"
        : showToggle && !showSecondaryAction
        ? "toggle-primary"
        : !showToggle && showSecondaryAction
          ? "actions"
          : "primary",
    secondaryActionKey: "reset"
  };
}

export function resolveSectionPendingFieldRowState(
  fieldViewMode: TemplateFieldViewMode,
  value: string
): SectionPendingFieldRowState {
  const canReset = fieldViewMode === "all" && value.trim().length > 0;
  return {
    canReset,
    layout: canReset ? "actions" : "primary"
  };
}

export function buildMatchedFieldTrace(
  translate: (key: string, vars?: Record<string, string>) => string,
  _reviewStatus: TemplateFieldReviewStatus,
  _result: FieldMatchResult,
  showFieldTraceDetails: boolean,
  fieldDescriptor?: FieldStructureDescriptor
): TemplateFieldTraceState {
  const descriptorParts: string[] = [];
  if (fieldDescriptor?.kind === "inline_field") {
    descriptorParts.push(translate("match_trace_structure_inline_field"));
  } else if (fieldDescriptor?.kind === "checkbox_group") {
    descriptorParts.push(translate("match_trace_structure_checkbox_group"));
  } else if (fieldDescriptor?.renderTargetKinds.includes("frontmatter")) {
    descriptorParts.push(translate("match_trace_structure_frontmatter"));
  } else if (fieldDescriptor?.features.includes("placeholder")) {
    descriptorParts.push(translate("match_trace_structure_placeholder"));
  }

  const text = descriptorParts[0] ?? "";

  return {
    text,
    visible: showFieldTraceDetails && text.trim().length > 0
  };
}

function formatSectionTraceStructure(
  translate: (key: string, vars?: Record<string, string>) => string,
  trace: TemplateSectionDraftTrace | undefined
): string {
  switch (trace?.behaviorKind) {
    case "repeatable_text":
      return translate("section_behavior_repeatable_text");
    case "task_list":
      return translate("section_behavior_task_list");
    case "field_block":
      return translate("section_behavior_field_block");
    case "table_block":
      return translate("section_behavior_table_block");
    case "grouped_field_block":
      return translate("section_behavior_grouped_field_block");
    case "mixed_field_block":
      return translate("section_behavior_mixed_field_block");
    default:
      return translate("section_kind_content_block");
  }
}

export function buildSectionPendingFieldTrace(
  translate: (key: string, vars?: Record<string, string>) => string,
  binding: SectionPendingFieldBinding,
  showFieldTraceDetails: boolean,
  trace?: TemplateSectionDraftTrace
): TemplateFieldTraceState {
  const text = translate("pending_fields_section_managed_trace_with_structure", {
    title: trace?.sectionTitle || binding.sectionTitle,
    structure: formatSectionTraceStructure(translate, trace)
  });

  return {
    text,
    visible: showFieldTraceDetails
  };
}

export function createTemplateFieldAutoState(result: FieldMatchResult): TemplateFieldAutoState {
  return {
    matched: result.matched,
    matchReason: result.matchReason,
    matchedLabel: result.matchedLabel
  };
}

export function hasTemplateFieldAutoMatch(
  result: FieldMatchResult,
  autoState: TemplateFieldAutoState | undefined
): boolean {
  return Boolean(autoState?.matched || result.candidateValue.trim().length > 0);
}

export function shouldShowTemplateFieldResetAction(
  result: FieldMatchResult,
  autoState: TemplateFieldAutoState | undefined
): boolean {
  if (result.edited && result.finalValue.trim().length > 0) {
    return true;
  }

  return hasTemplateFieldAutoMatch(result, autoState) && result.finalValue.trim().length > 0;
}

export function applyTemplateFieldManualValue(
  result: FieldMatchResult,
  autoState: TemplateFieldAutoState | undefined,
  value: string
): void {
  const trimmedValue = value.trim();
  const trimmedCandidate = result.candidateValue.trim();
  result.finalValue = value;

  if (trimmedValue.length === 0) {
    result.edited = false;
    result.matched = false;
    result.matchReason = "unmatched";
    result.matchedLabel = undefined;
    return;
  }

  if (trimmedCandidate && trimmedValue === trimmedCandidate) {
    result.edited = false;
    result.matched = autoState?.matched ?? true;
    result.matchReason = autoState?.matchReason ?? "label";
    result.matchedLabel = autoState?.matchedLabel;
    return;
  }

  result.edited = true;
}

export function mergeRematchedFieldResults(
  previousResults: FieldMatchResult[],
  rematchedResults: FieldMatchResult[]
): FieldMatchResult[] {
  const previousResultMap = new Map(
    previousResults.map((result) => [result.fieldName, result] as const)
  );

  return rematchedResults.map((result) => {
    const previous = previousResultMap.get(result.fieldName);
    if (!previous) {
      return result;
    }

    if (previous.edited) {
      return previous;
    }

    return {
      ...result,
      enabled: previous.enabled
    };
  });
}
