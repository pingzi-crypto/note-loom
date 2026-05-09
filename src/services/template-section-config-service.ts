import type {
  TemplateConfig,
  TemplateFieldConfig,
  TemplateRulePackConfig,
  TemplateSectionBehaviorConfig,
  TemplateSectionConfig,
  TemplateSectionMode,
  TemplateSectionModeSource,
  TemplateSemanticConfig
} from "../types/template";
import {
  isTemplateFieldContext,
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import {
  inferRepeatableEntriesStructureBehavior,
  inferSectionStructureMode,
  resolveSectionStructureTogglesForSection
} from "./template-section-structure-rules";
import {
  inferSectionBehaviorByOrder,
  resolveSectionBehaviorRuleOrderForSection
} from "./template-section-behavior-order";
import {
  inferFieldBlockBehavior,
  inferGroupedBehavior,
  inferMixedFieldBlockBehavior,
  inferPlainBulletListBehavior,
  inferTableBehavior,
  inferTaskListBehavior
} from "./template-section-behavior-inferers";
import { applyGenericTemplateSectionRules } from "./template-generic-section-rule-service";
import { TemplateSectionScanner } from "./template-section-scanner";
import { TemplateScanner } from "./template-scanner";

const sectionRawContentById = new WeakMap<TemplateSectionConfig, string>();

export function getRuntimeSectionRawContent(section: TemplateSectionConfig): string {
  return sectionRawContentById.get(section) ?? (section as TemplateSectionConfig & { rawContent?: string }).rawContent ?? "";
}

function cloneSemanticConfig(config: TemplateSemanticConfig | undefined): TemplateSemanticConfig | undefined {
  return config ? (JSON.parse(JSON.stringify(config)) as TemplateSemanticConfig) : undefined;
}

function cloneField(field: TemplateFieldConfig): TemplateFieldConfig {
  return {
    ...field,
    aliases: [...field.aliases],
    semanticTriggers: field.semanticTriggers ? [...field.semanticTriggers] : [],
    checkboxOptions: field.checkboxOptions ? [...field.checkboxOptions] : []
  };
}

function cloneSection(section: TemplateSectionConfig): TemplateSectionConfig {
  const cloned = {
    ...section,
    fieldNames: section.fieldNames ? [...section.fieldNames] : undefined,
    behavior: section.behavior ? JSON.parse(JSON.stringify(section.behavior)) : undefined
  };
  const rawContent = sectionRawContentById.get(section);
  if (rawContent !== undefined) {
    sectionRawContentById.set(cloned, rawContent);
  }
  return cloned;
}

interface BuildSectionConfigOptions {
  includeModeSource?: boolean;
  resetRecognitionConfig?: boolean;
}

interface ResolvedSectionMode {
  mode: TemplateSectionMode;
  modeSource: TemplateSectionModeSource;
}

function addIfPresent(target: Set<string>, value: string | undefined): void {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 0) {
    target.add(normalized);
  }
}

function addBehaviorFieldIdentity(
  target: Set<string>,
  field: { id?: string; label?: string; fieldName?: string; targetFieldName?: string }
): void {
  addIfPresent(target, field.id);
  addIfPresent(target, field.label);
  addIfPresent(target, field.fieldName);
  addIfPresent(target, field.targetFieldName);
}

function isInternalRepeatableEntrySection(section: TemplateSectionConfig): boolean {
  if (section.kind !== "repeatable_entries") {
    return false;
  }

  const behavior = section.behavior;
  if (behavior?.kind !== "repeatable_text") {
    return true;
  }

  return !(behavior.parserId === "generic_inline_fields" && behavior.overrideMode === "append");
}

function collectSectionManagedFieldNames(
  sectionConfig: TemplateConfig["sectionConfig"]
): Set<string> {
  const managedFieldNames = new Set<string>();

  (sectionConfig ?? [])
    .filter((section) => section.mode === "generate")
    .forEach((section) => {
      const behavior = section.behavior;
      if (!behavior) {
        return;
      }

      if (isInternalRepeatableEntrySection(section) || !(behavior.kind === "repeatable_text" && behavior.overrideMode === "append")) {
        (section.fieldNames ?? []).forEach((fieldName) => addIfPresent(managedFieldNames, fieldName));
      }

      if (behavior.kind === "field_block") {
        behavior.fields.forEach((field) => addBehaviorFieldIdentity(managedFieldNames, field));
        return;
      }

      if (behavior.kind === "table_block") {
        behavior.columns.forEach((column) => addBehaviorFieldIdentity(managedFieldNames, column));
        return;
      }

      if (behavior.kind === "grouped_field_block") {
        behavior.fields.forEach((field) => addBehaviorFieldIdentity(managedFieldNames, field));
        behavior.groups.forEach((group) => {
          addIfPresent(managedFieldNames, group.id);
          addIfPresent(managedFieldNames, group.label);
          addIfPresent(managedFieldNames, group.presenceFieldName);
        });
        return;
      }

      if (behavior.kind !== "mixed_field_block") {
        return;
      }

      behavior.items.forEach((item) => {
        if (item.kind === "text_field" || item.kind === "checkbox_enum" || item.kind === "task_list") {
          addBehaviorFieldIdentity(managedFieldNames, item);
          return;
        }

        if (item.kind === "inline_field_group") {
          item.fields.forEach((field) => addBehaviorFieldIdentity(managedFieldNames, field));
        }
      });
    });

  return managedFieldNames;
}

function inferRepeatableEntriesBehavior(section: {
  title: string;
  fieldNames?: string[];
  rawContent?: string;
}, rulePackConfig?: TemplateRulePackConfig): TemplateSectionBehaviorConfig {
  const toggles = resolveSectionStructureTogglesForSection(
    { title: section.title, kind: "repeatable_entries" },
    rulePackConfig
  );
  return inferRepeatableEntriesStructureBehavior(section, toggles, rulePackConfig);
}

function inferSectionBehavior(section: {
  title: string;
  kind: TemplateSectionConfig["kind"];
  fieldNames?: string[];
  rawContent: string;
  allTemplateFieldNames: string[];
}, rulePackConfig?: TemplateRulePackConfig): TemplateSectionBehaviorConfig | undefined {
  const sectionBehaviorRuleOrder = resolveSectionBehaviorRuleOrderForSection({
    title: section.title,
    kind: section.kind
  }, rulePackConfig);
  const inferred = inferSectionBehaviorByOrder(section, {
    inferRepeatableEntriesBehavior: (repeatableSection) =>
      inferRepeatableEntriesBehavior({ ...repeatableSection, rawContent: section.rawContent }, rulePackConfig),
    inferTableBehavior,
    inferMixedFieldBlockBehavior,
    inferGroupedBehavior,
    inferFieldBlockBehavior,
    inferTaskListBehavior
  }, sectionBehaviorRuleOrder);

  return inferred ?? (
    section.kind === "content_block"
      ? inferPlainBulletListBehavior(section.rawContent)
      : undefined
  );
}

function hasExplicitStructureToggle(rulePackConfig: TemplateRulePackConfig | undefined, section: {
  title: string;
  kind: TemplateSectionConfig["kind"];
}): boolean {
  const toggles = resolveSectionStructureTogglesForSection(section, rulePackConfig);
  return Boolean(
    toggles &&
    (
      toggles.futurePlanningIgnore !== undefined ||
      toggles.futurePlanningSection !== undefined ||
      toggles.repeatableParserRoute !== undefined
    )
  );
}

function resolveInferredSectionMode(section: {
  title: string;
  kind: TemplateSectionConfig["kind"];
  fieldNames?: string[];
}, rulePackConfig?: TemplateRulePackConfig): ResolvedSectionMode {
  const toggleContext = {
    title: section.title,
    kind: section.kind
  };
  const toggles = resolveSectionStructureTogglesForSection(toggleContext, rulePackConfig);
  return {
    mode: inferSectionStructureMode(section, toggles),
    modeSource: hasExplicitStructureToggle(rulePackConfig, toggleContext) ? "rule" : "inferred"
  };
}

function shouldPreserveExistingMode(existing: TemplateSectionConfig | undefined): boolean {
  if (!existing) {
    return false;
  }

  return !existing.modeSource || existing.modeSource === "user";
}

function applyModeSource(
  section: TemplateSectionConfig,
  modeSource: TemplateSectionModeSource,
  options?: BuildSectionConfigOptions
): TemplateSectionConfig {
  return options?.includeModeSource
    ? { ...section, modeSource }
    : section;
}

function fieldBlockLabelsMatch(
  left: TemplateSectionBehaviorConfig | undefined,
  right: TemplateSectionBehaviorConfig | undefined
): boolean {
  if (!left || !right || left.kind !== "field_block" || right.kind !== "field_block") {
    return false;
  }

  const leftFields = left.fields.map((field) => `${field.id.trim()}=${field.label.trim()}`).filter(Boolean);
  const rightFields = right.fields.map((field) => `${field.id.trim()}=${field.label.trim()}`).filter(Boolean);
  if (leftFields.length !== rightFields.length) {
    return false;
  }

  return leftFields.every((field, index) => field === rightFields[index]);
}

function behaviorLabelsMatch(
  left: TemplateSectionBehaviorConfig | undefined,
  right: TemplateSectionBehaviorConfig | undefined
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "field_block" && right.kind === "field_block") {
    const leftFields = left.fields.map((field) => `${field.id.trim()}=${field.label.trim()}`).filter(Boolean);
    const rightFields = right.fields.map((field) => `${field.id.trim()}=${field.label.trim()}`).filter(Boolean);
    return leftFields.length === rightFields.length && leftFields.every((field, index) => field === rightFields[index]);
  }

  if (left.kind === "grouped_field_block" && right.kind === "grouped_field_block") {
    const leftGroupLabels = left.groups.map((group) => group.label.trim()).filter(Boolean);
    const rightGroupLabels = right.groups.map((group) => group.label.trim()).filter(Boolean);
    const leftFields = left.fields.map((field) => `${field.id.trim()}=${field.label.trim()}`).filter(Boolean);
    const rightFields = right.fields.map((field) => `${field.id.trim()}=${field.label.trim()}`).filter(Boolean);
    return (
      leftGroupLabels.length === rightGroupLabels.length &&
      leftGroupLabels.every((label, index) => label === rightGroupLabels[index]) &&
      leftFields.length === rightFields.length &&
      leftFields.every((field, index) => field === rightFields[index])
    );
  }

  if (left.kind === "table_block" && right.kind === "table_block") {
    const leftColumns = left.columns.map((column) => `${column.id.trim()}=${column.label.trim()}`).filter(Boolean);
    const rightColumns = right.columns.map((column) => `${column.id.trim()}=${column.label.trim()}`).filter(Boolean);
    return leftColumns.length === rightColumns.length && leftColumns.every((column, index) => column === rightColumns[index]);
  }

  if (left.kind === "mixed_field_block" && right.kind === "mixed_field_block") {
    const serializeItem = (item: (typeof left.items)[number]): string => {
      if (item.kind === "checkbox_enum") {
        return [
          item.kind,
          item.label.trim(),
          item.targetFieldName ?? "",
          item.checkedValueFieldName ?? "",
          item.selectMode ?? "",
          item.options.map((option) => option.label.trim()).join("|")
        ].join(":");
      }

      if (item.kind === "inline_field_group") {
        return [
          item.kind,
          item.label.trim(),
          item.fields.map((field) => `${field.label.trim()}=${field.fieldName}`).join("|")
        ].join(":");
      }

      if (item.kind === "text_field" || item.kind === "task_list") {
        return `${item.kind}:${item.label.trim()}:${item.targetFieldName ?? ""}`;
      }

      return `${item.kind}:${item.label.trim()}`;
    };
    const leftItems = left.items.map(serializeItem);
    const rightItems = right.items.map(serializeItem);
    return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index]);
  }

  if (left.kind === "repeatable_text" && right.kind === "repeatable_text") {
    const serializeSchemas = (schemas: typeof left.entrySchemas): string[] =>
      (schemas ?? []).map((schema) => `${schema.entryLabel ?? ""}:${schema.fieldNames.join("|")}`);
    const leftSchemas = serializeSchemas(left.entrySchemas);
    const rightSchemas = serializeSchemas(right.entrySchemas);
    return (
      left.parserId === right.parserId &&
      (left.entryLabel ?? "") === (right.entryLabel ?? "") &&
      left.allowSpokenWholeSourceFallback === right.allowSpokenWholeSourceFallback &&
      leftSchemas.length === rightSchemas.length &&
      leftSchemas.every((schema, index) => schema === rightSchemas[index])
    );
  }

  return true;
}

function isAutoLikeBehavior(behavior: TemplateSectionBehaviorConfig | undefined): boolean {
  if (!behavior) {
    return false;
  }

  if ((behavior.sourceAliases ?? []).length > 0) {
    return false;
  }

  switch (behavior.kind) {
    case "repeatable_text":
      return true;
    case "task_list":
      return true;
    case "field_block":
      return behavior.fields.every(
        (field) => (field.aliases ?? []).length === 0 && !field.inputKind
      );
    case "grouped_field_block":
      return (
        behavior.groups.every((group) => (group.aliases ?? []).length === 0 && !group.presenceFieldName) &&
        behavior.fields.every((field) => (field.aliases ?? []).length === 0 && !field.inputKind)
      );
    case "mixed_field_block":
      return behavior.items.every((item) => {
        if (item.kind === "static_note") {
          return true;
        }

        if (item.kind === "inline_field_group") {
          return item.fields.every((field) => (field.aliases ?? []).length === 0);
        }

        if (item.kind === "checkbox_enum") {
          return (item.aliases ?? []).length === 0 && item.options.every((option) => (option.aliases ?? []).length === 0);
        }

        return (item.aliases ?? []).length === 0;
      });
    default:
      return false;
  }
}

function reconcileBehavior(
  existing: TemplateSectionBehaviorConfig | undefined,
  inferred: TemplateSectionBehaviorConfig | undefined
): TemplateSectionBehaviorConfig | undefined {
  if (!existing) {
    return inferred;
  }

  if (!inferred) {
    return isAutoLikeBehavior(existing) ? undefined : existing;
  }

  if (!isAutoLikeBehavior(existing)) {
    return existing;
  }

  if (existing.kind !== inferred.kind) {
    return inferred;
  }

  if (existing.kind === "field_block" && !fieldBlockLabelsMatch(existing, inferred)) {
    return inferred;
  }

  if (!behaviorLabelsMatch(existing, inferred)) {
    return inferred;
  }

  return existing;
}

export class TemplateSectionConfigService {
  private readonly sectionScanner = new TemplateSectionScanner();
  private readonly templateScanner = new TemplateScanner();

  buildFromContent(
    content: string,
    existingSections: TemplateSectionConfig[] | undefined,
    rulePackConfig?: TemplateRulePackConfig,
    options?: BuildSectionConfigOptions
  ): TemplateSectionConfig[] | undefined {
    const scannedSections = this.sectionScanner.scan(content);
    const allTemplateFieldNames = this.templateScanner.scanFields(content).map((field) => field.name);
    if (scannedSections.length === 0) {
      return existingSections?.map((section) => cloneSection(section));
    }

    const existingById = new Map((existingSections ?? []).map((section) => [section.id, section] as const));
    const existingByTitle = new Map((existingSections ?? []).map((section) => [section.title, section] as const));

    const nextSections = scannedSections.map((section) => {
      const existing = existingById.get(section.id) ?? existingByTitle.get(section.title);
      const inferredBehavior = inferSectionBehavior({
        title: section.title,
        kind: section.kind,
        fieldNames: section.fieldNames,
        rawContent: section.rawContent,
        allTemplateFieldNames
      }, rulePackConfig);
      const nextBehavior = options?.resetRecognitionConfig
        ? inferredBehavior
        : reconcileBehavior(existing?.behavior, inferredBehavior);
      const inferredMode = resolveInferredSectionMode({
        title: section.title,
        kind: section.kind,
        fieldNames: section.fieldNames
      }, rulePackConfig);
      const mode = shouldPreserveExistingMode(existing) ? existing!.mode : inferredMode.mode;
      const modeSource = shouldPreserveExistingMode(existing)
        ? existing!.modeSource ?? "user"
        : inferredMode.modeSource;
      const nextSection = applyModeSource({
        id: section.id,
        title: section.title,
        mode,
        kind: section.kind,
        fieldNames: section.fieldNames,
        hasDataviewCode: section.hasDataviewCode,
        hasTemplaterCode: section.hasTemplaterCode,
        behavior: nextBehavior ? JSON.parse(JSON.stringify(nextBehavior)) : undefined
      }, modeSource, options);
      sectionRawContentById.set(nextSection, section.rawContent);
      return nextSection;
    });

    const rawContentBySectionId = new Map(
      nextSections.map((section) => [section.id, sectionRawContentById.get(section) ?? ""] as const)
    );
    const withGenericRules = applyGenericTemplateSectionRules(nextSections, rulePackConfig);
    return withGenericRules.map((section) => {
      const rawContent = rawContentBySectionId.get(section.id);
      if (rawContent !== undefined) {
        sectionRawContentById.set(section, rawContent);
      }
      const existing = existingById.get(section.id) ?? existingByTitle.get(section.title);
      if (!existing) {
        return section;
      }

      if (options?.resetRecognitionConfig) {
        return section;
      }

      if (!shouldPreserveExistingMode(existing)) {
        const mergedInferredSection = applyModeSource({
          ...section,
          behavior: reconcileBehavior(existing.behavior, section.behavior)
        }, section.modeSource ?? "inferred", options);
        if (rawContent !== undefined) {
          sectionRawContentById.set(mergedInferredSection, rawContent);
        }
        return mergedInferredSection;
      }

      const mergedSection = applyModeSource({
        ...section,
        mode: existing.mode,
        behavior: reconcileBehavior(existing.behavior, section.behavior)
      }, existing.modeSource ?? "user", options);
      if (rawContent !== undefined) {
        sectionRawContentById.set(mergedSection, rawContent);
      }
      return mergedSection;
    });
  }

  filterFields(
    fields: TemplateFieldContext | TemplateFieldConfig[],
    sectionConfig: TemplateConfig["sectionConfig"]
  ): TemplateFieldConfig[] {
    const currentFields = resolveTemplateFieldContextFields(fields);
    if (!sectionConfig || sectionConfig.length === 0) {
      return currentFields.map(cloneField);
    }

    const fieldSectionMap = new Map<string, Pick<TemplateSectionConfig, "kind" | "mode">>();
    const sectionManagedFieldNames = collectSectionManagedFieldNames(sectionConfig);
    sectionConfig.forEach((section) => {
      (section.fieldNames ?? []).forEach((fieldName) => {
        fieldSectionMap.set(fieldName, { kind: section.kind, mode: section.mode });
      });
    });

    return currentFields
      .filter((field) => {
        const fieldSection = fieldSectionMap.get(field.name);
        return (
          (
            fieldSection === undefined ||
            fieldSection.mode === "generate" ||
            (fieldSection.mode === "preserve" && fieldSection.kind === "inline_fields")
          ) &&
          !sectionManagedFieldNames.has(field.name)
        );
      })
      .map(cloneField);
  }

  getGenerateSections(
    sectionConfig: TemplateConfig["sectionConfig"]
  ): TemplateSectionConfig[] {
    return (sectionConfig ?? [])
      .filter((section) => section.mode === "generate")
      .map((section) => cloneSection(section));
  }

  getRepeatableEntryFieldNames(
    sectionConfig: TemplateConfig["sectionConfig"]
  ): Set<string> {
    const fieldNames = new Set<string>();
    this.getGenerateSections(sectionConfig)
      .filter((section) => {
        if (section.kind !== "repeatable_entries") {
          return false;
        }

        return true;
      })
      .forEach((section) => {
        (section.fieldNames ?? []).forEach((fieldName) => fieldNames.add(fieldName));
      });
    return fieldNames;
  }

  getInternalRepeatableEntryFieldNames(
    sectionConfig: TemplateConfig["sectionConfig"]
  ): Set<string> {
    const fieldNames = new Set<string>();
    this.getGenerateSections(sectionConfig)
      .filter(isInternalRepeatableEntrySection)
      .forEach((section) => {
        (section.fieldNames ?? []).forEach((fieldName) => fieldNames.add(fieldName));
      });
    return fieldNames;
  }

  filterSemanticConfig(
    semanticConfig: TemplateSemanticConfig | undefined,
    activeFields: TemplateFieldContext | TemplateFieldConfig[]
  ): TemplateSemanticConfig | undefined {
    const cloned = cloneSemanticConfig(semanticConfig);
    if (!cloned) {
      return undefined;
    }

    const activeFieldNames = isTemplateFieldContext(activeFields)
      ? new Set(activeFields.snapshot.reviewVisibleFieldNames)
      : new Set(resolveTemplateFieldContextFields(activeFields).map((field) => field.name));
    cloned.conceptFields = cloned.conceptFields
      .map((concept) => ({
        ...concept,
        aliases: [...concept.aliases],
        enumOptions: concept.enumOptions.map((option) => ({
          ...option,
          aliases: [...option.aliases]
        })),
        sourceHints: [...concept.sourceHints],
        renderTargets: concept.renderTargets.filter((target) => activeFieldNames.has(target.fieldName))
      }))
      .filter((concept) => concept.renderTargets.length > 0);

    if (cloned.conceptFields.length === 0 && !cloned.lastConfirmedAt?.trim()) {
      return undefined;
    }

    return cloned;
  }
}
