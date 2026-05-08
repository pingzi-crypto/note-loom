import type { Plugin } from "obsidian";

import { CURRENT_SETTINGS_SCHEMA_VERSION, DEFAULT_SETTINGS } from "../constants";
import type { ManagedIndexEntryRecord, PluginSettings } from "../types/settings";
import type {
  ConceptFieldConfig,
  ConceptValueType,
  EnumOptionConfig,
  RenderTargetKind,
  RenderTargetRef,
  TemplateConfig,
  TemplateFieldConfig,
  TemplateFieldAliasPackOverride,
  TemplateFieldOptionPackOverride,
  TemplateIndexStrategy,
  TemplateRulePackConfig,
  TemplateRulePackOverrideMode,
  TemplateRepeatableParserRouteOverride,
  TemplateSectionBoundaryPolicyConfig,
  TemplateSectionBehaviorConfig,
  TemplateSectionBehaviorOrderOverride,
  TemplateSectionBehaviorRuleId,
  TemplateSectionBehaviorFieldConfig,
  TemplateSectionBehaviorGroupConfig,
  TemplateSectionBehaviorKind,
  TemplateSectionStructureOverride,
  TemplateSectionStructureToggles,
  TemplateSectionParserId,
  TemplateSectionEnrichPackFieldPatch,
  TemplateSectionEnrichPackGroupPatch,
  TemplateSectionEnrichPackOverride,
  TemplateSectionMixedFieldBlockFieldConfig,
  TemplateSectionMixedFieldBlockItemConfig,
  TemplateSectionMixedFieldBlockOptionConfig,
  TemplateSectionConfig,
  TemplateSectionKind,
  TemplateSectionMode,
  TemplateSectionModeSource,
  TemplateSemanticConfig
} from "../types/template";
import { normalizePathCompatible } from "../utils/path-normalizer";
import { createTemplateId } from "../utils/template-id";
import {
  isRegisteredTemplateSectionParserId,
  isTemplateSectionParserAllowedForBehavior
} from "./template-section-parser-registry";
import { resolveTemplateFieldsFromScan } from "./template-field-state-service";

type PersistedSectionStructureToggles = Partial<TemplateSectionStructureToggles>;

type PersistedSectionStructureOverride = Partial<Omit<TemplateSectionStructureOverride, "toggles">> & {
  toggles?: PersistedSectionStructureToggles;
};

type PersistedTemplateRulePackConfig = Partial<Omit<TemplateRulePackConfig, "sectionStructureToggles" | "sectionStructureOverrides">> & {
  sectionStructureToggles?: PersistedSectionStructureToggles;
  sectionStructureOverrides?: PersistedSectionStructureOverride[];
  sectionCompatibilityToggles?: PersistedSectionStructureToggles;
  sectionCompatibilityOverrides?: PersistedSectionStructureOverride[];
};

const LEGACY_REPEATABLE_PARSER_ID_MAP: Record<string, TemplateSectionParserId> = {
  time_range_inline_fields: "repeatable_inline_fields",
  time_audit_ledger: "repeatable_inline_fields"
};

function normalizeTemplateSectionParserId(value: unknown): TemplateSectionParserId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const mappedLegacyParserId = LEGACY_REPEATABLE_PARSER_ID_MAP[value];
  if (mappedLegacyParserId) {
    return mappedLegacyParserId;
  }

  return isRegisteredTemplateSectionParserId(value) ? value : undefined;
}

function cloneSettings(settings: PluginSettings): PluginSettings {
  return JSON.parse(JSON.stringify(settings)) as PluginSettings;
}

function readSettingsSchemaVersion(input: unknown): number | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = (input as { schemaVersion?: unknown }).schemaVersion;
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function shouldResetSettingsForUnsupportedSchema(input: unknown): boolean {
  const version = readSettingsSchemaVersion(input);
  return version !== undefined && (version < 1 || version > CURRENT_SETTINGS_SCHEMA_VERSION);
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

function normalizeOptionalStringArray(values: unknown): string[] | undefined {
  return Array.isArray(values) ? normalizeStringArray(values) : undefined;
}

function normalizeFieldConfig(field: Partial<TemplateFieldConfig> | undefined): TemplateFieldConfig {
  const frontmatterTargets = normalizeStringArray(field?.frontmatterTargets);
  return {
    name: field?.name?.trim() ?? "",
    aliases: normalizeStringArray(field?.aliases),
    enabledByDefault: field?.enabledByDefault ?? true,
    kind: field?.kind ?? "text",
    normalizerKey: field?.normalizerKey?.trim() || undefined,
    semanticTriggers: normalizeStringArray(field?.semanticTriggers),
    checkboxOptions: normalizeStringArray(field?.checkboxOptions),
    ...(frontmatterTargets.length > 0 ? { frontmatterTargets } : {})
  };
}

function normalizeConceptValueType(value: unknown): ConceptValueType {
  return value === "date" ||
    value === "enum" ||
    value === "boolean" ||
    value === "link" ||
    value === "list" ||
    value === "text"
    ? value
    : "text";
}

function normalizeRenderTargetKind(value: unknown): RenderTargetKind {
  return value === "inline_field" ||
    value === "checkbox_group" ||
    value === "frontmatter" ||
    value === "wiki_link" ||
    value === "text"
    ? value
    : "text";
}

function normalizeEnumOption(option: Partial<EnumOptionConfig> | undefined): EnumOptionConfig | null {
  const label = option?.label?.trim() ?? "";
  const normalizedValue = option?.normalizedValue?.trim() ?? "";

  if (!label || !normalizedValue) {
    return null;
  }

  return {
    label,
    normalizedValue,
    aliases: normalizeStringArray(option?.aliases)
  };
}

function normalizeRenderTarget(target: Partial<RenderTargetRef> | undefined): RenderTargetRef | null {
  const fieldName = target?.fieldName?.trim() ?? "";
  if (!fieldName) {
    return null;
  }

  return {
    id: target?.id?.trim() || fieldName,
    fieldName,
    kind: normalizeRenderTargetKind(target?.kind),
    required: target?.required ?? true
  };
}

function normalizeConceptField(field: Partial<ConceptFieldConfig> | undefined): ConceptFieldConfig | null {
  const label = field?.label?.trim() ?? "";
  if (!label) {
    return null;
  }

  const enumOptions = Array.isArray(field?.enumOptions)
    ? field.enumOptions
        .map((option) => normalizeEnumOption(option))
        .filter((option): option is EnumOptionConfig => option !== null)
    : [];
  const renderTargets = Array.isArray(field?.renderTargets)
    ? field.renderTargets
        .map((target) => normalizeRenderTarget(target))
        .filter((target): target is RenderTargetRef => target !== null)
    : [];

  return {
    id: field?.id?.trim() || label,
    label,
    aliases: normalizeStringArray(field?.aliases),
    valueType: normalizeConceptValueType(field?.valueType),
    required: field?.required ?? true,
    enumOptions,
    sourceHints: normalizeStringArray(field?.sourceHints),
    renderTargets
  };
}

function normalizeSemanticConfig(
  semanticConfig: Partial<TemplateSemanticConfig> | undefined
): TemplateSemanticConfig | undefined {
  if (!semanticConfig) {
    return undefined;
  }

  const normalizedConceptFields = Array.isArray(semanticConfig.conceptFields)
    ? semanticConfig.conceptFields
        .map((field) => normalizeConceptField(field))
        .filter((field): field is ConceptFieldConfig => field !== null)
    : [];

  const uniqueConceptFieldIds = new Set<string>();
  const conceptFields = normalizedConceptFields.map((field, index) => {
    let nextId = field.id;
    if (uniqueConceptFieldIds.has(nextId)) {
      nextId = `${field.label}-${index + 1}`;
    }

    uniqueConceptFieldIds.add(nextId);
    return {
      ...field,
      id: nextId
    };
  });

  if (conceptFields.length === 0 && !semanticConfig.lastConfirmedAt?.trim()) {
    return undefined;
  }

  return {
    version:
      typeof semanticConfig.version === "number" && Number.isFinite(semanticConfig.version)
        ? Math.max(1, Math.floor(semanticConfig.version))
        : 1,
    conceptFields,
    lastConfirmedAt: semanticConfig.lastConfirmedAt?.trim() || undefined
  };
}

function normalizeTemplateSectionMode(value: unknown): TemplateSectionMode {
  return value === "generate" || value === "preserve" || value === "ignore"
    ? value
    : "generate";
}

function normalizeTemplateSectionModeSource(
  value: unknown,
  hasPersistedMode: boolean
): TemplateSectionModeSource {
  if (value === "inferred" || value === "rule" || value === "user") {
    return value;
  }

  // v3 and older data only stored the final mode. Treat that as a user-held
  // decision so upgrades never silently reopen sections someone had closed.
  return hasPersistedMode ? "user" : "inferred";
}

function normalizeTemplateRulePackOverrideMode(value: unknown): TemplateRulePackOverrideMode | undefined {
  return value === "merge" || value === "replace" || value === "disable"
    ? value
    : undefined;
}

function normalizeTemplateSectionBehaviorKind(value: unknown): TemplateSectionBehaviorKind | undefined {
  return value === "repeatable_text" ||
    value === "task_list" ||
    value === "field_block" ||
    value === "grouped_field_block" ||
    value === "table_block" ||
    value === "mixed_field_block"
    ? value
    : undefined;
}

function normalizeRulePackStringArray(values: unknown): string[] | undefined {
  const normalized = Array.from(
    new Set(normalizeStringArray(values))
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSectionBehaviorRuleOrder(values: unknown): TemplateSectionBehaviorRuleId[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const allowed = new Set<TemplateSectionBehaviorRuleId>(["table", "mixed", "grouped", "field", "task"]);
  const normalized = Array.from(
    new Set(
      values
        .map((value) => String(value).trim())
        .filter((value): value is TemplateSectionBehaviorRuleId => allowed.has(value as TemplateSectionBehaviorRuleId))
    )
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSectionBehaviorOrderOverride(
  override: Partial<TemplateSectionBehaviorOrderOverride> | undefined
): TemplateSectionBehaviorOrderOverride | null {
  if (!override || typeof override !== "object") {
    return null;
  }

  const sectionTitle = override.sectionTitle?.trim() || undefined;
  const sectionKind = normalizeTemplateSectionKindOptional(override.sectionKind);
  const ruleOrder = normalizeSectionBehaviorRuleOrder(override.ruleOrder);
  if (!sectionTitle && !sectionKind) {
    return null;
  }
  if (!ruleOrder?.length) {
    return null;
  }

  return {
    sectionTitle,
    sectionKind,
    ruleOrder
  };
}

function normalizeSectionStructureToggles(
  toggles: PersistedSectionStructureToggles | undefined
): TemplateSectionStructureToggles | undefined {
  if (!toggles || typeof toggles !== "object") {
    return undefined;
  }

  const futurePlanningIgnore =
    typeof toggles.futurePlanningIgnore === "boolean" ? toggles.futurePlanningIgnore : undefined;
  const futurePlanningSection =
    typeof toggles.futurePlanningSection === "boolean" ? toggles.futurePlanningSection : undefined;
  const repeatableParserRoute =
    typeof toggles.repeatableParserRoute === "boolean" ? toggles.repeatableParserRoute : undefined;

  if (futurePlanningIgnore === undefined && futurePlanningSection === undefined && repeatableParserRoute === undefined) {
    return undefined;
  }

  return {
    futurePlanningIgnore,
    futurePlanningSection,
    repeatableParserRoute
  };
}

function normalizeTemplateSectionKindOptional(value: unknown): TemplateSectionKind | undefined {
  return value === "content_block" ||
    value === "inline_fields" ||
    value === "repeatable_entries" ||
    value === "computed_block" ||
    value === "mixed"
    ? value
    : undefined;
}

function normalizeSectionStructureOverride(
  override: PersistedSectionStructureOverride | undefined
): TemplateSectionStructureOverride | null {
  if (!override || typeof override !== "object") {
    return null;
  }

  const sectionTitle = override.sectionTitle?.trim() || undefined;
  const sectionKind = normalizeTemplateSectionKindOptional(override.sectionKind);
  const toggles = normalizeSectionStructureToggles(override.toggles);

  if (!sectionTitle && !sectionKind) {
    return null;
  }

  if (!toggles) {
    return null;
  }

  return {
    sectionTitle,
    sectionKind,
    toggles
  };
}

function normalizeTemplateSectionOverrideMode(value: unknown): "append" | "replace" | undefined {
  return value === "append" || value === "replace" ? value : undefined;
}

function normalizeRepeatableParserRouteOverride(
  override: Partial<TemplateRepeatableParserRouteOverride> | undefined
): TemplateRepeatableParserRouteOverride | null {
  if (!override || typeof override !== "object") {
    return null;
  }

  const sectionTitle = override.sectionTitle?.trim() || undefined;
  const sectionKind = normalizeTemplateSectionKindOptional(override.sectionKind);
  const parserId = normalizeTemplateSectionParserId(override.parserId);
  const sourceAliases = normalizeRulePackStringArray(override.sourceAliases);
  const overrideMode = normalizeTemplateSectionOverrideMode(override.overrideMode);
  const mode = normalizeTemplateRulePackOverrideMode(override.mode);

  if (!sectionTitle && !sectionKind) {
    return null;
  }

  if (!parserId || mode === "merge") {
    return null;
  }

  return {
    sectionTitle,
    sectionKind,
    parserId,
    sourceAliases,
    overrideMode,
    mode
  };
}

function normalizeFieldAliasPackOverride(
  override: Partial<TemplateFieldAliasPackOverride> | undefined
): TemplateFieldAliasPackOverride | null {
  const fieldName = override?.fieldName?.trim() ?? "";
  if (!fieldName) {
    return null;
  }

  const aliases = normalizeRulePackStringArray(override?.aliases);
  const semanticTriggers = normalizeRulePackStringArray(override?.semanticTriggers);
  const mode = normalizeTemplateRulePackOverrideMode(override?.mode);

  if (!aliases && !semanticTriggers && !mode) {
    return null;
  }

  return {
    fieldName,
    aliases,
    semanticTriggers,
    mode
  };
}

function normalizeFieldOptionPackOverride(
  override: Partial<TemplateFieldOptionPackOverride> | undefined
): TemplateFieldOptionPackOverride | null {
  const fieldName = override?.fieldName?.trim() ?? "";
  if (!fieldName) {
    return null;
  }

  const options = normalizeRulePackStringArray(override?.options);
  const mode = normalizeTemplateRulePackOverrideMode(override?.mode);
  const fieldKind = override?.fieldKind === "checkbox_group" ? "checkbox_group" : undefined;
  const normalizerKey = override?.normalizerKey?.trim() || undefined;

  if (!options && !mode && !fieldKind && !normalizerKey) {
    return null;
  }

  return {
    fieldName,
    options,
    fieldKind,
    normalizerKey,
    mode
  };
}

function normalizeSectionEnrichFieldPatch(
  patch: Partial<TemplateSectionEnrichPackFieldPatch> | undefined
): TemplateSectionEnrichPackFieldPatch | null {
  const label = patch?.label?.trim() ?? "";
  if (!label) {
    return null;
  }

  return {
    label,
    aliases: normalizeRulePackStringArray(patch?.aliases),
    inputKind: patch?.inputKind === "text" || patch?.inputKind === "textarea" ? patch.inputKind : undefined
  };
}

function normalizeSectionEnrichGroupPatch(
  patch: Partial<TemplateSectionEnrichPackGroupPatch> | undefined
): TemplateSectionEnrichPackGroupPatch | null {
  const label = patch?.label?.trim() ?? "";
  if (!label) {
    return null;
  }

  return {
    label,
    aliases: normalizeRulePackStringArray(patch?.aliases),
    presenceFieldName: patch?.presenceFieldName?.trim() || undefined
  };
}

function normalizeSectionEnrichPackOverride(
  override: Partial<TemplateSectionEnrichPackOverride> | undefined
): TemplateSectionEnrichPackOverride | null {
  const sectionKey = override?.sectionKey?.trim() ?? "";
  const behaviorKind = normalizeTemplateSectionBehaviorKind(override?.behaviorKind);
  if (!sectionKey || !behaviorKind) {
    return null;
  }

  const sourceAliases = normalizeRulePackStringArray(override?.sourceAliases);
  const fieldPatches = Array.isArray(override?.fieldPatches)
    ? override.fieldPatches
        .map((patch) => normalizeSectionEnrichFieldPatch(patch))
        .filter((patch): patch is TemplateSectionEnrichPackFieldPatch => patch !== null)
    : undefined;
  const groupPatches = Array.isArray(override?.groupPatches)
    ? override.groupPatches
        .map((patch) => normalizeSectionEnrichGroupPatch(patch))
        .filter((patch): patch is TemplateSectionEnrichPackGroupPatch => patch !== null)
    : undefined;
  const mode = normalizeTemplateRulePackOverrideMode(override?.mode);

  if (!sourceAliases && !fieldPatches?.length && !groupPatches?.length && !mode) {
    return null;
  }

  return {
    sectionKey,
    behaviorKind,
    sourceAliases,
    fieldPatches: fieldPatches && fieldPatches.length > 0 ? fieldPatches : undefined,
    groupPatches: groupPatches && groupPatches.length > 0 ? groupPatches : undefined,
    mode
  };
}

export function normalizeTemplateRulePackConfig(
  config: Partial<TemplateRulePackConfig> | undefined
): TemplateRulePackConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const persistedConfig = config as PersistedTemplateRulePackConfig;

  const enabledPackIds = normalizeRulePackStringArray(config.enabledPackIds);
  const disabledPackIds = normalizeRulePackStringArray(config.disabledPackIds);
  const fieldAliasOverrides = Array.isArray(config.fieldAliasOverrides)
    ? config.fieldAliasOverrides
        .map((override) => normalizeFieldAliasPackOverride(override))
        .filter((override): override is TemplateFieldAliasPackOverride => override !== null)
    : undefined;
  const fieldOptionOverrides = Array.isArray(config.fieldOptionOverrides)
    ? config.fieldOptionOverrides
        .map((override) => normalizeFieldOptionPackOverride(override))
        .filter((override): override is TemplateFieldOptionPackOverride => override !== null)
    : undefined;
  const sectionBehaviorRuleOrder = normalizeSectionBehaviorRuleOrder(config.sectionBehaviorRuleOrder);
  const sectionBehaviorOrderOverrides = Array.isArray(config.sectionBehaviorOrderOverrides)
    ? config.sectionBehaviorOrderOverrides
        .map((override) => normalizeSectionBehaviorOrderOverride(override))
        .filter((override): override is TemplateSectionBehaviorOrderOverride => override !== null)
    : undefined;
  const sectionStructureToggles = normalizeSectionStructureToggles(
    persistedConfig.sectionStructureToggles ?? persistedConfig.sectionCompatibilityToggles
  );
  const sectionStructureOverridesInput =
    persistedConfig.sectionStructureOverrides ?? persistedConfig.sectionCompatibilityOverrides;
  const sectionStructureOverrides = Array.isArray(sectionStructureOverridesInput)
    ? sectionStructureOverridesInput
        .map((override) => normalizeSectionStructureOverride(override))
        .filter((override): override is TemplateSectionStructureOverride => override !== null)
    : undefined;
  const repeatableParserRouteOverrides = Array.isArray(config.repeatableParserRouteOverrides)
    ? config.repeatableParserRouteOverrides
        .map((override) => normalizeRepeatableParserRouteOverride(override))
        .filter((override): override is TemplateRepeatableParserRouteOverride => override !== null)
    : undefined;
  const sectionEnrichOverrides = Array.isArray(config.sectionEnrichOverrides)
    ? config.sectionEnrichOverrides
        .map((override) => normalizeSectionEnrichPackOverride(override))
        .filter((override): override is TemplateSectionEnrichPackOverride => override !== null)
    : undefined;

  if (
    !enabledPackIds &&
    !disabledPackIds &&
    !fieldAliasOverrides?.length &&
    !fieldOptionOverrides?.length &&
    !sectionBehaviorRuleOrder?.length &&
    !sectionBehaviorOrderOverrides?.length &&
    !sectionStructureToggles &&
    !sectionStructureOverrides?.length &&
    !repeatableParserRouteOverrides?.length &&
    !sectionEnrichOverrides?.length
  ) {
    return undefined;
  }

  return {
    enabledPackIds,
    disabledPackIds,
    fieldAliasOverrides: fieldAliasOverrides && fieldAliasOverrides.length > 0 ? fieldAliasOverrides : undefined,
    fieldOptionOverrides: fieldOptionOverrides && fieldOptionOverrides.length > 0 ? fieldOptionOverrides : undefined,
    sectionBehaviorRuleOrder:
      sectionBehaviorRuleOrder && sectionBehaviorRuleOrder.length > 0 ? sectionBehaviorRuleOrder : undefined,
    sectionBehaviorOrderOverrides:
      sectionBehaviorOrderOverrides && sectionBehaviorOrderOverrides.length > 0
        ? sectionBehaviorOrderOverrides
        : undefined,
    sectionStructureToggles,
    sectionStructureOverrides:
      sectionStructureOverrides && sectionStructureOverrides.length > 0
        ? sectionStructureOverrides
        : undefined,
    repeatableParserRouteOverrides:
      repeatableParserRouteOverrides && repeatableParserRouteOverrides.length > 0
        ? repeatableParserRouteOverrides
        : undefined,
    sectionEnrichOverrides:
      sectionEnrichOverrides && sectionEnrichOverrides.length > 0 ? sectionEnrichOverrides : undefined
  };
}

function normalizeTemplateSectionKind(value: unknown): TemplateSectionKind {
  return value === "content_block" ||
    value === "inline_fields" ||
    value === "repeatable_entries" ||
    value === "computed_block" ||
    value === "mixed"
    ? value
    : "content_block";
}

function normalizeSectionBehaviorField(
  field: Partial<TemplateSectionBehaviorFieldConfig> | undefined
): TemplateSectionBehaviorFieldConfig | null {
  const id = field?.id?.trim() ?? "";
  const label = field?.label?.trim() ?? "";
  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    aliases: normalizeOptionalStringArray(field?.aliases),
    inputKind: field?.inputKind === "text" ? "text" : undefined
  };
}

function normalizeSectionBehaviorGroup(
  group: Partial<TemplateSectionBehaviorGroupConfig> | undefined
): TemplateSectionBehaviorGroupConfig | null {
  const id = group?.id?.trim() ?? "";
  const label = group?.label?.trim() ?? "";
  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    aliases: normalizeOptionalStringArray(group?.aliases),
    presenceFieldName: group?.presenceFieldName?.trim() || undefined
  };
}

function normalizeMixedFieldBlockField(
  field: Partial<TemplateSectionMixedFieldBlockFieldConfig> | undefined
): TemplateSectionMixedFieldBlockFieldConfig | null {
  const id = field?.id?.trim() ?? "";
  const label = field?.label?.trim() ?? "";
  const fieldName = field?.fieldName?.trim() ?? "";
  if (!id || !label || !fieldName) {
    return null;
  }

  return {
    id,
    label,
    fieldName,
    aliases: normalizeOptionalStringArray(field?.aliases)
  };
}

function normalizeMixedFieldBlockOption(
  option: Partial<TemplateSectionMixedFieldBlockOptionConfig> | undefined
): TemplateSectionMixedFieldBlockOptionConfig | null {
  const id = option?.id?.trim() ?? "";
  const label = option?.label?.trim() ?? "";
  const value = option?.value?.trim() ?? "";
  if (!id || !label || !value) {
    return null;
  }

  return {
    id,
    label,
    value,
    aliases: normalizeOptionalStringArray(option?.aliases)
  };
}

function normalizeMixedFieldBlockItem(
  item: Partial<TemplateSectionMixedFieldBlockItemConfig> | undefined
): TemplateSectionMixedFieldBlockItemConfig | null {
  const id = item?.id?.trim() ?? "";
  const label = item?.label?.trim() ?? "";
  if (!id || !label) {
    return null;
  }

  const aliases = normalizeOptionalStringArray((item as { aliases?: unknown[] } | undefined)?.aliases);

  if (item?.kind === "text_field") {
    const textItem = item as Partial<Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "text_field" }>>;
    return {
      id,
      kind: "text_field",
      label,
      aliases,
      targetFieldName: textItem.targetFieldName?.trim() || undefined,
      inputKind: textItem.inputKind === "text" ? "text" : undefined
    };
  }

  if (item?.kind === "inline_field_group") {
    const inlineGroupItem =
      item as Partial<Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "inline_field_group" }>>;
    const fields = Array.isArray(inlineGroupItem.fields)
      ? inlineGroupItem.fields
          .map((field) => normalizeMixedFieldBlockField(field))
          .filter((field): field is TemplateSectionMixedFieldBlockFieldConfig => field !== null)
      : [];
    if (fields.length === 0) {
      return null;
    }

    return {
      id,
      kind: "inline_field_group",
      label,
      aliases,
      fields
    };
  }

  if (item?.kind === "checkbox_enum") {
    const checkboxItem =
      item as Partial<Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "checkbox_enum" }>>;
    const options = Array.isArray(checkboxItem.options)
      ? checkboxItem.options
          .map((option) => normalizeMixedFieldBlockOption(option))
          .filter((option): option is TemplateSectionMixedFieldBlockOptionConfig => option !== null)
      : [];
    if (options.length === 0) {
      return null;
    }

    return {
      id,
      kind: "checkbox_enum",
      label,
      aliases,
      targetFieldName: checkboxItem.targetFieldName?.trim() || undefined,
      selectMode: checkboxItem.selectMode === "multi" ? "multi" : "single",
      options
    };
  }

  if (item?.kind === "task_list") {
    const taskItem = item as Partial<Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }>>;
    return {
      id,
      kind: "task_list",
      label,
      aliases,
      targetFieldName: taskItem.targetFieldName?.trim() || undefined,
      taskPrefix: taskItem.taskPrefix?.trim() || undefined
    };
  }

  if (item?.kind === "static_note") {
    const staticItem = item as Partial<Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "static_note" }>>;
    return {
      id,
      kind: "static_note",
      label,
      content: staticItem.content?.trim() || undefined
    };
  }

  return null;
}

function normalizeTemplateSectionBehavior(
  behavior: Partial<TemplateSectionBehaviorConfig> | undefined
): TemplateSectionBehaviorConfig | undefined {
  if (!behavior || typeof behavior !== "object") {
    return undefined;
  }

  const sourceAliases = normalizeOptionalStringArray(behavior.sourceAliases);
  const overrideMode = behavior.overrideMode === "replace" ? "replace" : "append";
  const boundaryPolicy = normalizeSectionBoundaryPolicy(behavior.boundaryPolicy);

  if (behavior.kind === "repeatable_text") {
    const parserId = normalizeTemplateSectionParserId(behavior.parserId);
    const entrySchemas = Array.isArray(behavior.entrySchemas)
      ? behavior.entrySchemas
          .map((schema) => {
            const fieldNames = normalizeOptionalStringArray(schema?.fieldNames) ?? [];
            return {
              entryLabel: schema?.entryLabel?.trim() || undefined,
              fieldNames
            };
          })
          .filter((schema) => schema.fieldNames.length > 0)
      : undefined;
    return {
      kind: "repeatable_text",
      sourceAliases,
      parserId: parserId &&
        isTemplateSectionParserAllowedForBehavior(parserId, "repeatable_text")
        ? parserId
        : undefined,
      entryLabel: behavior.entryLabel?.trim() || undefined,
      entrySchemas: entrySchemas && entrySchemas.length > 0 ? entrySchemas : undefined,
      allowSpokenWholeSourceFallback: behavior.allowSpokenWholeSourceFallback === true ? true : undefined,
      overrideMode,
      boundaryPolicy
    };
  }

  if (behavior.kind === "task_list") {
    return {
      kind: "task_list",
      sourceAliases,
      taskPrefix: behavior.taskPrefix?.trim() || undefined,
      overrideMode,
      boundaryPolicy
    };
  }

  if (behavior.kind === "field_block") {
    const fields = Array.isArray(behavior.fields)
      ? behavior.fields
          .map((field) => normalizeSectionBehaviorField(field))
          .filter((field): field is TemplateSectionBehaviorFieldConfig => field !== null)
      : [];
    if (fields.length === 0) {
      return undefined;
    }

    const fallbackFieldId = behavior.fallbackFieldId?.trim() ?? "";
    return {
      kind: "field_block",
      sourceAliases,
      fields,
      fallbackFieldId: fields.some((field) => field.id === fallbackFieldId) ? fallbackFieldId : undefined,
      linePrefix: behavior.linePrefix?.trim() || undefined,
      separator: behavior.separator?.trim() || undefined,
      overrideMode: "replace",
      boundaryPolicy
    };
  }

  if (behavior.kind === "table_block") {
    const columns = Array.isArray(behavior.columns)
      ? behavior.columns
          .map((field) => normalizeSectionBehaviorField(field))
          .filter((field): field is TemplateSectionBehaviorFieldConfig => field !== null)
      : [];
    if (columns.length === 0) {
      return undefined;
    }

    return {
      kind: "table_block",
      sourceAliases,
      columns,
      overrideMode: "replace",
      boundaryPolicy
    };
  }

  if (behavior.kind === "grouped_field_block") {
    const groups = Array.isArray(behavior.groups)
      ? behavior.groups
          .map((group) => normalizeSectionBehaviorGroup(group))
          .filter((group): group is TemplateSectionBehaviorGroupConfig => group !== null)
      : [];
    const fields = Array.isArray(behavior.fields)
      ? behavior.fields
          .map((field) => normalizeSectionBehaviorField(field))
          .filter((field): field is TemplateSectionBehaviorFieldConfig => field !== null)
      : [];
    if (groups.length === 0 || fields.length === 0) {
      return undefined;
    }

    const fallbackFieldId = behavior.fallbackFieldId?.trim() ?? "";
    return {
      kind: "grouped_field_block",
      sourceAliases,
      groups,
      fields,
      fallbackFieldId: fields.some((field) => field.id === fallbackFieldId) ? fallbackFieldId : undefined,
      groupHeadingPrefix: behavior.groupHeadingPrefix?.trim() || undefined,
      linePrefix: behavior.linePrefix?.trim() || undefined,
      separator: behavior.separator?.trim() || undefined,
      overrideMode: "replace",
      boundaryPolicy
    };
  }

  if (behavior.kind === "mixed_field_block") {
    const items = Array.isArray(behavior.items)
      ? behavior.items
          .map((item) => normalizeMixedFieldBlockItem(item))
          .filter((item): item is TemplateSectionMixedFieldBlockItemConfig => item !== null)
      : [];
    if (items.length === 0) {
      return undefined;
    }

    return {
      kind: "mixed_field_block",
      sourceAliases,
      items,
      overrideMode: "replace",
      boundaryPolicy
    };
  }

  return undefined;
}

function normalizeSectionBoundaryPolicy(value: unknown): TemplateSectionBoundaryPolicyConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as TemplateSectionBoundaryPolicyConfig;
  const policy: TemplateSectionBoundaryPolicyConfig = {};
  if (input.strictness === "loose" || input.strictness === "structural" || input.strictness === "strict") {
    policy.strictness = input.strictness;
  }
  if (typeof input.allowTightLabels === "boolean") {
    policy.allowTightLabels = input.allowTightLabels;
  }
  if (typeof input.allowMarkdownHeadings === "boolean") {
    policy.allowMarkdownHeadings = input.allowMarkdownHeadings;
  }
  if (typeof input.allowInlineFallback === "boolean") {
    policy.allowInlineFallback = input.allowInlineFallback;
  }
  if (
    input.truncationStrategy === "field-value" ||
    input.truncationStrategy === "section-block" ||
    input.truncationStrategy === "table-cell" ||
    input.truncationStrategy === "frontmatter-short-value"
  ) {
    policy.truncationStrategy = input.truncationStrategy;
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizeTemplateSection(
  section: Partial<TemplateSectionConfig> | undefined
): TemplateSectionConfig | null {
  const title = section?.title?.trim() ?? "";
  if (!title) {
    return null;
  }

  return {
    id: section?.id?.trim() || title,
    title,
    mode: normalizeTemplateSectionMode(section?.mode),
    modeSource: normalizeTemplateSectionModeSource(
      section?.modeSource,
      section?.mode === "generate" || section?.mode === "preserve" || section?.mode === "ignore"
    ),
    kind: normalizeTemplateSectionKind(section?.kind),
    fieldNames: normalizeOptionalStringArray(section?.fieldNames),
    hasDataviewCode: section?.hasDataviewCode ?? undefined,
    hasTemplaterCode: section?.hasTemplaterCode ?? undefined,
    behavior: normalizeTemplateSectionBehavior(section?.behavior)
  };
}

function normalizeTemplateConfig(template: Partial<TemplateConfig> | undefined): TemplateConfig {
  const normalizedSectionConfig = Array.isArray(template?.sectionConfig)
    ? template.sectionConfig
        .map((section) => normalizeTemplateSection(section))
        .filter((section): section is TemplateSectionConfig => section !== null)
    : undefined;
  const normalizedFields = Array.isArray(template?.fields)
    ? template.fields
        .map((field) => normalizeFieldConfig(field))
        .filter((field) => field.name.length > 0)
    : [];
  const normalizedPath = template?.path ? normalizePathCompatible(template.path) : "";
  const defaultIndexStrategy = normalizeTemplateIndexStrategy(template?.defaultIndexStrategy);
  const normalizedSemanticConfig = normalizeSemanticConfig(template?.semanticConfig);
  const normalizedRulePackConfig = normalizeTemplateRulePackConfig(template?.rulePackConfig);
  const scannedFieldsFromSavedConfig = normalizedFields.map((field, order) => ({
    name: field.name,
    order,
    kind: field.kind,
    checkboxOptions: field.checkboxOptions
  }));
  const resolvedFields = resolveTemplateFieldsFromScan(
    scannedFieldsFromSavedConfig,
    normalizedFields,
    normalizedSectionConfig,
    normalizedSemanticConfig,
    normalizedRulePackConfig
  );

  return {
    id: template?.id?.trim() || (normalizedPath ? createTemplateId(normalizedPath) : ""),
    name: template?.name?.trim() ?? "",
    path: normalizedPath,
    enabled: template?.enabled ?? true,
    defaultOutputPath: template?.defaultOutputPath?.trim() ?? "",
    defaultIndexStrategy,
    defaultIndexNotePath: "",
    filenameField: template?.filenameField?.trim() ?? DEFAULT_SETTINGS.defaultFilenameField,
    fields: resolvedFields,
    semanticConfig: normalizedSemanticConfig,
    rulePackConfig: normalizedRulePackConfig,
    sectionConfig: normalizedSectionConfig
  };
}

function normalizeTemplateIndexStrategy(
  strategy: unknown
): TemplateIndexStrategy {
  if (strategy === "inherit" || strategy === "disabled") {
    return strategy;
  }

  return "inherit";
}

function normalizeLanguage(language: unknown): PluginSettings["language"] {
  if (language === "zh" || language === "en" || language === "auto") {
    return language;
  }

  return DEFAULT_SETTINGS.language;
}

function normalizeManagedIndexEntry(
  entry: Partial<ManagedIndexEntryRecord> | undefined
): ManagedIndexEntryRecord | null {
  const createdNotePath = entry?.createdNotePath
    ? normalizePathCompatible(entry.createdNotePath)
    : "";
  const indexNotePath = entry?.indexNotePath ? normalizePathCompatible(entry.indexNotePath) : "";
  const sourceNotePath = entry?.sourceNotePath ? normalizePathCompatible(entry.sourceNotePath) : "";

  if (!createdNotePath || !indexNotePath || !sourceNotePath) {
    return null;
  }

  return {
    createdNotePath,
    indexNotePath,
    sourceNotePath
  };
}

export function normalizeSettings(input: unknown): PluginSettings {
  if (shouldResetSettingsForUnsupportedSchema(input)) {
    return cloneSettings(DEFAULT_SETTINGS);
  }

  const loaded = (input ?? {}) as Partial<PluginSettings>;
  const normalizedTemplates: TemplateConfig[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const normalizedManagedIndexEntries: ManagedIndexEntryRecord[] = [];
  const managedIndexEntryKeys = new Set<string>();

  if (Array.isArray(loaded.templates)) {
    for (const templateInput of loaded.templates) {
      const template = normalizeTemplateConfig(templateInput);
      if (template.path.length === 0 || seenPaths.has(template.path)) {
        continue;
      }

      let templateId = template.id || createTemplateId(template.path);
      if (seenIds.has(templateId)) {
        templateId = createTemplateId(template.path);
      }

      seenIds.add(templateId);
      seenPaths.add(template.path);
      normalizedTemplates.push({
        ...template,
        id: templateId
      });
    }
  }

  if (Array.isArray(loaded.managedIndexEntries)) {
    for (const entryInput of loaded.managedIndexEntries) {
      const entry = normalizeManagedIndexEntry(entryInput);
      if (!entry) {
        continue;
      }

      const key = `${entry.createdNotePath}::${entry.indexNotePath}`;
      if (managedIndexEntryKeys.has(key)) {
        continue;
      }

      managedIndexEntryKeys.add(key);
      normalizedManagedIndexEntries.push(entry);
    }
  }

  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    language: normalizeLanguage(loaded.language),
    templateRootFolder: loaded.templateRootFolder?.trim() ?? DEFAULT_SETTINGS.templateRootFolder,
    templates: normalizedTemplates,
    defaultOutputPath: loaded.defaultOutputPath?.trim() ?? DEFAULT_SETTINGS.defaultOutputPath,
    defaultIndexNotePath:
      loaded.defaultIndexNotePath?.trim() ?? DEFAULT_SETTINGS.defaultIndexNotePath,
    defaultFilenameField:
      loaded.defaultFilenameField?.trim() ?? DEFAULT_SETTINGS.defaultFilenameField,
    writeSourceMetadata: loaded.writeSourceMetadata ?? DEFAULT_SETTINGS.writeSourceMetadata,
    writeIndexEntry: loaded.writeIndexEntry ?? DEFAULT_SETTINGS.writeIndexEntry,
    openGeneratedNote: loaded.openGeneratedNote ?? DEFAULT_SETTINGS.openGeneratedNote,
    enableAliasMatching: loaded.enableAliasMatching ?? DEFAULT_SETTINGS.enableAliasMatching,
    unmatchedFieldsStartEnabled:
      loaded.unmatchedFieldsStartEnabled ?? DEFAULT_SETTINGS.unmatchedFieldsStartEnabled,
    showRibbonIcon: loaded.showRibbonIcon ?? DEFAULT_SETTINGS.showRibbonIcon,
    diagnosticsEnabled: loaded.diagnosticsEnabled ?? DEFAULT_SETTINGS.diagnosticsEnabled,
    managedIndexEntries: normalizedManagedIndexEntries
  };
}

export class SettingsService {
  private settings: PluginSettings = cloneSettings(DEFAULT_SETTINGS);
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<PluginSettings> {
    const loaded = await this.plugin.loadData();
    this.settings = normalizeSettings(loaded);
    if (readSettingsSchemaVersion(loaded) !== CURRENT_SETTINGS_SCHEMA_VERSION) {
      await this.plugin.saveData(this.settings);
    }
    return this.getSettings();
  }

  getSettings(): PluginSettings {
    return cloneSettings(this.settings);
  }

  getTemplate(templateId: string): TemplateConfig | undefined {
    const found = this.settings.templates.find((template) => template.id === templateId);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  }

  async save(settings: PluginSettings): Promise<void> {
    this.settings = normalizeSettings(settings);
    const snapshot = cloneSettings(this.settings);
    this.saveQueue = this.saveQueue.then(
      () => this.plugin.saveData(snapshot),
      () => this.plugin.saveData(snapshot)
    );
    await this.saveQueue;
  }

  async update(mutator: (settings: PluginSettings) => void): Promise<PluginSettings> {
    const nextSettings = this.getSettings();
    mutator(nextSettings);
    await this.save(nextSettings);
    return this.getSettings();
  }

  async addTemplates(templates: TemplateConfig[]): Promise<PluginSettings> {
    return this.update((settings) => {
      const existingPaths = new Set(
        settings.templates.map((template) => normalizePathCompatible(template.path))
      );

      for (const template of templates) {
        const normalizedTemplate = normalizeTemplateConfig(template);
        const normalizedPath = normalizePathCompatible(normalizedTemplate.path);

        if (!normalizedTemplate.id || !normalizedPath || existingPaths.has(normalizedPath)) {
          continue;
        }

        settings.templates.push(normalizedTemplate);
        existingPaths.add(normalizedPath);
      }
    });
  }

  async upsertTemplate(template: TemplateConfig): Promise<PluginSettings> {
    return this.update((settings) => {
      const normalizedTemplate = normalizeTemplateConfig(template);
      const index = settings.templates.findIndex((item) => item.id === normalizedTemplate.id);

      if (index >= 0) {
        settings.templates[index] = normalizedTemplate;
        return;
      }

      settings.templates.push(normalizedTemplate);
    });
  }

  async replaceTemplatePath(oldPath: string, newPath: string): Promise<PluginSettings> {
    return this.update((settings) => {
      const normalizedOldPath = normalizePathCompatible(oldPath);
      const normalizedNewPath = normalizePathCompatible(newPath);
      const renamedIndex = settings.templates.findIndex(
        (template) => normalizePathCompatible(template.path) === normalizedOldPath
      );

      if (renamedIndex < 0) {
        return;
      }

      const existingTemplate = settings.templates[renamedIndex]!;
      const renamedTemplate = normalizeTemplateConfig({
        ...existingTemplate,
        name: normalizedNewPath.split("/").pop()?.replace(/\.md$/i, "") || existingTemplate.name,
        path: normalizedNewPath
      });

      settings.templates = settings.templates.filter((template, index) => {
        if (index === renamedIndex) {
          return false;
        }

        return normalizePathCompatible(template.path) !== normalizedNewPath;
      });
      settings.templates.push(renamedTemplate);
    });
  }

  async removeTemplate(templateId: string): Promise<PluginSettings> {
    return this.update((settings) => {
      settings.templates = settings.templates.filter((template) => template.id !== templateId);
    });
  }

  getManagedIndexEntriesForCreatedNote(createdNotePath: string): ManagedIndexEntryRecord[] {
    const normalizedPath = normalizePathCompatible(createdNotePath);
    return this.settings.managedIndexEntries
      .filter((entry) => entry.createdNotePath === normalizedPath)
      .map((entry) => ({ ...entry }));
  }

  async upsertManagedIndexEntry(entry: ManagedIndexEntryRecord): Promise<PluginSettings> {
    return this.update((settings) => {
      const normalizedEntry = normalizeManagedIndexEntry(entry);
      if (!normalizedEntry) {
        return;
      }

      settings.managedIndexEntries = settings.managedIndexEntries.filter(
        (item) =>
          !(
            item.createdNotePath === normalizedEntry.createdNotePath &&
            item.indexNotePath === normalizedEntry.indexNotePath
          )
      );
      settings.managedIndexEntries.push(normalizedEntry);
    });
  }

  async removeManagedIndexEntriesForCreatedNote(createdNotePath: string): Promise<PluginSettings> {
    return this.update((settings) => {
      const normalizedPath = normalizePathCompatible(createdNotePath);
      settings.managedIndexEntries = settings.managedIndexEntries.filter(
        (entry) => entry.createdNotePath !== normalizedPath
      );
    });
  }

  async replaceManagedIndexPath(oldPath: string, newPath: string): Promise<PluginSettings> {
    return this.update((settings) => {
      const normalizedOldPath = normalizePathCompatible(oldPath);
      const normalizedNewPath = normalizePathCompatible(newPath);

      settings.managedIndexEntries = settings.managedIndexEntries.map((entry) => ({
        ...entry,
        createdNotePath:
          entry.createdNotePath === normalizedOldPath ? normalizedNewPath : entry.createdNotePath,
        indexNotePath:
          entry.indexNotePath === normalizedOldPath ? normalizedNewPath : entry.indexNotePath,
        sourceNotePath:
          entry.sourceNotePath === normalizedOldPath ? normalizedNewPath : entry.sourceNotePath
      }));
    });
  }
}
