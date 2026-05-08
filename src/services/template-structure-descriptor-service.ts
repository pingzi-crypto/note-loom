import type {
  ConceptFieldConfig,
  TemplateConfig,
  TemplateFieldConfig,
  TemplateSectionBehaviorConfig,
  TemplateSectionConfig
} from "../types/template";
import type {
  FieldStructureDescriptor,
  FieldStructureFeature,
  SectionStructureDescriptor,
  SectionStructureFeature,
  StructureEvidence,
  TemplateStructureDescriptor,
  TemplateStructureFeature
} from "../types/template-structure-descriptor";
import { isBooleanLikeOptionSet } from "../utils/boolean-like-field";

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function nonEmpty(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function pushEvidence(target: StructureEvidence[], source: StructureEvidence["source"], detail: string): void {
  target.push({ source, detail });
}

function collectParserId(behavior: TemplateSectionBehaviorConfig | undefined): SectionStructureDescriptor["parserId"] {
  if (!behavior || behavior.kind !== "repeatable_text") {
    return undefined;
  }

  return behavior.parserId;
}

function collectRuntimePromptVariables(content: string): Set<string> {
  const variables = new Set<string>();
  const pattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tp\.system\.(?:prompt|suggester|multi_suggester)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const variableName = match[1]?.trim();
    if (variableName) {
      variables.add(variableName);
    }
  }
  return variables;
}

function collectRuntimeCandidateFieldNames(section: TemplateSectionConfig): string[] {
  const behavior = section.behavior;
  if (!behavior) {
    return nonEmpty(section.fieldNames);
  }

  if (behavior.kind === "field_block") {
    return nonEmpty([
      ...(section.fieldNames ?? []),
      ...behavior.fields.flatMap((field) => [field.id, field.label])
    ]);
  }

  if (behavior.kind === "grouped_field_block") {
    return nonEmpty([
      ...(section.fieldNames ?? []),
      ...behavior.fields.flatMap((field) => [field.id, field.label]),
      ...behavior.groups.map((group) => group.presenceFieldName ?? "")
    ]);
  }

  if (behavior.kind === "table_block") {
    return nonEmpty([
      ...(section.fieldNames ?? []),
      ...behavior.columns.flatMap((column) => [column.id, column.label])
    ]);
  }

  if (behavior.kind === "mixed_field_block") {
    return nonEmpty([
      ...(section.fieldNames ?? []),
      ...behavior.items.flatMap((item) => {
        if (item.kind === "static_note") {
          return [];
        }
        if (item.kind === "inline_field_group") {
          return item.fields.map((field) => field.fieldName);
        }
        return [item.targetFieldName ?? item.label];
      })
    ]);
  }

  return nonEmpty(section.fieldNames);
}

function buildRuntimeOwnedFieldMap(template: TemplateConfig): Map<string, string> {
  const result = new Map<string, string>();
  const sections = template.sectionConfig ?? [];
  const templateContent = (template as TemplateConfig & { rawContent?: string }).rawContent ?? "";
  const globalPromptVariables = collectRuntimePromptVariables(templateContent);
  sections.forEach((section) => {
    const rawContent = (section as TemplateSectionConfig & { rawContent?: string }).rawContent ?? "";
    const searchContent = rawContent.trim() ? rawContent : templateContent;
    if (!searchContent.trim()) {
      return;
    }

    const promptVariables = new Set([
      ...globalPromptVariables,
      ...collectRuntimePromptVariables(rawContent)
    ]);
    if (promptVariables.size === 0) {
      return;
    }

    collectRuntimeCandidateFieldNames(section).forEach((fieldName) => {
      const normalizedFieldName = fieldName.trim();
      if (!normalizedFieldName) {
        return;
      }

      const usesPromptVariable = Array.from(promptVariables).some((variableName) =>
        new RegExp(`<%[-_=]?\\s*${variableName}\\s*%>`, "u").test(searchContent)
      );
      if (usesPromptVariable) {
        result.set(normalizedFieldName, section.id);
      }
    });
  });
  return result;
}

function collectFieldFeatures(
  field: TemplateFieldConfig,
  semanticField: ConceptFieldConfig | undefined,
  runtimeOwnedBySectionId?: string
): {
  features: FieldStructureFeature[];
  evidence: StructureEvidence[];
} {
  const features: FieldStructureFeature[] = ["placeholder"];
  const evidence: StructureEvidence[] = [{ source: "template_syntax", detail: "field placeholder discovered" }];

  if (field.kind) {
    features.push(field.kind);
    pushEvidence(evidence, "field_config", `field kind: ${field.kind}`);
  }

  const checkboxOptions = nonEmpty(field.checkboxOptions);
  if (checkboxOptions.length > 0) {
    features.push("enum_options");
    pushEvidence(evidence, "field_options", "field has predefined options");
    if (isBooleanLikeOptionSet(checkboxOptions)) {
      features.push("boolean_like_options");
      pushEvidence(evidence, "field_options", "field options are boolean-like");
    }
  }

  if (field.normalizerKey) {
    features.push("explicit_normalizer");
    pushEvidence(evidence, "field_config", `explicit normalizer: ${field.normalizerKey}`);
  }

  if (nonEmpty(field.aliases).length > 0) {
    features.push("explicit_aliases");
    pushEvidence(evidence, "field_config", "explicit field aliases configured");
  }

  if (nonEmpty(field.semanticTriggers).length > 0) {
    features.push("explicit_semantic_triggers");
    pushEvidence(evidence, "field_config", "explicit semantic triggers configured");
  }

  if (semanticField && semanticField.renderTargets.length > 0) {
    features.push("semantic_render_targets");
    pushEvidence(evidence, "semantic_config", "field participates in structural mapping render targets");
  }

  if (runtimeOwnedBySectionId) {
    features.push("runtime_owned");
    pushEvidence(evidence, "template_syntax", `field value is provided by runtime prompt in section: ${runtimeOwnedBySectionId}`);
  }

  if (nonEmpty(field.frontmatterTargets).length > 0) {
    pushEvidence(evidence, "template_syntax", "field placeholder appears in frontmatter property value");
  }

  return {
    features: unique(features),
    evidence
  };
}

export function buildFieldStructureDescriptor(
  field: TemplateFieldConfig,
  semanticField: ConceptFieldConfig | undefined,
  runtimeOwnedBySectionId?: string
): FieldStructureDescriptor {
  const { features, evidence } = collectFieldFeatures(field, semanticField, runtimeOwnedBySectionId);
  const frontmatterTargets = nonEmpty(field.frontmatterTargets);
  return {
    fieldName: field.name,
    enabledByDefault: field.enabledByDefault,
    kind: field.kind,
    features,
    aliases: nonEmpty(field.aliases),
    semanticTriggers: nonEmpty(field.semanticTriggers),
    checkboxOptions: nonEmpty(field.checkboxOptions),
    ...(frontmatterTargets.length > 0 ? { frontmatterTargets } : {}),
    normalizerKey: field.normalizerKey,
    semanticValueType: semanticField?.valueType,
    renderTargetKinds: unique((semanticField?.renderTargets ?? []).map((target) => target.kind)),
    runtimeOwnedBySectionId,
    evidence
  };
}

export function fieldStructureDescriptorToConfig(field: FieldStructureDescriptor): TemplateFieldConfig {
  const frontmatterTargets = nonEmpty(field.frontmatterTargets);
  return {
    name: field.fieldName,
    aliases: [...field.aliases],
    enabledByDefault: field.enabledByDefault,
    kind: field.kind,
    normalizerKey: field.normalizerKey,
    semanticTriggers: [...field.semanticTriggers],
    checkboxOptions: [...field.checkboxOptions],
    ...(frontmatterTargets.length > 0 ? { frontmatterTargets } : {})
  };
}

export function templateStructureDescriptorFieldsToConfigs(
  descriptor: TemplateStructureDescriptor
): TemplateFieldConfig[] {
  return descriptor.fields.map(fieldStructureDescriptorToConfig);
}

function collectSectionFeatures(section: TemplateSectionConfig): {
  features: SectionStructureFeature[];
  evidence: StructureEvidence[];
} {
  const features: SectionStructureFeature[] = [section.kind];
  const evidence: StructureEvidence[] = [{ source: "section_config", detail: `section kind: ${section.kind}` }];

  if (section.hasDataviewCode) {
    features.push("dataview_code");
    pushEvidence(evidence, "section_config", "section contains Dataview code");
  }

  if (section.hasTemplaterCode) {
    features.push("templater_code");
    pushEvidence(evidence, "section_config", "section contains Templater code");
  }

  if ((section.fieldNames ?? []).length > 0) {
    features.push("managed_fields");
    pushEvidence(evidence, "section_config", "section declares managed fields");
  }

  if (section.behavior) {
    features.push("behavior_config");
    pushEvidence(evidence, "section_behavior", `section behavior: ${section.behavior.kind}`);
  }

  const parserId = collectParserId(section.behavior);
  if (parserId) {
    features.push("parser_route");
    pushEvidence(evidence, "section_behavior", `parser route: ${parserId}`);
  }

  return {
    features: unique(features),
    evidence
  };
}

function collectSectionBehaviorStructure(section: TemplateSectionConfig): {
  behaviorFieldNames: string[];
  groupNames: string[];
  mixedItemKinds: string[];
  evidence: StructureEvidence[];
} {
  const behavior = section.behavior;
  const evidence: StructureEvidence[] = [];
  if (!behavior) {
    return {
      behaviorFieldNames: [],
      groupNames: [],
      mixedItemKinds: [],
      evidence
    };
  }

  if (behavior.kind === "field_block") {
    const behaviorFieldNames = nonEmpty(behavior.fields.map((field) => field.label));
    if (behaviorFieldNames.length > 0) {
      pushEvidence(evidence, "section_behavior", `field block fields: ${behaviorFieldNames.join(", ")}`);
    }
    return {
      behaviorFieldNames,
      groupNames: [],
      mixedItemKinds: [],
      evidence
    };
  }

  if (behavior.kind === "grouped_field_block") {
    const behaviorFieldNames = nonEmpty([
      ...behavior.fields.map((field) => field.label),
      ...behavior.groups.map((group) => group.presenceFieldName ?? "")
    ]);
    const groupNames = nonEmpty(behavior.groups.map((group) => group.label));
    if (behaviorFieldNames.length > 0) {
      pushEvidence(evidence, "section_behavior", `grouped block fields: ${behaviorFieldNames.join(", ")}`);
    }
    if (groupNames.length > 0) {
      pushEvidence(evidence, "section_behavior", `grouped block groups: ${groupNames.join(", ")}`);
    }
    return {
      behaviorFieldNames,
      groupNames,
      mixedItemKinds: [],
      evidence
    };
  }

  if (behavior.kind === "table_block") {
    const behaviorFieldNames = nonEmpty(behavior.columns.map((column) => column.label));
    if (behaviorFieldNames.length > 0) {
      pushEvidence(evidence, "section_behavior", `table columns: ${behaviorFieldNames.join(", ")}`);
    }
    return {
      behaviorFieldNames,
      groupNames: [],
      mixedItemKinds: [],
      evidence
    };
  }

  if (behavior.kind === "mixed_field_block") {
    const mixedItemKinds = unique(behavior.items.map((item) => item.kind));
    const behaviorFieldNames = nonEmpty(
      behavior.items.flatMap((item) => {
        if (item.kind === "static_note") {
          return [];
        }
        if (item.kind === "inline_field_group") {
          return item.fields.map((field) => field.fieldName);
        }
        return [item.targetFieldName ?? item.label];
      })
    );
    if (behaviorFieldNames.length > 0) {
      pushEvidence(evidence, "section_behavior", `mixed block targets: ${behaviorFieldNames.join(", ")}`);
    }
    if (mixedItemKinds.length > 0) {
      pushEvidence(evidence, "section_behavior", `mixed block item kinds: ${mixedItemKinds.join(", ")}`);
    }
    return {
      behaviorFieldNames,
      groupNames: [],
      mixedItemKinds,
      evidence
    };
  }

  return {
    behaviorFieldNames: [],
    groupNames: [],
    mixedItemKinds: [],
    evidence
  };
}

export function buildSectionStructureDescriptor(section: TemplateSectionConfig): SectionStructureDescriptor {
  const { features, evidence } = collectSectionFeatures(section);
  const parserId = collectParserId(section.behavior);
  const behaviorStructure = collectSectionBehaviorStructure(section);
  return {
    id: section.id,
    title: section.title,
    kind: section.kind,
    mode: section.mode,
    features,
    fieldNames: nonEmpty(section.fieldNames),
    behaviorKind: section.behavior?.kind,
    parserId,
    behaviorFieldNames: unique(behaviorStructure.behaviorFieldNames),
    groupNames: unique(behaviorStructure.groupNames),
    mixedItemKinds: unique(behaviorStructure.mixedItemKinds),
    evidence: [...evidence, ...behaviorStructure.evidence]
  };
}

function collectTemplateFeatures(template: TemplateConfig): {
  features: TemplateStructureFeature[];
  evidence: StructureEvidence[];
} {
  const features: TemplateStructureFeature[] = ["body_placeholders"];
  const evidence: StructureEvidence[] = [{ source: "template_syntax", detail: "template has configured fields" }];

  if (template.fields.some((field) => field.kind === "inline_field")) {
    features.push("inline_field_targets");
    pushEvidence(evidence, "field_config", "template has inline field targets");
  }

  if (template.fields.some((field) => field.kind === "checkbox_group")) {
    features.push("checkbox_group_targets");
    pushEvidence(evidence, "field_config", "template has checkbox group targets");
  }

  if ((template.sectionConfig ?? []).some((section) => section.mode === "generate")) {
    features.push("section_generation");
    pushEvidence(evidence, "section_config", "template has generated sections");
  }

  const renderTargetKinds = new Set(
    (template.semanticConfig?.conceptFields ?? [])
      .flatMap((field) => field.renderTargets)
      .map((target) => target.kind)
  );
  if (renderTargetKinds.has("frontmatter")) {
    features.push("frontmatter_targets");
    pushEvidence(evidence, "semantic_config", "structural mapping writes frontmatter targets");
  }

  if ((template.semanticConfig?.conceptFields ?? []).length > 0) {
    features.push("semantic_mapping");
    pushEvidence(evidence, "semantic_config", "template has structural mapping config");
  }

  if (template.rulePackConfig) {
    features.push("rule_pack_overrides");
    pushEvidence(evidence, "rule_pack_config", "template has explicit rule pack config");
  }

  return {
    features: unique(features),
    evidence
  };
}

export class TemplateStructureDescriptorService {
  build(template: TemplateConfig): TemplateStructureDescriptor {
    const semanticFieldsByLabel = new Map(
      (template.semanticConfig?.conceptFields ?? []).map((field) => [field.label, field] as const)
    );
    const { features, evidence } = collectTemplateFeatures(template);
    const runtimeOwnedFields = buildRuntimeOwnedFieldMap(template);

    return {
      version: 1,
      templateId: template.id,
      templateName: template.name,
      templatePath: template.path,
      features,
      fields: template.fields.map((field) =>
        buildFieldStructureDescriptor(
          field,
          semanticFieldsByLabel.get(field.name),
          runtimeOwnedFields.get(field.name.trim())
        )
      ),
      sections: (template.sectionConfig ?? []).map(buildSectionStructureDescriptor),
      evidence
    };
  }
}
