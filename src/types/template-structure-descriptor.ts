import type {
  ConceptValueType,
  TemplateFieldKind,
  TemplateSectionBehaviorKind,
  TemplateSectionKind,
  TemplateSectionMode,
  TemplateSectionParserId
} from "./template";

export type TemplateStructureDescriptorVersion = 1;

export type StructureEvidenceSource =
  | "template_syntax"
  | "field_config"
  | "field_options"
  | "section_config"
  | "section_behavior"
  | "semantic_config"
  | "rule_pack_config";

export interface StructureEvidence {
  source: StructureEvidenceSource;
  detail: string;
}

export type FieldStructureFeature =
  | "placeholder"
  | "text"
  | "inline_field"
  | "checkbox_group"
  | "boolean_like_options"
  | "enum_options"
  | "explicit_normalizer"
  | "explicit_aliases"
  | "explicit_semantic_triggers"
  | "semantic_render_targets"
  | "runtime_owned";

export interface FieldStructureDescriptor {
  fieldName: string;
  enabledByDefault: boolean;
  kind?: TemplateFieldKind;
  features: FieldStructureFeature[];
  aliases: string[];
  semanticTriggers: string[];
  checkboxOptions: string[];
  frontmatterTargets?: string[];
  normalizerKey?: string;
  semanticValueType?: ConceptValueType;
  renderTargetKinds: string[];
  runtimeOwnedBySectionId?: string;
  evidence: StructureEvidence[];
}

export type SectionStructureFeature =
  | "content_block"
  | "dataview_code"
  | "templater_code"
  | "managed_fields"
  | "behavior_config"
  | "parser_route"
  | "repeatable_entries"
  | "inline_fields"
  | "computed_block"
  | "mixed";

export interface SectionStructureDescriptor {
  id: string;
  title: string;
  kind: TemplateSectionKind;
  mode: TemplateSectionMode;
  features: SectionStructureFeature[];
  fieldNames: string[];
  behaviorKind?: TemplateSectionBehaviorKind;
  parserId?: TemplateSectionParserId;
  behaviorFieldNames: string[];
  groupNames: string[];
  mixedItemKinds: string[];
  evidence: StructureEvidence[];
}

export type TemplateStructureFeature =
  | "frontmatter_targets"
  | "body_placeholders"
  | "inline_field_targets"
  | "checkbox_group_targets"
  | "section_generation"
  | "semantic_mapping"
  | "rule_pack_overrides";

export interface TemplateStructureDescriptor {
  version: TemplateStructureDescriptorVersion;
  templateId: string;
  templateName: string;
  templatePath: string;
  features: TemplateStructureFeature[];
  fields: FieldStructureDescriptor[];
  sections: SectionStructureDescriptor[];
  evidence: StructureEvidence[];
}
