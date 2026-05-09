import type {
  TemplateFieldConfig,
  TemplateSectionConfig,
  TemplateSectionMixedFieldBlockBehaviorConfig
} from "../types/template";
import type { FieldStructureDescriptor } from "../types/template-structure-descriptor";
import {
  isTemplateFieldContext,
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import { fieldStructureDescriptorToConfig } from "./template-structure-descriptor-service";
import { scoreFieldLinkCandidate, uniqueFieldLinkLabels, normalizeLooseCompareValue } from "../utils/field-link-heuristics";

interface ApplyLinkedFieldConfigOptions {
  mergeAliases?: boolean;
  mergeSemanticTriggers?: boolean;
  syncEnabledState?: boolean;
}

const DEFAULT_OPTIONS: Required<ApplyLinkedFieldConfigOptions> = {
  mergeAliases: false,
  mergeSemanticTriggers: false,
  syncEnabledState: true
};

const MIN_MIXED_SECTION_LINK_SCORE = 8;

type TemplateFieldLinkInput = TemplateFieldContext | TemplateFieldConfig[] | FieldStructureDescriptor[];

function isFieldStructureDescriptor(value: TemplateFieldConfig | FieldStructureDescriptor): value is FieldStructureDescriptor {
  return "fieldName" in value && "features" in value && "evidence" in value;
}

function resolveLinkFields(fields: TemplateFieldLinkInput): TemplateFieldConfig[] {
  if (Array.isArray(fields) && fields.every(isFieldStructureDescriptor)) {
    return fields.map(fieldStructureDescriptorToConfig);
  }

  return isTemplateFieldContext(fields) ? resolveTemplateFieldContextFields(fields) : fields;
}

function addLink(adjacency: Map<string, Set<string>>, left: string, right: string): void {
  if (!left.trim() || !right.trim() || left === right) {
    return;
  }

  adjacency.get(left)?.add(right);
  adjacency.get(right)?.add(left);
}

function buildNameTokenMap(fields: TemplateFieldConfig[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  fields.forEach((field) => {
    const token = normalizeLooseCompareValue(field.name);
    if (!token) {
      return;
    }

    const existing = result.get(token) ?? [];
    existing.push(field.name);
    result.set(token, existing);
  });
  return result;
}

function collectAliasDrivenLinks(
  fields: TemplateFieldConfig[],
  adjacency: Map<string, Set<string>>
): void {
  const fieldNameTokenMap = buildNameTokenMap(fields);

  fields.forEach((field) => {
    const linkedTokens = uniqueFieldLinkLabels([
      ...field.aliases,
      ...(field.semanticTriggers ?? [])
    ])
      .map(normalizeLooseCompareValue)
      .filter(Boolean);

    linkedTokens.forEach((token) => {
      (fieldNameTokenMap.get(token) ?? []).forEach((targetFieldName) => {
        addLink(adjacency, field.name, targetFieldName);
      });
    });
  });
}

function buildMixedVisibleCandidates(
  behavior: TemplateSectionMixedFieldBlockBehaviorConfig,
  knownFieldNames: Set<string>
): Array<{ fieldName: string; labels: string[] }> {
  return behavior.items
    .flatMap((item) => {
      if (item.kind !== "text_field" && item.kind !== "checkbox_enum" && item.kind !== "task_list") {
        return [];
      }

      const fieldName = (item.targetFieldName ?? item.label).trim();
      if (!fieldName || !knownFieldNames.has(fieldName)) {
        return [];
      }

      return [
        {
          fieldName,
          labels: uniqueFieldLinkLabels([item.label, item.targetFieldName ?? "", ...(item.aliases ?? [])])
        }
      ];
    });
}

function collectMixedSectionLinks(
  fields: TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  adjacency: Map<string, Set<string>>
): void {
  if (!sectionConfig || sectionConfig.length === 0) {
    return;
  }

  const knownFieldNames = new Set(fields.map((field) => field.name.trim()).filter(Boolean));
  sectionConfig
    .filter((section) => section.mode === "generate" && section.behavior?.kind === "mixed_field_block")
    .forEach((section) => {
      const behavior = section.behavior as TemplateSectionMixedFieldBlockBehaviorConfig;
      const visibleCandidates = buildMixedVisibleCandidates(behavior, knownFieldNames);
      if (visibleCandidates.length === 0) {
        return;
      }

      behavior.items.forEach((item) => {
        if (item.kind !== "inline_field_group") {
          return;
        }

        item.fields.forEach((field) => {
          if (!knownFieldNames.has(field.fieldName)) {
            return;
          }

          const bestMatch = visibleCandidates
            .map((candidate) => ({
              fieldName: candidate.fieldName,
              score: scoreFieldLinkCandidate(field.fieldName, candidate.labels)
            }))
            .filter((candidate) => candidate.score >= MIN_MIXED_SECTION_LINK_SCORE)
            .sort((left, right) => {
              if (left.score !== right.score) {
                return right.score - left.score;
              }

              return left.fieldName.length - right.fieldName.length;
            })[0];

          if (!bestMatch) {
            return;
          }

          addLink(adjacency, field.fieldName, bestMatch.fieldName);
        });
      });
    });
}

function resolveLinkedFieldGroups(
  fields: TemplateFieldConfig[],
  sectionConfig: TemplateSectionConfig[] | undefined,
  options?: {
    includeAliasDrivenLinks?: boolean;
  }
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  fields.forEach((field) => adjacency.set(field.name, new Set<string>()));

  if (options?.includeAliasDrivenLinks ?? true) {
    collectAliasDrivenLinks(fields, adjacency);
  }
  collectMixedSectionLinks(fields, sectionConfig, adjacency);

  const visited = new Set<string>();
  const groups: string[][] = [];

  fields.forEach((field) => {
    if (visited.has(field.name)) {
      return;
    }

    const stack = [field.name];
    const group: string[] = [];
    visited.add(field.name);

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      group.push(current);
      (adjacency.get(current) ?? new Set<string>()).forEach((neighbor) => {
        if (visited.has(neighbor)) {
          return;
        }

        visited.add(neighbor);
        stack.push(neighbor);
      });
    }

    if (group.length > 1) {
      groups.push(group);
    }
  });

  return groups;
}

export function applyLinkedFieldEnabledState(
  fields: TemplateFieldLinkInput,
  sectionConfig: TemplateSectionConfig[] | undefined,
  fieldName: string,
  enabledByDefault: boolean
): TemplateFieldConfig[] {
  const nextFields = resolveLinkFields(fields);
  const linkedGroups = resolveLinkedFieldGroups(nextFields, sectionConfig, {
    includeAliasDrivenLinks: false
  });
  const linkedGroup = linkedGroups.find((group) => group.includes(fieldName));
  const targetFieldNames = new Set(linkedGroup ?? [fieldName]);

  return nextFields.map((field) =>
    targetFieldNames.has(field.name)
      ? {
          ...field,
          enabledByDefault
        }
      : field
  );
}

function mergeAliasesForField(
  field: TemplateFieldConfig,
  groupFields: TemplateFieldConfig[]
): string[] {
  return uniqueFieldLinkLabels([
    ...field.aliases,
    ...groupFields.flatMap((item) => item.aliases),
    ...groupFields.map((item) => item.name)
  ]).filter((alias) => alias !== field.name);
}

function mergeSemanticTriggersForField(
  field: TemplateFieldConfig,
  groupFields: TemplateFieldConfig[]
): string[] {
  return uniqueFieldLinkLabels([
    ...(field.semanticTriggers ?? []),
    ...groupFields.flatMap((item) => item.semanticTriggers ?? [])
  ]).filter((trigger) => trigger !== field.name);
}

export function applyLinkedFieldConfig(
  fields: TemplateFieldLinkInput,
  sectionConfig: TemplateSectionConfig[] | undefined,
  options?: ApplyLinkedFieldConfigOptions
): TemplateFieldConfig[] {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...(options ?? {})
  };
  const nextFields = resolveLinkFields(fields);
  const fieldMap = new Map(nextFields.map((field) => [field.name, field] as const));
  const linkedGroups = resolveLinkedFieldGroups(nextFields, sectionConfig);
  const enabledSyncGroups = resolveLinkedFieldGroups(nextFields, sectionConfig, {
    includeAliasDrivenLinks: false
  });
  const enabledSyncGroupMap = new Map<string, string[]>();
  enabledSyncGroups.forEach((group) => {
    group.forEach((fieldName) => enabledSyncGroupMap.set(fieldName, group));
  });

  linkedGroups.forEach((groupFieldNames) => {
    const groupFields = groupFieldNames
      .map((fieldName) => fieldMap.get(fieldName))
      .filter((field): field is TemplateFieldConfig => Boolean(field));
    if (groupFields.length < 2) {
      return;
    }

    groupFields.forEach((field) => {
      if (resolvedOptions.syncEnabledState) {
        const enabledSyncFields = (enabledSyncGroupMap.get(field.name) ?? [field.name])
          .map((fieldName) => fieldMap.get(fieldName))
          .filter((entry): entry is TemplateFieldConfig => Boolean(entry));
        field.enabledByDefault = enabledSyncFields.every((entry) => entry.enabledByDefault);
      }

      if (resolvedOptions.mergeAliases) {
        field.aliases = mergeAliasesForField(field, groupFields);
      }

      if (resolvedOptions.mergeSemanticTriggers) {
        field.semanticTriggers = mergeSemanticTriggersForField(field, groupFields);
      }
    });
  });

  return nextFields;
}
