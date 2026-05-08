export type TemplateFieldKind = "text" | "inline_field" | "checkbox_group";
export type ConceptValueType = "text" | "date" | "enum" | "boolean" | "link" | "list";
export type RenderTargetKind = TemplateFieldKind | "frontmatter" | "wiki_link";
export type TemplateIndexStrategy = "inherit" | "disabled";
export type TemplateRulePackOverrideMode = "merge" | "replace" | "disable";
export type TemplateSectionMode = "generate" | "preserve" | "ignore";
export type TemplateSectionModeSource = "inferred" | "rule" | "user";
export type TemplateSectionKind =
  | "content_block"
  | "inline_fields"
  | "repeatable_entries"
  | "computed_block"
  | "mixed";
export type TemplateSectionOverrideMode = "append" | "replace";
export type TemplateSectionParserId =
  | "repeatable_inline_fields"
  | "repeatable_lines_cleanup"
  | "generic_inline_fields";
export type TemplateSectionBehaviorKind =
  | "repeatable_text"
  | "task_list"
  | "field_block"
  | "grouped_field_block"
  | "table_block"
  | "mixed_field_block";
export type TemplateSectionBehaviorRuleId = "table" | "mixed" | "grouped" | "field" | "task";
export type TemplateSectionBoundaryStrictness = "loose" | "structural" | "strict";
export type TemplateSectionBoundaryTruncationStrategy =
  | "field-value"
  | "section-block"
  | "table-cell"
  | "frontmatter-short-value";

export interface TemplateSectionBoundaryPolicyConfig {
  strictness?: TemplateSectionBoundaryStrictness;
  allowTightLabels?: boolean;
  allowMarkdownHeadings?: boolean;
  allowInlineFallback?: boolean;
  truncationStrategy?: TemplateSectionBoundaryTruncationStrategy;
}

export interface TemplateSectionBehaviorFieldConfig {
  id: string;
  label: string;
  aliases?: string[];
  inputKind?: "text" | "textarea";
}

export interface TemplateSectionBehaviorGroupConfig {
  id: string;
  label: string;
  aliases?: string[];
  presenceFieldName?: string;
}

export interface TemplateSectionRepeatableEntrySchemaConfig {
  entryLabel?: string;
  fieldNames: string[];
}

export interface TemplateSectionRepeatableBehaviorConfig {
  kind: "repeatable_text";
  sourceAliases?: string[];
  parserId?: TemplateSectionParserId;
  entryLabel?: string;
  entrySchemas?: TemplateSectionRepeatableEntrySchemaConfig[];
  allowSpokenWholeSourceFallback?: boolean;
  overrideMode?: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export interface TemplateSectionTaskListBehaviorConfig {
  kind: "task_list";
  sourceAliases?: string[];
  taskPrefix?: string;
  overrideMode?: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export interface TemplateSectionFieldBlockBehaviorConfig {
  kind: "field_block";
  sourceAliases?: string[];
  fields: TemplateSectionBehaviorFieldConfig[];
  fallbackFieldId?: string;
  linePrefix?: string;
  separator?: string;
  overrideMode?: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export interface TemplateSectionGroupedFieldBlockBehaviorConfig {
  kind: "grouped_field_block";
  sourceAliases?: string[];
  groups: TemplateSectionBehaviorGroupConfig[];
  fields: TemplateSectionBehaviorFieldConfig[];
  fallbackFieldId?: string;
  groupHeadingPrefix?: string;
  linePrefix?: string;
  separator?: string;
  overrideMode?: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export interface TemplateSectionTableBlockBehaviorConfig {
  kind: "table_block";
  sourceAliases?: string[];
  columns: TemplateSectionBehaviorFieldConfig[];
  overrideMode?: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export type TemplateSectionMixedFieldBlockItemKind =
  | "text_field"
  | "inline_field_group"
  | "checkbox_enum"
  | "task_list"
  | "static_note";

export interface TemplateSectionMixedFieldBlockOptionConfig {
  id: string;
  label: string;
  value: string;
  aliases?: string[];
}

export interface TemplateSectionMixedFieldBlockFieldConfig {
  id: string;
  label: string;
  fieldName: string;
  aliases?: string[];
}

export interface TemplateSectionMixedFieldBlockTextItemConfig {
  id: string;
  kind: "text_field";
  label: string;
  aliases?: string[];
  targetFieldName?: string;
  inputKind?: "text" | "textarea";
}

export interface TemplateSectionMixedFieldBlockInlineFieldGroupItemConfig {
  id: string;
  kind: "inline_field_group";
  label: string;
  aliases?: string[];
  fields: TemplateSectionMixedFieldBlockFieldConfig[];
}

export interface TemplateSectionMixedFieldBlockCheckboxEnumItemConfig {
  id: string;
  kind: "checkbox_enum";
  label: string;
  aliases?: string[];
  targetFieldName?: string;
  checkedValueFieldName?: string;
  selectMode?: "single" | "multi";
  options: TemplateSectionMixedFieldBlockOptionConfig[];
}

export interface TemplateSectionMixedFieldBlockTaskListItemConfig {
  id: string;
  kind: "task_list";
  label: string;
  aliases?: string[];
  targetFieldName?: string;
  taskPrefix?: string;
}

export interface TemplateSectionMixedFieldBlockStaticNoteItemConfig {
  id: string;
  kind: "static_note";
  label: string;
  content?: string;
}

export type TemplateSectionMixedFieldBlockItemConfig =
  | TemplateSectionMixedFieldBlockTextItemConfig
  | TemplateSectionMixedFieldBlockInlineFieldGroupItemConfig
  | TemplateSectionMixedFieldBlockCheckboxEnumItemConfig
  | TemplateSectionMixedFieldBlockTaskListItemConfig
  | TemplateSectionMixedFieldBlockStaticNoteItemConfig;

export interface TemplateSectionMixedFieldBlockBehaviorConfig {
  kind: "mixed_field_block";
  sourceAliases?: string[];
  items: TemplateSectionMixedFieldBlockItemConfig[];
  overrideMode?: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export type TemplateSectionBehaviorConfig =
  | TemplateSectionRepeatableBehaviorConfig
  | TemplateSectionTaskListBehaviorConfig
  | TemplateSectionFieldBlockBehaviorConfig
  | TemplateSectionGroupedFieldBlockBehaviorConfig
  | TemplateSectionTableBlockBehaviorConfig
  | TemplateSectionMixedFieldBlockBehaviorConfig;

export interface TemplateFieldConfig {
  name: string;
  aliases: string[];
  enabledByDefault: boolean;
  kind?: TemplateFieldKind;
  normalizerKey?: string;
  semanticTriggers?: string[];
  checkboxOptions?: string[];
  frontmatterTargets?: string[];
}

export interface EnumOptionConfig {
  label: string;
  normalizedValue: string;
  aliases: string[];
}

export interface RenderTargetRef {
  id: string;
  fieldName: string;
  kind: RenderTargetKind;
  required: boolean;
}

export interface ConceptFieldConfig {
  id: string;
  label: string;
  aliases: string[];
  valueType: ConceptValueType;
  required: boolean;
  enumOptions: EnumOptionConfig[];
  sourceHints: string[];
  renderTargets: RenderTargetRef[];
}

export interface TemplateSemanticConfig {
  version: number;
  conceptFields: ConceptFieldConfig[];
  lastConfirmedAt?: string;
}

export interface TemplateFieldAliasPackOverride {
  fieldName: string;
  aliases?: string[];
  semanticTriggers?: string[];
  mode?: TemplateRulePackOverrideMode;
}

export interface TemplateFieldOptionPackOverride {
  fieldName: string;
  options?: string[];
  fieldKind?: "checkbox_group";
  normalizerKey?: string;
  mode?: TemplateRulePackOverrideMode;
}

export interface TemplateSectionEnrichPackFieldPatch {
  label: string;
  aliases?: string[];
  inputKind?: "text" | "textarea";
}

export interface TemplateSectionEnrichPackGroupPatch {
  label: string;
  aliases?: string[];
  presenceFieldName?: string;
}

export interface TemplateSectionEnrichPackOverride {
  sectionKey: string;
  behaviorKind: TemplateSectionBehaviorKind;
  sourceAliases?: string[];
  fieldPatches?: TemplateSectionEnrichPackFieldPatch[];
  groupPatches?: TemplateSectionEnrichPackGroupPatch[];
  mode?: TemplateRulePackOverrideMode;
}

export interface TemplateSectionStructureToggles {
  futurePlanningIgnore?: boolean;
  futurePlanningSection?: boolean;
  repeatableParserRoute?: boolean;
}

export interface TemplateSectionStructureOverride {
  sectionTitle?: string;
  sectionKind?: TemplateSectionKind;
  toggles: TemplateSectionStructureToggles;
}

export interface TemplateSectionBehaviorOrderOverride {
  sectionTitle?: string;
  sectionKind?: TemplateSectionKind;
  ruleOrder: TemplateSectionBehaviorRuleId[];
}

export interface TemplateRepeatableParserRouteOverride {
  sectionTitle?: string;
  sectionKind?: TemplateSectionKind;
  parserId: TemplateSectionParserId;
  sourceAliases?: string[];
  overrideMode?: TemplateSectionOverrideMode;
  mode?: TemplateRulePackOverrideMode;
}

export interface TemplateRulePackConfig {
  enabledPackIds?: string[];
  disabledPackIds?: string[];
  fieldAliasOverrides?: TemplateFieldAliasPackOverride[];
  fieldOptionOverrides?: TemplateFieldOptionPackOverride[];
  sectionEnrichOverrides?: TemplateSectionEnrichPackOverride[];
  repeatableParserRouteOverrides?: TemplateRepeatableParserRouteOverride[];
  sectionBehaviorRuleOrder?: TemplateSectionBehaviorRuleId[];
  sectionBehaviorOrderOverrides?: TemplateSectionBehaviorOrderOverride[];
  sectionStructureToggles?: TemplateSectionStructureToggles;
  sectionStructureOverrides?: TemplateSectionStructureOverride[];
}

export type BuiltInRulePackKind = "field_alias" | "field_options" | "section_enrich";

export interface BuiltInRulePack {
  id: string;
  label: string;
  kind: BuiltInRulePackKind;
  enabledByDefault: boolean;
}

export interface BuiltInFieldAliasPackEntry {
  fieldName: string;
  aliases?: string[];
  semanticTriggers?: string[];
}

export interface BuiltInFieldAliasPack extends BuiltInRulePack {
  kind: "field_alias";
  entries: BuiltInFieldAliasPackEntry[];
}

export interface BuiltInFieldOptionPackEntry {
  fieldName: string;
  options?: string[];
  fieldKind?: "checkbox_group";
  normalizerKey?: string;
}

export interface BuiltInFieldOptionPack extends BuiltInRulePack {
  kind: "field_options";
  entries: BuiltInFieldOptionPackEntry[];
}

export interface BuiltInSectionEnrichPackEntry {
  sectionKey: string;
  behaviorKind: TemplateSectionBehaviorKind;
  sourceAliases?: string[];
  fieldPatches?: TemplateSectionEnrichPackFieldPatch[];
  groupPatches?: TemplateSectionEnrichPackGroupPatch[];
}

export interface BuiltInSectionEnrichPack extends BuiltInRulePack {
  kind: "section_enrich";
  entries: BuiltInSectionEnrichPackEntry[];
}

export type BuiltInTemplateRulePack =
  | BuiltInFieldAliasPack
  | BuiltInFieldOptionPack
  | BuiltInSectionEnrichPack;

export interface TemplateSectionConfig {
  id: string;
  title: string;
  mode: TemplateSectionMode;
  modeSource?: TemplateSectionModeSource;
  kind: TemplateSectionKind;
  fieldNames?: string[];
  hasDataviewCode?: boolean;
  hasTemplaterCode?: boolean;
  behavior?: TemplateSectionBehaviorConfig;
}

// Internal aliases while the persisted structural mapping key remains semanticConfig.
// Product/UI copy should call this the structural mapping layer.
export type StructuralMappingValueType = ConceptValueType;
export type StructuralMappingFieldConfig = ConceptFieldConfig;
export type StructuralMappingConfig = TemplateSemanticConfig;

export interface TemplateConfig {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  defaultOutputPath: string;
  defaultIndexStrategy: TemplateIndexStrategy;
  defaultIndexNotePath: string;
  filenameField: string;
  fields: TemplateFieldConfig[];
  // Persisted under semanticConfig until the next schema migration renames it.
  // Product/UI copy should refer to this as the structural mapping layer.
  semanticConfig?: TemplateSemanticConfig;
  rulePackConfig?: TemplateRulePackConfig;
  // Optional section-level generation config. When absent, section-specific
  // extraction is simply not enabled for this template.
  sectionConfig?: TemplateSectionConfig[];
}

export interface ScannedTemplateField {
  name: string;
  order: number;
  kind?: TemplateFieldKind;
  aliases?: string[];
  checkboxOptions?: string[];
  frontmatterTargets?: string[];
}

export interface ScannedTemplateSection {
  id: string;
  title: string;
  startLine: number;
  endLine: number;
  rawContent: string;
  hasDataviewCode: boolean;
  hasTemplaterCode: boolean;
  hasInlineFields: boolean;
  hasListEntries: boolean;
  fieldNames: string[];
  kind: TemplateSectionKind;
  suggestedMode: TemplateSectionMode;
}
