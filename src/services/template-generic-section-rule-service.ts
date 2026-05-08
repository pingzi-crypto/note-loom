import type {
  TemplateSectionBehaviorConfig,
  TemplateSectionBehaviorFieldConfig,
  TemplateSectionBehaviorGroupConfig,
  TemplateSectionConfig,
  TemplateRulePackConfig
} from "../types/template";
import { resolveBuiltInSectionEnrichPackEntry } from "./template-rule-pack-service";

function cloneSection(section: TemplateSectionConfig): TemplateSectionConfig {
  return {
    ...section,
    fieldNames: section.fieldNames ? [...section.fieldNames] : undefined,
    behavior: section.behavior ? JSON.parse(JSON.stringify(section.behavior)) : undefined
  };
}

function mergeAliases(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  const merged = Array.from(
    new Set([...(existing ?? []), ...(incoming ?? [])].map((value) => value.trim()).filter(Boolean))
  );
  return merged.length > 0 ? merged : undefined;
}

function toFieldPatchMap(
  patches: Array<Partial<TemplateSectionBehaviorFieldConfig> & { label: string }> | undefined
): Record<string, Partial<TemplateSectionBehaviorFieldConfig>> {
  return Object.fromEntries((patches ?? []).map((patch) => [patch.label.trim(), patch]));
}

function toGroupPatchMap(
  patches: Array<Partial<TemplateSectionBehaviorGroupConfig> & { label: string }> | undefined
): Record<string, Partial<TemplateSectionBehaviorGroupConfig>> {
  return Object.fromEntries((patches ?? []).map((patch) => [patch.label.trim(), patch]));
}

function enrichFieldDefinition(
  field: TemplateSectionBehaviorFieldConfig,
  patches: Record<string, Partial<TemplateSectionBehaviorFieldConfig>>
): TemplateSectionBehaviorFieldConfig {
  const patch = patches[field.label.trim()];
  if (!patch) {
    return JSON.parse(JSON.stringify(field)) as TemplateSectionBehaviorFieldConfig;
  }

  return {
    ...field,
    ...(mergeAliases(field.aliases, patch.aliases) ? { aliases: mergeAliases(field.aliases, patch.aliases) } : {}),
    ...(patch.inputKind ?? field.inputKind ? { inputKind: patch.inputKind ?? field.inputKind } : {})
  };
}

function enrichGroupDefinition(
  group: TemplateSectionBehaviorGroupConfig,
  patches: Record<string, Partial<TemplateSectionBehaviorGroupConfig>>
): TemplateSectionBehaviorGroupConfig {
  const patch = patches[group.label.trim()];
  if (!patch) {
    return JSON.parse(JSON.stringify(group)) as TemplateSectionBehaviorGroupConfig;
  }

  return {
    ...group,
    ...(mergeAliases(group.aliases, patch.aliases) ? { aliases: mergeAliases(group.aliases, patch.aliases) } : {}),
    ...(patch.presenceFieldName ?? group.presenceFieldName
      ? { presenceFieldName: patch.presenceFieldName ?? group.presenceFieldName }
      : {})
  };
}

export function applyGenericTemplateSectionRules(
  sections: TemplateSectionConfig[],
  rulePackConfig?: TemplateRulePackConfig
): TemplateSectionConfig[] {
  return sections.map((section) => {
    const cloned = cloneSection(section);
    const shouldEnrichFieldBlock = cloned.behavior?.kind === "field_block";
    const shouldEnrichGroupedFieldBlock = cloned.behavior?.kind === "grouped_field_block";

    return {
      ...cloned,
      behavior:
        shouldEnrichFieldBlock || shouldEnrichGroupedFieldBlock
          ? enrichBehaviorWithRulePack(cloned.behavior, cloned.title, rulePackConfig)
          : cloned.behavior
          ? JSON.parse(JSON.stringify(cloned.behavior))
          : undefined
    };
  });
}

function enrichBehaviorWithRulePack(
  behavior: TemplateSectionBehaviorConfig | undefined,
  sectionTitle: string,
  rulePackConfig?: TemplateRulePackConfig
): TemplateSectionBehaviorConfig | undefined {
  if (!behavior) {
    return undefined;
  }

  switch (behavior.kind) {
    case "field_block": {
      const entry = resolveBuiltInSectionEnrichPackEntry(sectionTitle, behavior.kind, rulePackConfig);
      const fieldPatches = toFieldPatchMap(entry?.fieldPatches);
      return {
        ...behavior,
        sourceAliases: mergeAliases(behavior.sourceAliases, entry?.sourceAliases) ?? [],
        fields: behavior.fields.map((field) => enrichFieldDefinition(field, fieldPatches))
      };
    }
    case "grouped_field_block": {
      const entry = resolveBuiltInSectionEnrichPackEntry(sectionTitle, behavior.kind, rulePackConfig);
      const groupPatches = toGroupPatchMap(entry?.groupPatches);
      const fieldPatches = toFieldPatchMap(entry?.fieldPatches);
      return {
        ...behavior,
        sourceAliases: mergeAliases(behavior.sourceAliases, entry?.sourceAliases) ?? [],
        groups: behavior.groups.map((group) => enrichGroupDefinition(group, groupPatches)),
        fields: behavior.fields.map((field) => enrichFieldDefinition(field, fieldPatches))
      };
    }
    case "repeatable_text":
    case "task_list":
    case "table_block":
    case "mixed_field_block":
      return JSON.parse(JSON.stringify(behavior)) as TemplateSectionBehaviorConfig;
  }
}
